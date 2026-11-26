// Machine-independent path normalization, Git URL parsing, and touched-directory weighting for project resolution.
import { dirname, resolve } from "node:path";

const IGNORE_PATH_RE = /(?:^|[/\\])\.(?:codex|claude|gemini|agents)(?:[/\\]|$)|^\/(?:proc|sys|etc)(?:\/|$)|^\/dev(?:\/(?!shm(?:\/|$))|$)/i;

export function isAbsPath(p) {
  return typeof p === "string" && (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p));
}

const GIT_C_RE = /\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)`"']+))/g;
const CD_DIR_RE = /(?:^|[;&|(\n])\s*cd\s+(?:--?\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|)`"']+))/g;

export function extractCommandDirs(cmdText, baseCwd = null) {
  if (typeof cmdText !== "string" || !cmdText) return [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const val = raw.trim();
    if (!val || val === "-" || val.startsWith("~") || val.startsWith("$") || val.startsWith("-")) return;
    const abs = isAbsPath(val) ? val : (isAbsPath(baseCwd) ? resolve(baseCwd, val) : null);
    if (!abs || IGNORE_PATH_RE.test(abs)) return;
    const dir = stripTrailing(abs);
    if (isAbsPath(dir)) seen.add(dir);
  };
  for (const re of [GIT_C_RE, CD_DIR_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cmdText)) !== null) push(m[1] ?? m[2] ?? m[3]);
  }
  return [...seen];
}

export function repoFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const clean = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const m = clean.match(/[:/]([^/:]+)$/);
  return m ? m[1] : null;
}

const stripTrailing = (p) => (p.length > 1 ? p.replace(/[/\\]+$/, "") || "/" : p);

export function createPathTracker(initialJson) {
  const counts = new Map();
  if (initialJson) {
    try {
      const obj = JSON.parse(initialJson);
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (Array.isArray(v) && v.length >= 2) counts.set(k, [Number(v[0]) || 0, Number(v[1]) || 0]);
        }
      }
    } catch { /* ignore malformed saved counts */ }
  }
  let ops = 0;

  return {
    add(rawPath, { isFile = false, write = false, baseCwd = null } = {}) {
      if (typeof rawPath !== "string" || !rawPath) return false;
      let abs = rawPath.trim();
      if (!isAbsPath(abs)) {
        if (!isAbsPath(baseCwd)) return false;
        abs = resolve(baseCwd, abs);
      }
      const dir = stripTrailing(isFile ? dirname(abs) : abs);
      if (!isAbsPath(dir) || IGNORE_PATH_RE.test(dir)) return false;
      const isNew = !counts.has(dir);
      const cur = counts.get(dir) ?? [0, 0];
      if (write) cur[0] += 3;
      else cur[1] += 1;
      counts.set(dir, cur);
      ops++;
      return isNew || write || ops <= 15 || ops % 10 === 0;
    },
    toJSON() {
      if (!counts.size) return null;
      const top = [...counts.entries()]
        .sort((a, b) => (b[1][0] - a[1][0]) || ((b[1][0] + b[1][1]) - (a[1][0] + a[1][1])))
        .slice(0, 32);
      return JSON.stringify(Object.fromEntries(top));
    },
  };
}
