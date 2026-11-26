// Per-session values computed after every scan from the ingested rows. Cheap: one pass over sessions.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { repoFromUrl } from "./paths.mjs";
import { markRebuilds } from "./rebuilds.mjs";
import { zoner } from "./zone.mjs";
import { missOf, priceAt, readPrices, requestCost, usageCost } from "./prices.mjs";

const IGNORE_GIT_ROOTS = new Set(["/", homedir(), tmpdir(), "/tmp", "/var/tmp"]);
const GENERIC_DIR_RE = /^(?:repo|src|worktree|checkout|tmp|temp|home|code|docs|tests|test|scripts|tools)$/i;
const validRepoName = (n) => Boolean(n && n.length >= 3 && !n.startsWith(".") && !GENERIC_DIR_RE.test(n));
const inTmpDir = (p) => p.startsWith(tmpdir() + sep) || p.startsWith("/tmp/") || p.startsWith("/var/tmp/");

function manifestNameOf(dir) {
  try {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const n = JSON.parse(readFileSync(pkg, "utf8"))?.name;
      if (typeof n === "string" && n.trim()) return n.trim().replace(/^@[^/]+\//, "");
    }
    const py = join(dir, "pyproject.toml");
    if (existsSync(py)) {
      const text = readFileSync(py, "utf8");
      const sec = text.match(/\[(?:project|tool\.poetry)\]([\s\S]*?)(?:\n\[|$)/);
      const m = (sec ? sec[1] : text).match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1].trim();
    }
    const cargo = join(dir, "Cargo.toml");
    if (existsSync(cargo)) {
      const text = readFileSync(cargo, "utf8");
      const sec = text.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
      const m = sec?.[1].match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1].trim();
    }
    const gomod = join(dir, "go.mod");
    if (existsSync(gomod)) {
      const m = readFileSync(gomod, "utf8").match(/^\s*module\s+(\S+)/m);
      if (m) return basename(m[1].replace(/\/v\d+$/, ""));
    }
  } catch { /* ignore unreadable manifest */ }
  return null;
}

function originNameOf(gitDir, depth = 0) {
  if (depth >= 3) return null;
  const cfg = join(gitDir, "config");
  if (!existsSync(cfg)) return null;
  try {
    const text = readFileSync(cfg, "utf8");
    const m = text.match(/\[remote "origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/m) ?? text.match(/\[remote "[^"]+"\][\s\S]*?^\s*url\s*=\s*(.+)$/m);
    if (!m) return null;
    const url = m[1].trim();
    if (url.startsWith("/") && existsSync(url)) {
      const clean = url.replace(/\/+$/, "").replace(/\.git$/i, "");
      if (inTmpDir(clean) || GENERIC_DIR_RE.test(basename(clean))) {
        return resolveGitDirName(clean, join(clean, ".git"), depth + 1);
      }
      return basename(clean);
    }
    return repoFromUrl(url);
  } catch {
    return null;
  }
}

function resolveGitDirName(dir, gitDir, depth = 0) {
  const base = basename(dir);
  if (inTmpDir(dir) || GENERIC_DIR_RE.test(base)) {
    const orig = originNameOf(gitDir, depth);
    if (orig && !GENERIC_DIR_RE.test(orig)) return orig;
    const man = manifestNameOf(dir);
    if (man && !GENERIC_DIR_RE.test(man)) return man;
  }
  return base;
}

function gitRepoOf(p) {
  if (!p || !existsSync(p)) return null;
  let dir = p;
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    return null;
  }
  for (; ; dir = dirname(dir)) {
    if (!IGNORE_GIT_ROOTS.has(dir)) {
      const g = join(dir, ".git");
      if (existsSync(g)) {
        try {
          const st = statSync(g);
          if (st.isFile()) {
            const m = readFileSync(g, "utf8").match(/^gitdir:\s*(.+)$/m);
            if (m) {
              const gd = resolve(dir, m[1].trim());
              const wt = gd.match(/^(.*)[/\\]\.git[/\\]worktrees[/\\]/);
              if (wt) {
                const mainRoot = wt[1];
                let name = resolveGitDirName(mainRoot, join(mainRoot, ".git"));
                if (GENERIC_DIR_RE.test(name)) name = manifestNameOf(dir) || name;
                return { root: mainRoot, name };
              }
            }
          } else if (st.isDirectory()) {
            return { root: dir, name: resolveGitDirName(dir, g) };
          }
        } catch { /* unreadable .git metadata; fall back to dir name */ }
        return { root: dir, name: basename(dir) };
      }
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

// The nearest directory at or above cwd that holds .git (skipping root/home/tmp, resolving worktrees/temp clones), else cwd's own name.
// onDisk tells whether cwd still exists, so a session whose folder is gone keeps the project it had without climbing parent repos.
export function projectOf(cwd) {
  if (!cwd) return null;
  const onDisk = existsSync(cwd);
  if (onDisk) {
    const g = gitRepoOf(cwd);
    if (g) return { name: g.name, onDisk: true };
  }
  return { name: basename(cwd) || "(no project)", onDisk };
}

function matchSeg(seg, skip, knownRepos, sortedKnown) {
  if (!seg || skip.has(seg)) return null;
  if (knownRepos.has(seg)) return seg;
  for (const k of sortedKnown) {
    if (skip.has(k)) continue;
    if (seg.startsWith(`${k}.`) || seg.startsWith(`${k}-`) || seg.startsWith(`${k}_`)) return k;
  }
  return null;
}

function matchFallbackPath(dir, cwdRepo, knownRepos, sortedKnown) {
  if (!dir) return null;
  const skip = new Set();
  let scanPath = dir;
  if (cwdRepo) {
    for (const seg of cwdRepo.root.split(/[/\\]+/).filter(Boolean)) skip.add(seg);
    skip.add(cwdRepo.name);
    if (dir.startsWith(cwdRepo.root + sep)) scanPath = dir.slice(cwdRepo.root.length + 1);
  }
  const parts = scanPath.split(/[/\\]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const hit = matchSeg(parts[i], skip, knownRepos, sortedKnown);
    if (hit) return hit;
  }
  return null;
}

function resolveSessionProject(cwd, repoUrl, pathWeights, existingProject, knownRepos, sortedKnown) {
  const cwdRepo = cwd ? gitRepoOf(cwd) : null;
  const urlRepo = repoFromUrl(repoUrl);
  const byRepo = new Map();
  for (const [dir, [w, r]] of Object.entries(pathWeights ?? {})) {
    let name = gitRepoOf(dir)?.name ?? null;
    if (!name && (!existsSync(dir) || inTmpDir(dir))) name = matchFallbackPath(dir, cwdRepo, knownRepos, sortedKnown);
    if (!name) continue;
    const cur = byRepo.get(name) ?? { name, w: 0, r: 0 };
    cur.w += w;
    cur.r += r;
    byRepo.set(name, cur);
  }
  const repos = [...byRepo.values()].sort((a, b) => (b.w - a.w) || ((b.w + b.r) - (a.w + a.r)));
  const totalW = repos.reduce((n, x) => n + x.w, 0);
  const totalR = repos.reduce((n, x) => n + x.r, 0);
  const totalScore = totalW + totalR;
  const cwdEntry = cwdRepo ? byRepo.get(cwdRepo.name) : null;
  const cwdScore = (cwdEntry?.w ?? 0) + (cwdEntry?.r ?? 0);
  const bestOther = repos.find((x) => !GENERIC_DIR_RE.test(x.name) && (!cwdRepo || x.name !== cwdRepo.name)) ?? null;

  if (cwdRepo && bestOther) {
    const otherScore = bestOther.w + bestOther.r;
    if (bestOther.w > 0 && bestOther.w > (cwdEntry?.w ?? 0) && bestOther.w >= 0.5 * totalW) return bestOther.name;
    if (totalW === 0 && bestOther.r >= 3 && bestOther.r > (cwdEntry?.r ?? 0) && bestOther.r >= 0.5 * totalR) return bestOther.name;
    if (bestOther.r >= 5 && otherScore >= 2 * cwdScore && otherScore >= 0.5 * totalScore) return bestOther.name;
  }
  if (!cwdRepo && urlRepo) return urlRepo;
  if (!cwdRepo && bestOther && (bestOther.w > 0 || bestOther.r >= 2)) return bestOther.name;
  if (cwdRepo) {
    if (GENERIC_DIR_RE.test(cwdRepo.name)) {
      if (urlRepo && !GENERIC_DIR_RE.test(urlRepo)) return urlRepo;
      if (bestOther) return bestOther.name;
    }
    return cwdRepo.name;
  }
  if (urlRepo) return urlRepo;
  const p = projectOf(cwd);
  if (p && !p.onDisk) {
    const segHit = matchSeg(basename(cwd), new Set(), knownRepos, sortedKnown);
    if (segHit) return segHit;
  }
  return p && !p.onDisk && existingProject ? existingProject : (p?.name ?? null);
}

const firstLine = (text) => text.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? null;

export function derive(db, config) {
  const files = db.prepare("SELECT id, provider, session_id, path, cwd, own_first first_ts, own_last last_ts FROM files WHERE kind = 'main'").all();
  const existing = new Map(db.prepare("SELECT id, project FROM sessions").all().map((s) => [s.id, s.project]));
  const titles = db.prepare("SELECT kind, title FROM titles WHERE file_id = ? ORDER BY line DESC");
  const firstOwner = db.prepare("SELECT text FROM owner_messages WHERE session_id = ? AND kind = 'typed' ORDER BY ts, line LIMIT 1");
  const lastCost = db.prepare("SELECT * FROM cost_states WHERE file_id = ? ORDER BY line DESC LIMIT 1");
  const knownRepos = new Set();
  for (const f of files) {
    const g = f.cwd ? gitRepoOf(f.cwd) : null;
    if (g && validRepoName(g.name)) knownRepos.add(g.name);
  }
  const sessionMeta = new Map();
  for (const r of db.prepare(`SELECT f.session_id, f.kind, m.api_ms, m.tool_ms, m.lines_added, m.lines_removed, m.repo_url, m.target_paths
    FROM file_meta m JOIN files f ON f.id = m.file_id`).all()) {
    let cur = sessionMeta.get(r.session_id);
    if (!cur) {
      cur = { api_ms: null, tool_ms: null, lines_added: null, lines_removed: null, repo_url: null, pathWeights: {} };
      sessionMeta.set(r.session_id, cur);
    }
    if (r.api_ms !== null) cur.api_ms = (cur.api_ms ?? 0) + r.api_ms;
    if (r.tool_ms !== null) cur.tool_ms = (cur.tool_ms ?? 0) + r.tool_ms;
    if (r.lines_added !== null) cur.lines_added = (cur.lines_added ?? 0) + r.lines_added;
    if (r.lines_removed !== null) cur.lines_removed = (cur.lines_removed ?? 0) + r.lines_removed;
    if (r.repo_url) {
      if (r.kind === "main" || !cur.repo_url) cur.repo_url = r.repo_url;
      const u = repoFromUrl(r.repo_url);
      if (validRepoName(u)) knownRepos.add(u);
    }
    if (r.target_paths) {
      try {
        for (const [dir, pair] of Object.entries(JSON.parse(r.target_paths))) {
          if (!Array.isArray(pair)) continue;
          const prev = cur.pathWeights[dir] ?? (cur.pathWeights[dir] = [0, 0]);
          prev[0] += Number(pair[0]) || 0;
          prev[1] += Number(pair[1]) || 0;
          const g = gitRepoOf(dir);
          if (g && validRepoName(g.name)) knownRepos.add(g.name);
        }
      } catch { /* ignore malformed json */ }
    }
  }
  const sortedKnown = [...knownRepos].sort((a, b) => b.length - a.length);
  // The session this file continues or forks: of the sessions owning the requests it repeats, the latest to start.
  // CROSS JOIN keeps the order from the file's few repeats; left to the planner it scanned every file and request per file.
  const predecessor = db.prepare(`SELECT f.session_id id FROM repeats p CROSS JOIN requests q ON q.message_id = p.message_id
    CROSS JOIN files f ON f.kind = 'main' AND f.session_id = q.session_id
    WHERE p.file_id = ? AND q.session_id <> ? GROUP BY f.id ORDER BY f.own_first DESC LIMIT 1`);
  const requestsOf = db.prepare("SELECT model, day, input, output, cache_read, cache_write, cache_write_1h FROM requests WHERE session_id = ?");
  const prices = readPrices(config).rows;
  const zone = zoner(config.timeZone);
  const upsert = db.prepare(`INSERT INTO sessions(id, provider, slug, cwd, project, title, first_ts, last_ts, cost, cost_incomplete, cost_estimated, price_check,
      api_ms, tool_ms, lines_added, lines_removed, carried_from, model_cost, model_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, slug = excluded.slug, cwd = excluded.cwd, project = excluded.project, title = excluded.title,
      first_ts = excluded.first_ts, last_ts = excluded.last_ts, cost = excluded.cost, cost_incomplete = excluded.cost_incomplete,
      cost_estimated = excluded.cost_estimated, price_check = excluded.price_check,
      api_ms = excluded.api_ms, tool_ms = excluded.tool_ms, lines_added = excluded.lines_added, lines_removed = excluded.lines_removed,
      carried_from = excluded.carried_from, model_cost = excluded.model_cost, model_tokens = excluded.model_tokens`);

  const raw = new Map();
  for (const f of files) {
    const c = lastCost.get(f.id);
    raw.set(f.session_id, c ? { ...c, models: JSON.parse(c.model_usage) } : null);
  }

  db.exec("BEGIN");
  try {
    for (const f of files) {
      const ms = sessionMeta.get(f.session_id);
      const project = resolveSessionProject(f.cwd, ms?.repo_url ?? null, ms?.pathWeights ?? null, existing.get(f.session_id), knownRepos, sortedKnown);
      const t = titles.all(f.id);
      const title = t.find((x) => x.kind === "custom")?.title ?? t.find((x) => x.kind === "ai")?.title ?? (firstOwner.get(f.session_id)?.text ? firstLine(firstOwner.get(f.session_id).text) : null);

      const c = raw.get(f.session_id);
      let cost = null;
      let models = null;
      let tokens = null;
      let estimated = null;
      let check = null;
      let api = c?.api_ms ?? ms?.api_ms ?? null;
      let tool = c?.tool_ms ?? ms?.tool_ms ?? null;
      let added = c?.lines_added ?? ms?.lines_added ?? null;
      let removed = c?.lines_removed ?? ms?.lines_removed ?? null;
      let carriedFrom = null;
      let prev = null;
      if (c) {
        models = { ...c.models };
        // A host record that started with the earlier session's record is cumulative and holds all of it;
        // a fork or a resume in a new process starts its own record shortly before its first own line.
        const earlier = predecessor.get(f.id, f.session_id);
        prev = earlier ? raw.get(earlier.id) : null;
        if (prev && c.start_ms !== null && prev.start_ms !== null && c.start_ms <= prev.start_ms + 1000) {
          carriedFrom = earlier.id;
          const less = (v, w) => (v === null ? null : Math.max(0, v - (w ?? 0)));
          for (const [m, u] of Object.entries(models)) {
            const was = prev.models[m] ?? {};
            models[m] = { ...u, ...Object.fromEntries(["cost", "input", "output", "read", "write", "w5", "w1", "web"].map((k) => [k, less(u[k], was[k])])) };
          }
          api = less(api, prev.api_ms);
          tool = less(tool, prev.tool_ms);
          added = less(added, prev.lines_added);
          removed = less(removed, prev.lines_removed);
        }
        // Each model's figure against the price table, for a record the host marked complete.
        const day = f.first_ts ? zone(f.first_ts).day : null;
        if (!c.incomplete && day) {
          check = {};
          for (const [m, u] of Object.entries(models)) {
            if (!u.cost) continue;
            const row = priceAt(prices, m, day);
            if (u.web) check[m] = { day, skipped: "web search" };
            else if (!row) check[m] = { day, skipped: "no price" };
            else check[m] = { day, host: u.cost, ...usageCost(row.p, u), miss: missOf(u.cost, usageCost(row.p, u)) };
          }
        }
        const known = Object.values(models).map((u) => u.cost).filter((v) => v !== null);
        if (known.length) cost = known.reduce((a, b) => a + b, 0);
        // The tokens the host priced per model, to split a cost the transcript holds no request for.
        tokens = Object.fromEntries(Object.entries(models).map(([m, u]) => [m, { input: u.input, output: u.output, read: u.read, write: u.write, w5: u.w5, w1: u.w1, split: u.split, web: u.web }]));
        models = Object.fromEntries(Object.entries(models).map(([m, u]) => [m, u.cost]));
        if (!known.length && c.cost !== null) {
          cost = carriedFrom ? Math.max(0, c.cost - (prev.cost ?? 0)) : c.cost;
          models = { unknown: cost };
        }
      } else {
        // No host record: the requests priced on their day, marked as estimated; unknown if a model has no price.
        const reqs = requestsOf.all(f.session_id);
        const rows = reqs.map((r) => [r, priceAt(prices, r.model, r.day)]);
        if (reqs.length && rows.every(([, row]) => row)) {
          models = {};
          for (const [r, row] of rows) models[r.model] = (models[r.model] ?? 0) + requestCost(row.p, r);
          cost = Object.values(models).reduce((a, b) => a + b, 0);
          estimated = 1;
        }
      }
      upsert.run(f.session_id, f.provider, f.path.split(sep)[0], f.cwd, project, title, f.first_ts, f.last_ts, cost,
        c ? (c.incomplete ? 1 : 0) : null, estimated, check ? JSON.stringify(check) : null, api, tool, added, removed, carriedFrom, models ? JSON.stringify(models) : null, tokens ? JSON.stringify(tokens) : null);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  markRebuilds(db, prices);
}
