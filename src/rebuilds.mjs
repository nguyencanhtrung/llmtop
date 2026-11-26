// Cache rebuilds: requests that write most of their context into the prompt cache again.
import { priceAt } from "./prices.mjs";

export const MIN_REWRITE = 20000; // tokens written to the cache for a request to count
export const SHARE = 0.5; // ...and more than this share of everything the request read or wrote
export const CAUSES = ["start", "compaction", "idle", "other"];
const SHORT_LIFETIME = 5 * 60; // seconds a cache write lives, without the 1h option
const LONG_LIFETIME = 60 * 60;

export const rewrittenTokens = (r) => (r.cache_write > 0 ? r.cache_write : r.input);
export const isRebuild = (r) => {
  const rw = rewrittenTokens(r);
  return rw >= MIN_REWRITE && rw > SHARE * (r.input + r.cache_read + r.cache_write);
};

// Rewritten tokens priced as cache writes (5m/1h by the split, as requestCost does) minus the same tokens priced as reads.
export function extraCost(p, r) {
  if (r.cache_write > 0) {
    const w1 = r.cache_write_1h ?? r.cache_write;
    return ((r.cache_write - w1) * p[3] + w1 * p[4] - r.cache_write * p[2]) / 1e6;
  }
  return (r.input * (p[0] - p[2])) / 1e6;
}

// requests: { session_id, agent_id, ts, line, model, day, input, cache_read, cache_write, cache_write_1h } in any order.
// compactions: Map of thread (session id, newline, agent id or "") to its compaction instants (ms).
// Returns Map of request to { rebuild, gap, extra } for rebuilds.
export function classify(requests, compactions, prices) {
  const threads = new Map();
  for (const r of requests) {
    if (r.model === "<synthetic>") continue;
    const key = `${r.session_id}\n${r.agent_id ?? ""}`;
    let list = threads.get(key);
    if (!list) threads.set(key, (list = []));
    list.push({ r, at: Date.parse(r.ts) });
  }
  const out = new Map();
  for (const [key, list] of threads) {
    list.sort((a, b) => a.at - b.at || a.r.line - b.r.line);
    const comps = compactions.get(key) ?? [];
    let prev = null;
    let lifetime = SHORT_LIFETIME;
    for (const { r, at } of list) {
      // The first request after a compaction rewrites the new short history while it still reads the system prompt and
      // tools from the cache, so it often writes less than half of what it carries: it counts once it rewrites enough.
      const compacted = prev !== null && comps.some((c) => c > prev && c <= at);
      if (isRebuild(r) || (compacted && rewrittenTokens(r) >= MIN_REWRITE)) {
        const gap = prev === null ? null : Math.round((at - prev) / 1000);
        let cause;
        if (prev === null) cause = "start";
        else if (compacted) cause = "compaction";
        else if (gap > lifetime) cause = "idle";
        else cause = "other";
        const row = priceAt(prices, r.model, r.day);
        out.set(r, { rebuild: cause, gap, extra: row ? extraCost(row.p, r) : null });
      }
      // The cache a thread holds lives as long as its latest write promised.
      if (r.cache_write > 0) lifetime = r.cache_write_1h > 0 ? LONG_LIFETIME : SHORT_LIFETIME;
      prev = at;
    }
  }
  return out;
}

const CHUNK = 500;

function queryBySessions(db, buildSql, sessions) {
  const rows = [];
  for (let i = 0; i < sessions.length; i += CHUNK) {
    const slice = sessions.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    for (const r of db.prepare(buildSql(placeholders)).all(...slice)) rows.push(r);
  }
  return rows;
}

// Recompute the rebuild columns of requests (all or only `dirtySessions`), writing only the rows that changed.
export function markRebuilds(db, prices, dirtySessions = null) {
  if (dirtySessions instanceof Set && dirtySessions.size === 0) return;
  const reqCols = "message_id, session_id, agent_id, ts, line, model, day, input, cache_read, cache_write, cache_write_1h, rebuild, rebuild_gap, rebuild_extra";
  let requests;
  let compRows;
  if (dirtySessions instanceof Set) {
    const list = [...dirtySessions];
    requests = queryBySessions(db, (ph) => `SELECT ${reqCols} FROM requests WHERE session_id IN (${ph})`, list);
    compRows = queryBySessions(db, (ph) => `SELECT session_id, agent_id, ts FROM compactions WHERE ts IS NOT NULL AND session_id IN (${ph})`, list);
  } else {
    requests = db.prepare(`SELECT ${reqCols} FROM requests`).all();
    compRows = db.prepare("SELECT session_id, agent_id, ts FROM compactions WHERE ts IS NOT NULL").all();
  }
  const compactions = new Map();
  for (const c of compRows) {
    const key = `${c.session_id}\n${c.agent_id ?? ""}`;
    (compactions.get(key) ?? compactions.set(key, []).get(key)).push(Date.parse(c.ts));
  }
  const found = classify(requests, compactions, prices);
  const set = db.prepare("UPDATE requests SET rebuild = ?, rebuild_gap = ?, rebuild_extra = ? WHERE message_id = ?");
  db.exec("BEGIN");
  try {
    for (const r of requests) {
      const c = found.get(r) ?? { rebuild: null, gap: null, extra: null };
      if (c.rebuild !== r.rebuild || c.gap !== r.rebuild_gap || c.extra !== r.rebuild_extra) set.run(c.rebuild, c.gap, c.extra, r.message_id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
