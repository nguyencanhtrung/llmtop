import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultConfigDir } from "./config.mjs";
import { detectInstallMode, hasGlobalPackage, packageManagerCommand, formatCommand, runPackageManager } from "./install.mjs";
import { findRunningServers, stopRunningServers } from "./process.mjs";

function isSameOrInside(target, parent) {
  return target === parent || target.startsWith(parent + sep);
}

export function collectDataTargets(config, { env = process.env, home = homedir(), exists = existsSync } = {}) {
  const defaultDir = resolve(defaultConfigDir(env, home));
  const cfgPath = resolve(config.configPath);
  const dataDir = resolve(config.data);
  const homeDir = resolve(home);
  const transcriptPaths = Object.values(config.providers ?? {})
    .map((p) => p?.transcripts)
    .filter(Boolean)
    .map((p) => resolve(p));

  const isSafeTarget = (target) => {
    if (!target || target === sep || target === "/" || target === homeDir) return false;
    return !transcriptPaths.some((t) => isSameOrInside(t, target));
  };

  if (isSameOrInside(cfgPath, defaultDir) && isSameOrInside(dataDir, defaultDir)) {
    return exists(defaultDir) && isSafeTarget(defaultDir) ? [defaultDir] : [];
  }

  const candidates = [dataDir, cfgPath];
  if (exists(defaultDir)) candidates.push(defaultDir);

  const targets = [];
  for (const candidate of candidates) {
    if (!exists(candidate) || !isSafeTarget(candidate)) continue;
    if (targets.some((existing) => existing === candidate || isSameOrInside(candidate, existing))) continue;
    targets.push(candidate);
  }
  return targets;
}

async function promptConfirm(question, input, out) {
  const rl = createInterface({ input, output: out });
  try {
    const answer = await rl.question(question);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function uninstallCommand({ config, options = {}, out, err = process.stderr, input = process.stdin, deps = {} }) {
  const dryRun = Boolean(options["dry-run"]);
  const yes = Boolean(options.yes);
  let purge = Boolean(options.purge);
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const isTTY = deps.isTTY ?? Boolean(input.isTTY && out.isTTY);
  const exists = deps.exists ?? existsSync;
  const remove = deps.rm ?? rmSync;

  const install = (deps.detectInstallMode ?? detectInstallMode)();
  const { servers, staleState } = (deps.findRunningServers ?? findRunningServers)(config);
  const dataTargets = collectDataTargets(config, { env, home, exists });

  let packageManager = null;
  if (install.mode === "global") {
    packageManager = install.packageManager || "npm";
  } else if ((deps.hasGlobalPackage ?? hasGlobalPackage)("npm", "llmtop")) {
    packageManager = "npm";
  }

  out.write("llmtop uninstall plan:\n");
  if (servers.length > 0) {
    const summary = servers.map((s) => `pid ${s.pid}${s.port ? ` (port ${s.port})` : ""}`).join(", ");
    out.write(`  - stop running server(s): ${summary}\n`);
  } else {
    out.write("  - stop running server(s): none\n");
  }
  if (packageManager) {
    const [cmd, args] = packageManagerCommand(packageManager, "uninstall", "llmtop");
    out.write(`  - remove global package: ${formatCommand(cmd, args)}\n`);
  } else if (install.mode === "local") {
    out.write(`  - remove global package: none (local checkout at ${install.root} will not be deleted)\n`);
  } else {
    out.write("  - remove global package: none\n");
  }
  if (dataTargets.length === 0) {
    out.write("  - local config and data: none\n");
  } else if (purge) {
    out.write(`  - local config and data: remove ${dataTargets.join(", ")}\n`);
  } else {
    out.write(`  - local config and data: keep ${dataTargets.join(", ")} (use --purge to remove)\n`);
  }
  out.write("  - provider transcripts (~/.claude, ~/.codex, ~/.gemini/antigravity-cli) will not be touched.\n");

  if (dryRun) {
    out.write("dry run: no changes made\n");
    return 0;
  }

  if (!yes) {
    if (!isTTY) {
      err.write("error: uninstall requires confirmation; pass --yes in non-interactive shells\n");
      return 1;
    }
    const confirm = deps.confirm ?? ((question) => promptConfirm(question, input, out));
    if (!(await confirm("Proceed with uninstall? [y/N] "))) {
      out.write("aborted\n");
      return 0;
    }
    if (!purge && dataTargets.length > 0) {
      if (await confirm(`Also remove local config and archived data (${dataTargets.join(", ")})? [y/N] `)) {
        purge = true;
      }
    }
  }

  if (servers.length > 0 || staleState) {
    const { stopped, failed } = await (deps.stopRunningServers ?? stopRunningServers)(config);
    if (failed.length > 0) {
      for (const f of failed) err.write(`error: could not stop llmtop serve (pid ${f.pid}): ${f.error}\n`);
      return 1;
    }
    for (const s of stopped) {
      out.write(`stopped llmtop serve (pid ${s.pid}${s.port ? `, port ${s.port}` : ""})\n`);
    }
  }

  if (packageManager) {
    const res = (deps.runPackageManager ?? runPackageManager)(packageManager, "uninstall", "llmtop");
    if (!res.ok) {
      err.write(`error: uninstall failed (${res.command}): ${res.error || res.stderr.trim() || `exit code ${res.code}`}\n`);
      if (res.permissionDenied) {
        err.write(`hint: try running \`sudo ${res.command}\`\n`);
      }
      if (purge && dataTargets.length > 0) {
        err.write("skipped deleting local config and data because package removal failed\n");
      }
      return 1;
    }
    out.write(`removed global package (${res.command})\n`);
  }

  if (install.mode === "local") {
    out.write(`kept local checkout at ${install.root}; remove it manually if no longer needed.\n`);
  }

  if (purge && dataTargets.length > 0) {
    for (const target of dataTargets) {
      remove(target, { recursive: true, force: true });
    }
    const defaultDir = resolve(defaultConfigDir(env, home));
    if (exists(defaultDir) && readdirSync(defaultDir).length === 0) {
      try {
        rmdirSync(defaultDir);
      } catch {
        // Ignore if not removable.
      }
    }
    for (const target of dataTargets) {
      const parent = dirname(target);
      if (parent === defaultDir && exists(parent) && readdirSync(parent).length === 0) {
        try {
          rmdirSync(parent);
        } catch {
          // Ignore if not removable.
        }
      }
    }
    out.write(`removed local data: ${dataTargets.join(", ")}\n`);
  } else if (dataTargets.length > 0) {
    out.write(`kept local data at: ${dataTargets.join(", ")}\n`);
  }

  return 0;
}
