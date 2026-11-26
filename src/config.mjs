import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "./providers/index.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expand = (path, base) => resolve(base, path.startsWith("~/") || path === "~" ? join(homedir(), path.slice(1)) : path);

export function defaultConfigDir(env = process.env, home = homedir()) {
  const xdgHome = env.XDG_CONFIG_HOME;
  if (xdgHome && isAbsolute(xdgHome)) return join(xdgHome, "llmtop");
  return join(home, ".config", "llmtop");
}

export function defaultConfigPath(env = process.env, home = homedir()) {
  if (env.LLMTOP_CONFIG) return env.LLMTOP_CONFIG;
  const xdg = join(defaultConfigDir(env, home), "config.json");
  const local = join(ROOT, "llmtop.config.json");
  if (!existsSync(xdg) && existsSync(local)) return local;
  return xdg;
}

// Reads the optional config file (~/.config/llmtop/config.json by default; LLMTOP_CONFIG points elsewhere).
// A missing file means all defaults; relative paths resolve against the config's folder. An unknown
// provider name is an error. Keys this module does not know are returned untouched.
export function loadConfig(path, env = process.env) {
  const file = resolve(path ?? defaultConfigPath(env));
  const base = dirname(file);
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`cannot read config ${file}: ${err.message}`);
  }
  const data = expand(raw.data ?? (env.LLMTOP_DATA || "data"), base);
  const configured = raw.providers ?? Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, {}]));
  const providers = Object.fromEntries(Object.entries(configured).map(([name, p]) => {
    if (!Object.hasOwn(PROVIDERS, name)) throw new Error(`unknown provider "${name}" in ${file}; known: ${Object.keys(PROVIDERS).join(", ")}`);
    return [name, { ...p, transcripts: expand(p?.transcripts ?? PROVIDERS[name].defaultPath, base) }];
  }));
  return {
    ...raw,
    configPath: file,
    root: base,
    providers,
    data,
    archive: join(data, "archive"),
    database: join(data, "usage.db"),
    prices: expand(raw.prices ?? join(ROOT, "prices.md"), base),
    timeZone: raw.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    port: raw.port ?? 4310,
  };
}
