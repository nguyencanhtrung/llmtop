import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";

export function serverStatePath(config) {
  return join(config.data, "serve.json");
}

// Writes serve.json atomically and returns a cleanup callback that removes it only if the PID still matches.
export function writeServerState(config, { pid = process.pid, port, version }) {
  const path = serverStatePath(config);
  mkdirSync(config.data, { recursive: true });
  const tmp = join(config.data, `.serve.${pid}.${process.hrtime.bigint()}.tmp`);
  const payload = JSON.stringify({ pid, port, startedAt: new Date().toISOString(), version }, null, 2);
  writeFileSync(tmp, `${payload}\n`);
  renameSync(tmp, path);
  return () => {
    try {
      const current = JSON.parse(readFileSync(path, "utf8"));
      if (current?.pid === pid) unlinkSync(path);
    } catch {
      // Missing or already replaced state file needs no cleanup.
    }
  };
}

export function readServerState(config, { exists = existsSync, readFile = readFileSync } = {}) {
  const path = serverStatePath(config);
  if (!exists(path)) return null;
  try {
    const parsed = JSON.parse(readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function isLlmtopServeCommand(command) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/^(?:\/[\w/.-]*\/)?(?:sh|bash|zsh|fish|grep|rg|awk|sed)\b/.test(trimmed)) return false;
  return /(?:^|[\s"'/\\])llmtop(?:\.mjs|\.cmd|\.ps1)?["']?\s+serve(?:\s|$)/.test(trimmed);
}

export function listOsProcesses({ spawn = spawnSync, platform = process.platform } = {}) {
  try {
    if (platform === "win32") {
      const res = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
        { encoding: "utf8", stdio: "pipe" },
      );
      if (res.status !== 0 || !res.stdout?.trim()) return [];
      const parsed = JSON.parse(res.stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter((item) => item && Number.isInteger(Number(item.ProcessId)) && Number(item.ProcessId) > 0)
        .map((item) => ({ pid: Number(item.ProcessId), command: String(item.CommandLine || "") }));
    }
    const res = spawn("ps", ["-eo", "pid=,args="], { encoding: "utf8", stdio: "pipe" });
    if (res.status !== 0 || !res.stdout) return [];
    const processes = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      processes.push({ pid: Number(match[1]), command: match[2].trim() });
    }
    return processes;
  } catch {
    return [];
  }
}

function parsePortFromCommand(command) {
  const match = command.match(/(?:^|\s)--port(?:=|\s+)(\d+)\b/);
  return match ? Number(match[1]) : null;
}

export function findRunningServers(config, deps = {}) {
  const {
    listProcesses = listOsProcesses,
    isAlive = isPidAlive,
    selfPid = process.pid,
    root = ROOT,
    exists = existsSync,
    readFile = readFileSync,
  } = deps;
  const osList = listProcesses();
  const osByPid = new Map(osList.map((p) => [p.pid, p]));
  const byPid = new Map();
  let staleState = false;

  const statePath = serverStatePath(config);
  if (exists(statePath)) {
    const state = readServerState(config, { exists, readFile });
    if (state && Number.isInteger(state.pid) && state.pid > 0) {
      if (state.pid !== selfPid) {
        const osEntry = osByPid.get(state.pid);
        const matchesOs = osList.length === 0 || (osEntry && isLlmtopServeCommand(osEntry.command));
        if (isAlive(state.pid) && matchesOs) {
          byPid.set(state.pid, { pid: state.pid, port: state.port ?? null, source: "state" });
        } else {
          staleState = true;
        }
      }
    } else {
      staleState = true;
    }
  }

  const pidFile = join(root, "data", "serve.pid");
  if (exists(pidFile)) {
    try {
      const pid = Number(readFile(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== selfPid && isAlive(pid)) {
        const osEntry = osByPid.get(pid);
        if (osEntry && isLlmtopServeCommand(osEntry.command)) {
          const existing = byPid.get(pid);
          if (existing) existing.pidFile = pidFile;
          else byPid.set(pid, { pid, port: parsePortFromCommand(osEntry.command), source: "pidfile", pidFile });
        }
      }
    } catch {
      // Ignore unreadable legacy pidfile.
    }
  }

  for (const proc of osList) {
    if (proc.pid === selfPid || byPid.has(proc.pid) || !isLlmtopServeCommand(proc.command)) continue;
    byPid.set(proc.pid, { pid: proc.pid, port: parsePortFromCommand(proc.command), source: "process" });
  }

  return { servers: [...byPid.values()].sort((a, b) => a.pid - b.pid), staleState };
}

async function waitForExit(pid, isAlive, sleep, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

export async function stopRunningServers(config, deps = {}) {
  const {
    kill = process.kill,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 3000,
    unlink = unlinkSync,
    isAlive = isPidAlive,
    exists = existsSync,
    readFile = readFileSync,
  } = deps;
  const { servers, staleState } = findRunningServers(config, { ...deps, isAlive, exists, readFile });
  const stopped = [];
  const failed = [];

  for (const server of servers) {
    try {
      kill(server.pid, "SIGTERM");
    } catch (err) {
      if (err?.code !== "ESRCH") {
        failed.push({ ...server, error: err?.message ?? String(err) });
        continue;
      }
    }
    let exited = await waitForExit(server.pid, isAlive, sleep, timeoutMs);
    if (!exited) {
      try {
        kill(server.pid, "SIGKILL");
      } catch (err) {
        if (err?.code !== "ESRCH") {
          failed.push({ ...server, error: err?.message ?? String(err) });
          continue;
        }
      }
      exited = await waitForExit(server.pid, isAlive, sleep, 500);
    }
    if (!exited && isAlive(server.pid)) {
      failed.push({ ...server, error: "process did not exit" });
      continue;
    }
    stopped.push(server);
    if (server.pidFile) {
      try {
        unlink(server.pidFile);
      } catch {
        // Ignore missing legacy pidfile.
      }
    }
  }

  let cleanedState = false;
  const statePath = serverStatePath(config);
  if (exists(statePath)) {
    const state = readServerState(config, { exists, readFile });
    if (!state || !Number.isInteger(state.pid) || !isAlive(state.pid) || staleState) {
      try {
        unlink(statePath);
        cleanedState = true;
      } catch {
        // Ignore already-deleted state file.
      }
    }
  }

  return { stopped, failed, cleanedState };
}

export async function stopCommand({ config, out, err = process.stderr, deps = {} }) {
  const { stopped, failed } = await stopRunningServers(config, deps);
  if (failed.length) {
    for (const f of failed) err.write(`error: could not stop llmtop serve (pid ${f.pid}): ${f.error}\n`);
    return 1;
  }
  if (!stopped.length) {
    out.write("llmtop serve is not running\n");
    return 0;
  }
  for (const s of stopped) {
    out.write(`stopped llmtop serve (pid ${s.pid}${s.port ? `, port ${s.port}` : ""})\n`);
  }
  return 0;
}
