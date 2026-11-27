import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectInstallMode } from "../src/install.mjs";
import { compareSemver, updateCommand } from "../src/update.mjs";
import { makeHome } from "./fixtures/home.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

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

test("compareSemver orders major, minor, patch, and prerelease versions", () => {
  assert.equal(compareSemver("0.1.2", "0.1.2"), 0);
  assert.equal(compareSemver("v0.1.2", "0.1.2+build.4"), 0);
  assert.equal(compareSemver("0.1.2", "0.1.3"), -1);
  assert.equal(compareSemver("0.2.0", "0.1.9"), 1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
  assert.equal(compareSemver("0.2.0-alpha.1", "0.2.0"), -1);
  assert.equal(compareSemver("0.2.0-alpha.1", "0.2.0-alpha.2"), -1);
  assert.equal(compareSemver("0.2.0-beta", "0.2.0-alpha.9"), 1);
  assert.throws(() => compareSemver("not-a-version", "0.1.0"), /invalid semver/);
});

test("detectInstallMode distinguishes global package managers, local git checkouts, and npx", () => {
  assert.deepEqual(detectInstallMode({ root: "/usr/local/lib/node_modules/llmtop", exists: () => false }), {
    mode: "global",
    packageManager: "npm",
    root: "/usr/local/lib/node_modules/llmtop",
  });
  assert.deepEqual(detectInstallMode({ root: "/home/u/.local/share/pnpm/global/5/node_modules/llmtop", exists: () => false }), {
    mode: "global",
    packageManager: "pnpm",
    root: "/home/u/.local/share/pnpm/global/5/node_modules/llmtop",
  });
  assert.deepEqual(detectInstallMode({ root: "/home/u/.config/yarn/global/node_modules/llmtop", exists: () => false }), {
    mode: "global",
    packageManager: "yarn",
    root: "/home/u/.config/yarn/global/node_modules/llmtop",
  });
  assert.deepEqual(detectInstallMode({ root: "/home/u/.bun/install/global/node_modules/llmtop", exists: () => false }), {
    mode: "global",
    packageManager: "bun",
    root: "/home/u/.bun/install/global/node_modules/llmtop",
  });
  assert.deepEqual(detectInstallMode({ root: "/home/u/.npm/_npx/1234/node_modules/llmtop", exists: () => false }), {
    mode: "npx",
    packageManager: "npm",
    root: "/home/u/.npm/_npx/1234/node_modules/llmtop",
  });
  assert.deepEqual(detectInstallMode({ root: "/home/u/workspace/llmtop", exists: (p) => p === "/home/u/workspace/llmtop/.git" }), {
    mode: "local",
    packageManager: null,
    root: "/home/u/workspace/llmtop",
  });
});

test("CLI update --check queries registry and local checkout refuses auto-upgrade without --force", async () => {
  let servedVersion = "9.9.9";
  const server = createServer((req, res) => {
    if (req.url === "/llmtop/latest") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: servedVersion }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const home = makeHome();

  try {
    const checkNew = await runCli(["update", "--check", "--json"], {
      LLMTOP_CONFIG: home.config,
      LLMTOP_REGISTRY: registry,
    });
    assert.equal(checkNew.status, 0);
    const parsed = JSON.parse(checkNew.stdout);
    assert.equal(parsed.current, CURRENT_VERSION);
    assert.equal(parsed.latest, "9.9.9");
    assert.equal(parsed.updateAvailable, true);
    assert.equal(parsed.installMode, "local");

    const localRefusal = await runCli(["update"], {
      LLMTOP_CONFIG: home.config,
      LLMTOP_REGISTRY: registry,
    });
    assert.equal(localRefusal.status, 1);
    assert.match(localRefusal.stderr, /local git checkout/);

    servedVersion = CURRENT_VERSION;
    const upToDate = await runCli(["update", "--check"], {
      LLMTOP_CONFIG: home.config,
      LLMTOP_REGISTRY: registry,
    });
    assert.equal(upToDate.status, 0);
    assert.match(upToDate.stdout, /up to date/);
  } finally {
    server.close();
  }
});

test("updateCommand upgrades global install and warns without stopping running server", async () => {
  const home = makeHome();
  const out = bufferStream();
  const err = bufferStream();
  const calls = [];
  const code = await updateCommand({
    config: { data: home.data },
    options: {},
    out,
    err,
    deps: {
      currentVersion: "0.1.2",
      detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      fetchLatestVersion: async () => "0.2.0",
      runPackageManager: (pm, action, spec) => {
        calls.push([pm, action, spec]);
        return { ok: true, code: 0, stdout: "", stderr: "", error: "", command: "npm install -g llmtop@0.2.0", permissionDenied: false };
      },
      findRunningServers: () => ({ servers: [{ pid: 4242, port: 4310, source: "state" }], staleState: false }),
    },
  });
  assert.equal(code, 0);
  assert.equal(err.toString(), "");
  assert.deepEqual(calls, [["npm", "install", "llmtop@0.2.0"]]);
  assert.match(out.toString(), /updated llmtop 0\.1\.2 -> 0\.2\.0/);
  assert.match(out.toString(), /llmtop serve is still running \(pid 4242 on port 4310\)/);
  assert.match(out.toString(), /llmtop stop/);
});

test("updateCommand reports permission errors with sudo hint and handles unreachable registry", async () => {
  const home = makeHome();
  const out = bufferStream();
  const err = bufferStream();
  const code = await updateCommand({
    config: { data: home.data },
    options: {},
    out,
    err,
    deps: {
      currentVersion: "0.1.2",
      detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      fetchLatestVersion: async () => "0.2.0",
      runPackageManager: () => ({
        ok: false,
        code: 243,
        stdout: "",
        stderr: "npm error code EACCES",
        error: "",
        command: "npm install -g llmtop@0.2.0",
        permissionDenied: true,
      }),
    },
  });
  assert.equal(code, 1);
  assert.match(err.toString(), /sudo npm install -g llmtop@0\.2\.0/);

  await assert.rejects(
    updateCommand({
      config: { data: home.data },
      options: { check: true },
      out: bufferStream(),
      err: bufferStream(),
      deps: {
        env: { LLMTOP_REGISTRY: "http://127.0.0.1:1" },
        detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      },
    }),
    /failed to reach npm registry/,
  );
});

test("updateCommand stops background daemon before upgrade and restarts it on the new version", async () => {
  const home = makeHome();
  const out = bufferStream();
  const err = bufferStream();
  const order = [];
  let restartedPort = null;

  const code = await updateCommand({
    config: { data: home.data },
    options: {},
    out,
    err,
    deps: {
      currentVersion: "0.1.3",
      detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      fetchLatestVersion: async () => "0.1.4",
      findRunningServers: () => ({ servers: [{ pid: 7777, port: 4310, source: "state", daemon: true }], staleState: false }),
      stopRunningServers: async () => {
        order.push("stop");
        return { stopped: [{ pid: 7777, port: 4310 }], failed: [], cleanedState: true };
      },
      runPackageManager: () => {
        order.push("install");
        return { ok: true, code: 0, stdout: "", stderr: "", error: "", command: "npm install -g llmtop@0.1.4", permissionDenied: false };
      },
      restartDaemon: ({ port }) => {
        order.push("restart");
        restartedPort = port;
        return { ok: true, stdout: "dashboard at http://localhost:4310 in the background (pid 8888)\n", stderr: "", error: "" };
      },
    },
  });

  assert.equal(code, 0);
  assert.equal(err.toString(), "");
  assert.deepEqual(order, ["stop", "install", "restart"]);
  assert.equal(restartedPort, 4310);
  assert.match(out.toString(), /stopped background llmtop serve before upgrade \(pid 7777\)/);
  assert.match(out.toString(), /updated llmtop 0\.1\.3 -> 0\.1\.4/);
  assert.match(out.toString(), /pid 8888/);
});

test("updateCommand restores stopped background daemon when package upgrade fails", async () => {
  const home = makeHome();
  const out = bufferStream();
  const err = bufferStream();
  const order = [];

  const code = await updateCommand({
    config: { data: home.data },
    options: {},
    out,
    err,
    deps: {
      currentVersion: "0.1.3",
      detectInstallMode: () => ({ mode: "global", packageManager: "npm", root: "/usr/lib/node_modules/llmtop" }),
      fetchLatestVersion: async () => "0.1.4",
      findRunningServers: () => ({ servers: [{ pid: 7777, port: 4310, source: "state", daemon: true }], staleState: false }),
      stopRunningServers: async () => {
        order.push("stop");
        return { stopped: [{ pid: 7777, port: 4310 }], failed: [], cleanedState: true };
      },
      runPackageManager: () => {
        order.push("install");
        return { ok: false, code: 1, stdout: "", stderr: "network error", error: "", command: "npm install -g llmtop@0.1.4", permissionDenied: false };
      },
      restartDaemon: () => {
        order.push("restart");
        return { ok: true, stdout: "dashboard at http://localhost:4310 in the background (pid 7778)\n", stderr: "", error: "" };
      },
    },
  });

  assert.equal(code, 1);
  assert.deepEqual(order, ["stop", "install", "restart"]);
  assert.match(err.toString(), /update failed/);
  assert.match(out.toString(), /pid 7778/);
});
