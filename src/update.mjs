import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { detectInstallMode, runPackageManager } from "./install.mjs";
import { findRunningServers } from "./process.mjs";

const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function parseSemver(raw) {
  if (typeof raw !== "string") throw new Error(`invalid version: ${raw}`);
  const cleaned = raw.trim().replace(/^v/, "").split("+")[0];
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`invalid semver: ${raw}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    if (pa.pre[i] === undefined) return -1;
    if (pb.pre[i] === undefined) return 1;
    const na = /^\d+$/.test(pa.pre[i]);
    const nb = /^\d+$/.test(pb.pre[i]);
    if (na && nb) {
      const va = Number(pa.pre[i]);
      const vb = Number(pb.pre[i]);
      if (va !== vb) return va < vb ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa.pre[i] !== pb.pre[i]) {
      return pa.pre[i] < pb.pre[i] ? -1 : 1;
    }
  }
  return 0;
}

export function registryUrl(env = process.env) {
  return (env.LLMTOP_REGISTRY || env.npm_config_registry || "https://registry.npmjs.org").replace(/\/+$/, "");
}

export async function fetchLatestVersion({
  pkgName = "llmtop",
  registry = registryUrl(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const url = `${registry}/${encodeURIComponent(pkgName)}/latest`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`failed to reach npm registry at ${registry}: ${err?.message ?? String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${url}`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`invalid JSON response from npm registry at ${url}`);
  }
  if (typeof data?.version !== "string" || !data.version.trim()) {
    throw new Error(`npm registry response at ${url} did not contain a version`);
  }
  return data.version.trim();
}

export async function updateCommand({ config, options = {}, out, err = process.stderr, deps = {} }) {
  const current = deps.currentVersion ?? VERSION;
  const env = deps.env ?? process.env;
  const install = (deps.detectInstallMode ?? detectInstallMode)();
  const latest = await (deps.fetchLatestVersion ?? fetchLatestVersion)({ registry: registryUrl(env) });
  const updateAvailable = compareSemver(current, latest) < 0;

  if (options.check) {
    if (options.json) {
      out.write(`${JSON.stringify({
        current,
        latest,
        updateAvailable,
        installMode: install.mode,
        packageManager: install.packageManager,
      }, null, 1)}\n`);
    } else if (updateAvailable) {
      out.write(`update available: llmtop ${current} -> ${latest}\n`);
    } else {
      out.write(`llmtop ${current} is up to date (latest: ${latest})\n`);
    }
    return 0;
  }

  if (!updateAvailable && !options.force) {
    out.write(`llmtop ${current} is already up to date (latest: ${latest})\n`);
    return 0;
  }

  if (!options.force) {
    if (install.mode === "local") {
      err.write(`llmtop is running from a local git checkout (${install.root}); run \`git pull && npm run build\`, or pass --force to install globally\n`);
      return 1;
    }
    if (install.mode === "npx") {
      err.write("llmtop is running via npx; run `npx llmtop@latest` or install globally with `npm install -g llmtop@latest` (pass --force to install globally)\n");
      return 1;
    }
  }

  const pm = install.packageManager || "npm";
  const res = (deps.runPackageManager ?? runPackageManager)(pm, "install", `llmtop@${latest}`);
  if (!res.ok) {
    err.write(`error: update failed (${res.command}): ${res.error || res.stderr.trim() || `exit code ${res.code}`}\n`);
    if (res.permissionDenied) {
      err.write(`hint: try running \`sudo ${res.command}\`\n`);
    }
    return 1;
  }

  out.write(`updated llmtop ${current} -> ${latest}\n`);
  const { servers } = (deps.findRunningServers ?? findRunningServers)(config);
  if (servers.length > 0) {
    const details = servers.map((s) => `pid ${s.pid}${s.port ? ` on port ${s.port}` : ""}`).join(", ");
    out.write(`note: llmtop serve is still running (${details}); run \`llmtop stop\` and \`llmtop serve\` to use ${latest}.\n`);
  }
  return 0;
}
