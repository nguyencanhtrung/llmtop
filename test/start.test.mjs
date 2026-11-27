import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canUseSystemdUser,
  isPidAlive,
  serverLogPath,
  serverStatePath,
  startBackgroundServer,
  stopRunningServers,
} from "../src/process.mjs";
import { makeHome } from "./fixtures/home.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "llmtop.mjs"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

test("llmtop start --port 0 starts in background, rejects duplicate start, and stops via llmtop stop", async () => {
  const home = makeHome();
  const env = { LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg"), LLMTOP_NO_SYSTEMD: "1" };

  try {
    const started = await runCli(["start", "--port", "0"], env);
    assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(readFileSync(join(home.data, "serve.json"), "utf8"));
    assert.ok(Number.isInteger(state.pid) && state.pid > 0);
    assert.ok(Number.isInteger(state.port) && state.port > 0);
    assert.equal(isPidAlive(state.pid), true);
    assert.match(started.stdout, new RegExp(`http://localhost:${state.port} in the background \\(pid ${state.pid}`));
    assert.equal(existsSync(join(home.data, "serve.log")), true);

    const progress = await fetch(`http://127.0.0.1:${state.port}/api/scan/progress`);
    assert.equal(progress.status, 200);
    assert.equal(await progress.json(), null);

    const duplicate = await runCli(["start", "--port", "0"], env);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running/);

    const stopped = await runCli(["stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, new RegExp(`stopped llmtop serve \\(pid ${state.pid}, port ${state.port}\\)`));
    assert.equal(isPidAlive(state.pid), false);
    assert.equal(existsSync(join(home.data, "serve.json")), false);
  } finally {
    await stopRunningServers({ data: home.data }, { root: home.dir });
  }
});

test("llmtop serve --daemon --port 0 starts in background and stops cleanly", async () => {
  const home = makeHome();
  const env = { LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg"), LLMTOP_NO_SYSTEMD: "1" };

  try {
    const started = await runCli(["serve", "--daemon", "--port", "0"], env);
    assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(readFileSync(join(home.data, "serve.json"), "utf8"));
    assert.equal(isPidAlive(state.pid), true);
    assert.match(started.stdout, /in the background/);

    const stopped = await runCli(["stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(isPidAlive(state.pid), false);
  } finally {
    await stopRunningServers({ data: home.data }, { root: home.dir });
  }
});

test("llmtop start replaces stale serve.json and reports busy ports cleanly", async () => {
  const home = makeHome();
  const env = { LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg"), LLMTOP_NO_SYSTEMD: "1" };
  mkdirSync(home.data, { recursive: true });
  writeFileSync(serverStatePath({ data: home.data }), JSON.stringify({ pid: 999999, port: 4310 }));

  const blocker = createServer((_req, res) => res.end("busy"));
  await new Promise((resolveListen) => blocker.listen(0, "127.0.0.1", resolveListen));
  const busyPort = blocker.address().port;

  try {
    const busy = await runCli(["start", "--port", String(busyPort)], env);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, new RegExp(`port ${busyPort} is in use`));
    assert.equal(existsSync(serverStatePath({ data: home.data })), false);

    writeFileSync(serverStatePath({ data: home.data }), JSON.stringify({ pid: 999999, port: 4310 }));
    const started = await runCli(["start", "--port", "0"], env);
    assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(readFileSync(serverStatePath({ data: home.data }), "utf8"));
    assert.notEqual(state.pid, 999999);
    assert.equal(isPidAlive(state.pid), true);
  } finally {
    blocker.close();
    await stopRunningServers({ data: home.data }, { root: home.dir });
  }
});

test("canUseSystemdUser checks systemd-run and systemctl --user show-environment", () => {
  assert.equal(canUseSystemdUser({ platform: "darwin" }), false);
  assert.equal(canUseSystemdUser({ platform: "linux", env: { LLMTOP_NO_SYSTEMD: "1" } }), false);
  assert.equal(
    canUseSystemdUser({
      platform: "linux",
      env: {},
      spawn: (cmd) => ({ status: cmd === "systemd-run" || cmd === "systemctl" ? 0 : 1 }),
    }),
    true,
  );
  assert.equal(
    canUseSystemdUser({
      platform: "linux",
      env: {},
      spawn: (cmd) => ({ status: cmd === "systemd-run" ? 0 : 1 }),
    }),
    false,
  );
});

test("startBackgroundServer uses systemd-run --user when available and falls back to detached spawn on failure", async () => {
  const home = makeHome();
  const cfg = { data: home.data };
  const calls = [];
  let tokenFromSystemd = "";

  const okSystemd = await startBackgroundServer(cfg, {
    port: 4399,
    deps: {
      env: { HOME: home.dir, PATH: "/usr/bin", LLMTOP_CONFIG: home.config },
      canUseSystemd: () => true,
      listProcesses: () => [],
      spawnSync: (cmd, args) => {
        calls.push({ cmd, args });
        const tokenArg = args.find((a) => a.startsWith("--setenv=LLMTOP_DAEMON_TOKEN="));
        tokenFromSystemd = tokenArg.split("=")[2];
        writeFileSync(
          serverStatePath(cfg),
          JSON.stringify({ pid: 55555, port: 4399, token: tokenFromSystemd }),
        );
        return { status: 0, stdout: "", stderr: "" };
      },
      isAlive: (pid) => pid === 55555,
      sleep: async () => {},
    },
  });

  assert.equal(okSystemd.ok, true);
  assert.equal(okSystemd.mode, "systemd");
  assert.equal(okSystemd.pid, 55555);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "systemd-run");
  assert.ok(calls[0].args.includes("--user"));
  assert.ok(calls[0].args.includes("--collect"));
  assert.ok(calls[0].args.includes("--no-block"));
  assert.ok(calls[0].args.includes(`--property=StandardOutput=append:${serverLogPath(cfg)}`));
  assert.ok(calls[0].args.includes(`--setenv=LLMTOP_CONFIG=${home.config}`));
  assert.ok(calls[0].args.includes("--setenv=LLMTOP_DAEMON=1"));
  assert.deepEqual(calls[0].args.slice(-3), ["serve", "--port", "4399"]);

  // Clean up mocked state before testing fallback to detached spawn.
  writeFileSync(serverStatePath(cfg), JSON.stringify({ pid: 999999, port: 4399 }));
  let spawned = null;
  const fallback = await startBackgroundServer(cfg, {
    port: 4400,
    deps: {
      env: { HOME: home.dir, PATH: "/usr/bin" },
      canUseSystemd: () => true,
      listProcesses: () => [],
      spawnSync: () => ({ status: 1, stdout: "", stderr: "Failed to connect to user scope bus" }),
      spawn: (cmd, args, opts) => {
        spawned = { cmd, args, opts };
        writeFileSync(
          serverStatePath(cfg),
          JSON.stringify({ pid: 66666, port: 4400, token: opts.env.LLMTOP_DAEMON_TOKEN }),
        );
        return { exitCode: null, unref() {} };
      },
      isAlive: (pid) => pid === 66666,
      sleep: async () => {},
    },
  });

  assert.equal(fallback.ok, true);
  assert.equal(fallback.mode, "detached");
  assert.equal(fallback.pid, 66666);
  assert.equal(spawned.opts.detached, true);
  assert.equal(spawned.opts.env.LLMTOP_DAEMON, "1");
  assert.deepEqual(spawned.args.slice(-3), ["serve", "--port", "4400"]);
});
