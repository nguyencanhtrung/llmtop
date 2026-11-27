import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";

export function detectInstallMode({ root = ROOT, exists = existsSync } = {}) {
  const normalized = root.replace(/\\/g, "/");
  if (normalized.includes("/_npx/")) return { mode: "npx", packageManager: "npm", root };
  if (!normalized.includes("/node_modules/") && exists(join(root, ".git"))) return { mode: "local", packageManager: null, root };
  if (normalized.includes("/pnpm/") || normalized.includes("/pnpm-global/")) return { mode: "global", packageManager: "pnpm", root };
  if (normalized.includes("/yarn/") || normalized.includes("/.yarn/")) return { mode: "global", packageManager: "yarn", root };
  if (normalized.includes("/.bun/")) return { mode: "global", packageManager: "bun", root };
  if (normalized.includes("/node_modules/")) return { mode: "global", packageManager: "npm", root };
  return { mode: "unknown", packageManager: "npm", root };
}

export function packageManagerCommand(pm, action, spec) {
  const table = {
    npm: { install: ["npm", ["install", "-g", spec]], uninstall: ["npm", ["uninstall", "-g", spec]] },
    pnpm: { install: ["pnpm", ["add", "-g", spec]], uninstall: ["pnpm", ["remove", "-g", spec]] },
    yarn: { install: ["yarn", ["global", "add", spec]], uninstall: ["yarn", ["global", "remove", spec]] },
    bun: { install: ["bun", ["add", "-g", spec]], uninstall: ["bun", ["remove", "-g", spec]] },
  };
  const manager = table[pm] ?? table.npm;
  return manager[action];
}

export function formatCommand(cmd, args) {
  return [cmd, ...args].join(" ");
}

export function runPackageManager(pm, action, spec, { spawn = spawnSync, platform = process.platform } = {}) {
  const [cmd, args] = packageManagerCommand(pm, action, spec);
  const command = formatCommand(cmd, args);
  const res = spawn(cmd, args, { encoding: "utf8", stdio: "pipe", shell: platform === "win32" });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const error = res.error ? res.error.message : "";
  const ok = !res.error && res.status === 0;
  const permissionDenied = /EACCES|EPERM|permission denied/i.test(`${stderr}\n${error}`);
  return { ok, code: res.status ?? 1, stdout, stderr, error, command, permissionDenied };
}

export function hasGlobalPackage(pm = "npm", pkgName = "llmtop", { spawn = spawnSync, platform = process.platform } = {}) {
  if (pm !== "npm") return false;
  try {
    const res = spawn("npm", ["list", "-g", pkgName, "--depth=0", "--json"], {
      encoding: "utf8",
      stdio: "pipe",
      shell: platform === "win32",
    });
    if (res.status !== 0 || !res.stdout?.trim()) return false;
    const parsed = JSON.parse(res.stdout);
    return Boolean(parsed?.dependencies?.[pkgName]);
  } catch {
    return false;
  }
}
