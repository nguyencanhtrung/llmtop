import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { findRunningServers, isLlmtopServeCommand, isPidAlive, serverStatePath } from "../src/process.mjs";
import { collectDataTargets, uninstallCommand } from "../src/uninstall.mjs";
import { makeHome } from "./fixtures/home.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args, env) {
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

function bufferStream(isTTY = false) {
  let text = "";
  return {
    isTTY,
    write(chunk) {
      text += String(chunk);
    },
    toString() {
      return text;
    },
  };
}

async function startTempServe(home) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "llmtop.mjs"), "serve", "--port", "0"], {
    env: { ...process.env, LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`serve exited early (${child.exitCode}): ${errors}`);
    }
    if (output.includes("dashboard at") && existsSync(join(home.data, "serve.json"))) {
      return child;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  child.kill("SIGKILL");
  throw new Error(`timed out waiting for serve to start: ${output} ${errors}`);
}

async function waitChildExit(child, timeoutMs = 4000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("child process did not exit in time")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

test("isLlmtopServeCommand matches llmtop serve processes and rejects wrappers or other subcommands", () => {
  assert.equal(isLlmtopServeCommand("node /usr/local/bin/llmtop serve --port 4310"), true);
  assert.equal(isLlmtopServeCommand("node /path/to/bin/llmtop.mjs serve --port 0"), true);
  assert.equal(isLlmtopServeCommand("llmtop serve"), true);
  assert.equal(isLlmtopServeCommand("sh -c node /path/llmtop.mjs serve"), false);
  assert.equal(isLlmtopServeCommand("grep llmtop serve"), false);
  assert.equal(isLlmtopServeCommand("node /path/to/bin/llmtop.mjs uninstall --yes"), false);
  assert.equal(isLlmtopServeCommand("node /path/to/bin/llmtop.mjs update"), false);
});

test("llmtop serve writes serve.json and llmtop stop stops the running process cleanly", async () => {
  const home = makeHome();
  let child;
  try {
    child = await startTempServe(home);
    const state = JSON.parse(readFileSync(join(home.data, "serve.json"), "utf8"));
    assert.equal(state.pid, child.pid);
    assert.ok(Number.isInteger(state.port) && state.port > 0);
    assert.equal(isPidAlive(child.pid), true);

    const stopRes = await runCli(["stop"], { LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg") });
    assert.equal(stopRes.status, 0);
    assert.match(stopRes.stdout, new RegExp(`stopped llmtop serve \\(pid ${child.pid}, port ${state.port}\\)`));
    await waitChildExit(child);
    assert.equal(isPidAlive(child.pid), false);
    assert.equal(existsSync(join(home.data, "serve.json")), false);

    const secondStop = await runCli(["stop"], { LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg") });
    assert.equal(secondStop.status, 0);
    assert.match(secondStop.stdout, /not running/);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
});

test("findRunningServers ignores stale serve.json for dead PIDs", () => {
  const home = makeHome();
  mkdirSync(home.data, { recursive: true });
  writeFileSync(serverStatePath({ data: home.data }), JSON.stringify({ pid: 999999, port: 4310 }));
  const found = findRunningServers(
    { data: home.data },
    { listProcesses: () => [], isAlive: () => false, root: home.dir },
  );
  assert.deepEqual(found.servers, []);
  assert.equal(found.staleState, true);
});

test("uninstallCommand --dry-run and non-TTY without --yes make no changes", async () => {
  const home = makeHome();
  mkdirSync(home.data, { recursive: true });
  writeFileSync(join(home.data, "usage.db"), "stub");
  const cfg = loadConfig(home.config);
  const env = { XDG_CONFIG_HOME: join(home.dir, "xdg") };
  let child;

  try {
    child = await startTempServe(home);
    const pmCalls = [];
    const dryOut = bufferStream(false);
    const dryCode = await uninstallCommand({
      config: cfg,
      options: { "dry-run": true },
      out: dryOut,
      err: bufferStream(false),
      deps: {
        env,
        home: home.dir,
        detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
        runPackageManager: (...args) => pmCalls.push(args),
      },
    });
    assert.equal(dryCode, 0);
    assert.match(dryOut.toString(), new RegExp(`pid ${child.pid}`));
    assert.match(dryOut.toString(), /npm uninstall -g llmtop/);
    assert.match(dryOut.toString(), /dry run: no changes made/);
    assert.deepEqual(pmCalls, []);
    assert.equal(isPidAlive(child.pid), true);
    assert.equal(existsSync(join(home.data, "usage.db")), true);

    const nonTtyErr = bufferStream(false);
    const nonTtyCode = await uninstallCommand({
      config: cfg,
      options: {},
      out: bufferStream(false),
      err: nonTtyErr,
      deps: {
        env,
        home: home.dir,
        isTTY: false,
        detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
        runPackageManager: (...args) => pmCalls.push(args),
      },
    });
    assert.equal(nonTtyCode, 1);
    assert.match(nonTtyErr.toString(), /pass --yes/);
    assert.deepEqual(pmCalls, []);
    assert.equal(isPidAlive(child.pid), true);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
});

test("uninstallCommand interactive prompts handle abort, keep data, and purge while preserving transcripts", async () => {
  const home = makeHome();
  mkdirSync(home.data, { recursive: true });
  writeFileSync(join(home.data, "usage.db"), "stub");
  writeFileSync(join(home.transcripts, "keep-me.jsonl"), "{}\n");
  const cfg = loadConfig(home.config);
  const env = { XDG_CONFIG_HOME: join(home.dir, "xdg") };

  const abortOut = bufferStream(true);
  const abortCode = await uninstallCommand({
    config: cfg,
    options: {},
    out: abortOut,
    err: bufferStream(true),
    deps: {
      env,
      home: home.dir,
      isTTY: true,
      detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      confirm: async () => false,
    },
  });
  assert.equal(abortCode, 0);
  assert.match(abortOut.toString(), /aborted/);
  assert.equal(existsSync(home.config), true);

  const answersKeep = [true, false];
  const pmCalls = [];
  const keepOut = bufferStream(true);
  const keepCode = await uninstallCommand({
    config: cfg,
    options: {},
    out: keepOut,
    err: bufferStream(true),
    deps: {
      env,
      home: home.dir,
      isTTY: true,
      detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      confirm: async () => answersKeep.shift(),
      runPackageManager: (pm, action, spec) => {
        pmCalls.push([pm, action, spec]);
        return { ok: true, code: 0, stdout: "", stderr: "", error: "", command: "npm uninstall -g llmtop", permissionDenied: false };
      },
    },
  });
  assert.equal(keepCode, 0);
  assert.deepEqual(pmCalls, [["npm", "uninstall", "llmtop"]]);
  assert.equal(existsSync(join(home.data, "usage.db")), true);
  assert.equal(existsSync(home.config), true);
  assert.match(keepOut.toString(), /kept local data/);

  let child;
  try {
    child = await startTempServe(home);
    const answersPurge = [true, true];
    const purgeOut = bufferStream(true);
    const purgeCode = await uninstallCommand({
      config: cfg,
      options: {},
      out: purgeOut,
      err: bufferStream(true),
      deps: {
        env,
        home: home.dir,
        isTTY: true,
        detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
        confirm: async () => answersPurge.shift(),
        runPackageManager: () => ({ ok: true, code: 0, stdout: "", stderr: "", error: "", command: "npm uninstall -g llmtop", permissionDenied: false }),
      },
    });
    assert.equal(purgeCode, 0);
    await waitChildExit(child);
    assert.equal(isPidAlive(child.pid), false);
    assert.equal(existsSync(home.data), false);
    assert.equal(existsSync(home.config), false);
    assert.equal(existsSync(join(home.transcripts, "keep-me.jsonl")), true);
    assert.match(purgeOut.toString(), /removed local data/);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
});

test("uninstallCommand --yes --purge removes default ~/.config/llmtop directory without deleting transcripts or local git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-xdg-purge-"));
  const xdgHome = join(dir, "xdg");
  const defaultDir = join(xdgHome, "llmtop");
  const defaultData = join(defaultDir, "data");
  const transcripts = join(dir, ".claude", "projects");
  mkdirSync(defaultData, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(defaultDir, "config.json"), JSON.stringify({ providers: { claude: { transcripts } } }));
  writeFileSync(join(defaultData, "usage.db"), "stub");
  writeFileSync(join(transcripts, "session.jsonl"), "{}\n");

  const env = { XDG_CONFIG_HOME: xdgHome };
  const cfg = loadConfig(undefined, env);
  assert.deepEqual(collectDataTargets(cfg, { env, home: dir }), [defaultDir]);

  const out = bufferStream(false);
  const code = await uninstallCommand({
    config: cfg,
    options: { yes: true, purge: true },
    out,
    err: bufferStream(false),
    deps: {
      env,
      home: dir,
      detectInstallMode: () => ({ mode: "local", packageManager: null, root: "/tmp/local-llmtop-repo" }),
      hasGlobalPackage: () => false,
    },
  });
  assert.equal(code, 0);
  assert.equal(existsSync(defaultDir), false);
  assert.equal(existsSync(join(transcripts, "session.jsonl")), true);
  assert.match(out.toString(), /kept local checkout at \/tmp\/local-llmtop-repo/);
});

test("uninstallCommand skips purging local data when package uninstall fails with EACCES", async () => {
  const home = makeHome();
  mkdirSync(home.data, { recursive: true });
  writeFileSync(join(home.data, "usage.db"), "stub");
  const cfg = loadConfig(home.config);
  const err = bufferStream(false);

  const code = await uninstallCommand({
    config: cfg,
    options: { yes: true, purge: true },
    out: bufferStream(false),
    err,
    deps: {
      env: { XDG_CONFIG_HOME: join(home.dir, "xdg") },
      home: home.dir,
      detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      runPackageManager: () => ({
        ok: false,
        code: 243,
        stdout: "",
        stderr: "EACCES",
        error: "",
        command: "npm uninstall -g llmtop",
        permissionDenied: true,
      }),
    },
  });
  assert.equal(code, 1);
  assert.match(err.toString(), /sudo npm uninstall -g llmtop/);
  assert.equal(existsSync(join(home.data, "usage.db")), true);
  assert.equal(existsSync(home.config), true);
});

test("corrupt config.json does not block llmtop uninstall --dry-run or llmtop stop", async () => {
  const home = makeHome();
  writeFileSync(home.config, "{corrupt json");
  const dry = await runCli(["uninstall", "--dry-run"], { LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg") });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /llmtop uninstall plan:/);

  const stop = await runCli(["stop"], { LLMTOP_CONFIG: home.config, XDG_CONFIG_HOME: join(home.dir, "xdg") });
  assert.equal(stop.status, 0);
  assert.match(stop.stdout, /not running/);
});
