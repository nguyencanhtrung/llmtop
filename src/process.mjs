import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultConfigDir, ROOT } from "./config.mjs";

export function serverStatePath(config) {
  return join(config.data, "serve.json");
}

export function serverLogPath(config) {
  return join(config.data, "serve.log");
}

// Writes serve.json atomically and returns a cleanup callback that removes it only if the PID still matches.
export function writeServerState(config, { pid = process.pid, port, version, token, daemon = false }) {
  const path = serverStatePath(config);
  mkdirSync(config.data, { recursive: true });
  const tmp = join(config.data, `.serve.${pid}.${process.hrtime.bigint()}.tmp`);
  const body = { pid, port, startedAt: new Date().toISOString(), version, daemon: Boolean(daemon) };
  if (token !== undefined) body.token = token;
  const payload = JSON.stringify(body, null, 2);
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

function readProcEnv(pid, readFile = readFileSync) {
  try {
    const raw = readFile(`/proc/${pid}/environ`, "utf8");
    const env = {};
    for (const entry of raw.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return env;
  } catch {
    return null;
  }
}

function belongsToConfig(pid, config, env, readFile) {
  const procEnv = readProcEnv(pid, readFile);
  if (!procEnv) return true;
  if (procEnv.LLMTOP_DATA && resolve(procEnv.LLMTOP_DATA) !== resolve(config.data)) return false;
  if (procEnv.LLMTOP_CONFIG && config.configPath && resolve(procEnv.LLMTOP_CONFIG) !== resolve(config.configPath)) return false;
  if (procEnv.XDG_CONFIG_HOME !== env.XDG_CONFIG_HOME) return false;
  return true;
}

export function findRunningServers(config, deps = {}) {
  const {
    listProcesses,
    isAlive = isPidAlive,
    selfPid = process.pid,
    root = ROOT,
    env = process.env,
    exists = existsSync,
    readFile = readFileSync,
  } = deps;
  const defaultDataDir = resolve(join(defaultConfigDir(env), "data"));
  const isDefaultData = resolve(config.data) === defaultDataDir;
  const isRepoData = resolve(config.data) === resolve(join(root, "data"));
  const scanProcesses = deps.includeProcessScan ?? (Boolean(listProcesses) || isDefaultData);
  const osList = (listProcesses ?? listOsProcesses)();
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
          byPid.set(state.pid, { pid: state.pid, port: state.port ?? null, source: "state", daemon: Boolean(state.daemon) });
        } else {
          staleState = true;
        }
      }
    } else {
      staleState = true;
    }
  }

  const pidFile = join(root, "data", "serve.pid");
  if (isRepoData && exists(pidFile)) {
    try {
      const pid = Number(readFile(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== selfPid && isAlive(pid)) {
        const osEntry = osByPid.get(pid);
        if (osEntry && isLlmtopServeCommand(osEntry.command)) {
          const existing = byPid.get(pid);
          if (existing) existing.pidFile = pidFile;
          else byPid.set(pid, { pid, port: parsePortFromCommand(osEntry.command), source: "pidfile", pidFile, daemon: false });
        }
      }
    } catch {
      // Ignore unreadable legacy pidfile.
    }
  }

  if (scanProcesses) {
    for (const proc of osList) {
      if (proc.pid === selfPid || byPid.has(proc.pid) || !isLlmtopServeCommand(proc.command)) continue;
      if (!listProcesses && !belongsToConfig(proc.pid, config, env, readFile)) continue;
      byPid.set(proc.pid, { pid: proc.pid, port: parsePortFromCommand(proc.command), source: "process", daemon: false });
    }
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

const FORWARDED_DAEMON_ENV = [
  "HOME",
  "PATH",
  "USER",
  "TZ",
  "XDG_CONFIG_HOME",
  "LLMTOP_CONFIG",
  "LLMTOP_DATA",
  "NODE_OPTIONS",
];

export function canUseSystemdUser({ platform = process.platform, spawn: spawnCmd = spawnSync, env = process.env } = {}) {
  if (platform !== "linux" || env.LLMTOP_NO_SYSTEMD === "1") return false;
  try {
    const version = spawnCmd("systemd-run", ["--version"], { encoding: "utf8", stdio: "pipe" });
    if (version.status !== 0) return false;
    const mgr = spawnCmd("systemctl", ["--user", "show-environment"], { encoding: "utf8", stdio: "pipe" });
    return mgr.status === 0;
  } catch {
    return false;
  }
}

function readAppendedLog(logPath, startOffset, exists, readFile) {
  if (!exists(logPath)) return "";
  try {
    const buf = readFile(logPath);
    return buf.subarray(startOffset).toString("utf8").trim();
  } catch {
    return "";
  }
}

export async function startBackgroundServer(config, { port, deps = {} } = {}) {
  const {
    env = process.env,
    platform = process.platform,
    root = ROOT,
    binPath = join(ROOT, "bin", "llmtop.mjs"),
    execPath = process.execPath,
    spawn: spawnChild = spawn,
    spawnSync: spawnCmd = spawnSync,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 5000,
    isAlive = isPidAlive,
    exists = existsSync,
    readFile = readFileSync,
    stat = statSync,
    mkdir = mkdirSync,
    unlink = unlinkSync,
    open = openSync,
    close = closeSync,
    canUseSystemd = canUseSystemdUser,
  } = deps;

  const { servers, staleState } = findRunningServers(config, { ...deps, root, isAlive, exists, readFile });
  if (servers.length > 0) {
    return { ok: false, alreadyRunning: true, server: servers[0] };
  }
  if (staleState) {
    try {
      unlink(serverStatePath(config));
    } catch {
      // Ignore already-deleted stale state file.
    }
  }

  mkdir(config.data, { recursive: true });
  const logPath = serverLogPath(config);
  const startOffset = exists(logPath) ? stat(logPath).size : 0;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const childArgs = [binPath, "serve", ...(port !== undefined ? ["--port", String(port)] : [])];

  let mode = null;
  let unit = null;
  let child = null;

  if (canUseSystemd({ platform, spawn: spawnCmd, env })) {
    unit = `llmtop-serve-${Date.now()}-${process.pid}`;
    const setenvArgs = [];
    for (const key of FORWARDED_DAEMON_ENV) {
      if (env[key] !== undefined) setenvArgs.push(`--setenv=${key}=${env[key]}`);
    }
    setenvArgs.push("--setenv=LLMTOP_DAEMON=1", `--setenv=LLMTOP_DAEMON_TOKEN=${token}`);
    const systemdArgs = [
      "--user",
      "--collect",
      "--no-block",
      `--unit=${unit}`,
      "--description=llmtop local dashboard",
      `--property=WorkingDirectory=${config.data}`,
      `--property=StandardOutput=append:${logPath}`,
      `--property=StandardError=append:${logPath}`,
      ...setenvArgs,
      execPath,
      ...childArgs,
    ];
    const res = spawnCmd("systemd-run", systemdArgs, { encoding: "utf8", stdio: "pipe" });
    if (res.status === 0) mode = "systemd";
    else unit = null;
  }

  if (!mode) {
    const logFd = open(logPath, "a");
    try {
      child = spawnChild(execPath, childArgs, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...env, LLMTOP_DAEMON: "1", LLMTOP_DAEMON_TOKEN: token },
      });
    } finally {
      close(logFd);
    }
    child.unref();
    mode = "detached";
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readServerState(config, { exists, readFile });
    if (state && state.token === token && isAlive(state.pid)) {
      return { ok: true, pid: state.pid, port: state.port, logPath, mode, unit };
    }
    if (mode === "detached" && child?.exitCode !== null) break;
    if (mode === "systemd") {
      const appended = readAppendedLog(logPath, startOffset, exists, readFile);
      if (/^error:/m.test(appended)) break;
    }
    await sleep(50);
  }

  const appended = readAppendedLog(logPath, startOffset, exists, readFile);
  return {
    ok: false,
    error: appended || "timed out waiting for llmtop serve to start",
    logPath,
  };
}

export async function startCommand({ config, options = {}, out, err = process.stderr, deps = {} }) {
  const res = await startBackgroundServer(config, { port: options.port, deps });
  if (res.alreadyRunning) {
    const where = res.server.port ? `, http://localhost:${res.server.port}` : "";
    err.write(`llmtop serve is already running (pid ${res.server.pid}${where}); run \`llmtop stop\` first\n`);
    return 1;
  }
  if (!res.ok) {
    err.write(`${res.error}\n`);
    return 1;
  }
  out.write(`dashboard at http://localhost:${res.port} in the background (pid ${res.pid}, log ${res.logPath}); run \`llmtop stop\` to stop\n`);
  return 0;
}
