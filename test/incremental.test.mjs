import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { buildUsageRows } from "../src/dashboard.mjs";
import { assistant, cost, jsonl, sid, touch, user, writeTranscript } from "./fixtures/build.mjs";
import { runLlmtop } from "./fixtures/home.mjs";

function makeMultiHome() {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-inc-"));
  const claudeDir = join(dir, "claude");
  const codexHome = join(dir, "codex");
  const codexDir = join(codexHome, "sessions");
  const agyDir = join(dir, "agy");
  mkdirSync(join(codexDir, "2026", "11", "10"), { recursive: true });
  mkdirSync(join(agyDir, "brain", "conv-main", ".system_generated", "logs"), { recursive: true });
  const repoA = join(dir, "work", "alpha");
  const repoB = join(dir, "work", "beta");
  mkdirSync(join(repoA, ".git"), { recursive: true });
  mkdirSync(join(repoB, ".git"), { recursive: true });

  writeFileSync(join(dir, "prices.md"), [
    "| model | from | input | output | cache read | cache write 5m | cache write 1h |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| claude-sonnet-5-5 | 2026-10-01 | 2 | 10 | 0.2 | 2.5 | 4 |",
    "| gpt-6.2-sol | 2026-10-01 | 2 | 10 | 0.2 | 2 | 2 |",
    "| gemini-4-neon | 2026-10-01 | 3 | 15 | 0.15 | 3 | 3 |",
  ].join("\n") + "\n");

  const cfg = join(dir, "llmtop.config.json");
  writeFileSync(cfg, JSON.stringify({
    providers: {
      claude: { transcripts: claudeDir },
      codex: { transcripts: codexDir },
      agy: { transcripts: agyDir },
    },
    data: "data",
    prices: "prices.md",
    timeZone: "Etc/GMT-7",
  }));

  return { dir, claudeDir, codexHome, codexDir, agyDir, repoA, repoB, cfg, run: (...a) => runLlmtop(cfg, a) };
}

function snapshotDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const sortBy = (rows, ...keys) => [...rows].sort((a, b) => {
    for (const k of keys) {
      const av = String(a[k] ?? "");
      const bv = String(b[k] ?? "");
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  });
  const snap = {
    sessions: sortBy(db.prepare("SELECT * FROM sessions").all(), "id").map((r) => ({ ...r })),
    requests: sortBy(db.prepare("SELECT message_id, session_id, agent_id, ts, day, hour, model, family, is_sub, input, output, cache_read, cache_write, rebuild, rebuild_gap, rebuild_extra FROM requests").all(), "message_id").map((r) => ({ ...r })),
    subagents: sortBy(db.prepare("SELECT * FROM subagents").all(), "agent_id").map((r) => ({ ...r })),
    titles: sortBy(db.prepare("SELECT session_id, line, kind, title FROM titles").all(), "session_id", "line", "kind").map((r) => ({ ...r })),
    file_meta: sortBy(db.prepare("SELECT f.provider, f.path, m.parent_session_id, m.subagent_type, m.api_ms, m.tool_ms, m.lines_added, m.lines_removed, m.repo_url, m.target_paths FROM file_meta m JOIN files f ON f.id = m.file_id").all(), "provider", "path").map((r) => ({ ...r })),
  };
  db.close();
  return snap;
}

test("incremental updates across all providers match a full archive rebuild byte-for-byte", () => {
  const h = makeMultiHome();
  const cMain = sid(1);
  const cFork = sid(2);
  const xParent = "01a2172a-ef3f-7fa1-b51b-ca3045f10001";
  const xSub = "01a2172a-ef3f-7fa1-b51b-ca3045f10002";

  // 1. Initial scan: Claude session + carried-from fork, orphan Codex subagent (parent arrives later), Antigravity session.
  const shared = [
    user("2026-11-10T01:00:00Z", "start", { cwd: h.repoA }),
    assistant("2026-11-10T01:00:05Z", "cm1", { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 30000 }, { model: "claude-sonnet-5-5", rec: { cwd: h.repoA } }),
  ];
  writeTranscript(h.claudeDir, "alpha", cMain, [...shared, cost(1, { startTime: 1000, modelUsage: { "claude-sonnet-5-5": { costUSD: 1, inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 30000 } } })]);
  writeTranscript(h.claudeDir, "alpha", cFork, [...shared, user("2026-11-10T01:10:00Z", "fork", { cwd: h.repoA }), assistant("2026-11-10T01:10:05Z", "cm2", { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 25000 }, { model: "claude-sonnet-5-5", rec: { cwd: h.repoA } }), cost(2.5, { startTime: 1500, modelUsage: { "claude-sonnet-5-5": { costUSD: 2.5, inputTokens: 150, outputTokens: 70, cacheCreationInputTokens: 55000 } } })]);

  // Codex subagent lands BEFORE parent exists on disk.
  writeFileSync(join(h.codexDir, "2026", "11", "10", `rollout-2026-11-10T09-01-00-${xSub}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:01:00Z", type: "session_meta", payload: { id: xSub, parent_thread_id: xParent, source: { subagent: { other: "worker" } }, cwd: h.repoA } },
    { timestamp: "2026-11-10T01:01:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: h.repoA } },
    { timestamp: "2026-11-10T01:01:02Z", type: "token_usage_record", payload: { response_id: "xr-sub", usage: { input_tokens: 25000, cached_input_tokens: 0, output_tokens: 50 } } },
  ]));

  // Antigravity session.
  const sumDb = new DatabaseSync(join(h.agyDir, "conversation_summaries.db"));
  sumDb.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT, agent_name TEXT);");
  sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run("conv-main", "Agy initial", JSON.stringify([pathToFileURL(h.repoA).href]), "", "");
  sumDb.close();
  writeFileSync(join(h.agyDir, "brain", "conv-main", ".system_generated", "logs", "transcript.jsonl"), jsonl([
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-10T02:00:00Z", content: "hello agy" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-10T02:00:05Z", model: "gemini-4-neon-high", input_tokens: 30000, cache_read_tokens: 0, output_tokens: 100 },
  ]));

  assert.equal(h.run("scan").code, 0);

  // 2. Incremental changes:
  // a) Update parent Claude session -> should transitively update carried-from cFork too!
  writeTranscript(h.claudeDir, "alpha", cMain, [
    assistant("2026-11-10T01:08:00Z", "cm1b", { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 25000 }, { model: "claude-sonnet-5-5", rec: { cwd: h.repoA } }),
    cost(1.5, { startTime: 1000, modelUsage: { "claude-sonnet-5-5": { costUSD: 1.5, inputTokens: 120, outputTokens: 60, cacheCreationInputTokens: 55000 } } }),
  ], { append: true });

  // b) Late-arriving Codex parent + session_index title -> promotes xSub from main to sub!
  writeFileSync(join(h.codexHome, "session_index.jsonl"), jsonl([{ id: xParent, thread_name: "Codex Parent Title" }]));
  writeFileSync(join(h.codexDir, "2026", "11", "10", `rollout-2026-11-10T09-00-00-${xParent}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:00:00Z", type: "session_meta", payload: { id: xParent, cwd: h.repoA } },
    { timestamp: "2026-11-10T01:00:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: h.repoA } },
    { timestamp: "2026-11-10T01:00:02Z", type: "token_usage_record", payload: { response_id: "xr-main", usage: { input_tokens: 25000, cached_input_tokens: 0, output_tokens: 100 } } },
  ]));

  // c) Deleted worktree path gets recovered once beta becomes a known repo!
  const cGone = sid(3);
  const goneBeta = join(h.dir, "umbrella", "beta.feat-1");
  writeTranscript(h.claudeDir, "umbrella", cGone, [user("2026-11-10T03:00:00Z", "wt", { cwd: goneBeta })]);
  assert.equal(h.run("scan").code, 0);
  const cBeta = sid(4);
  writeTranscript(h.claudeDir, "beta", cBeta, [user("2026-11-10T03:05:00Z", "in beta", { cwd: h.repoB })]);
  assert.equal(h.run("scan").code, 0);

  // d) Price table change triggers full re-derive & markRebuilds.
  writeFileSync(join(h.dir, "prices.md"), [
    "| model | from | input | output | cache read | cache write 5m | cache write 1h |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| claude-sonnet-5-5 | 2026-10-01 | 2 | 10 | 0.2 | 2.5 | 4 |",
    "| gpt-6.2-sol | 2026-10-01 | 4 | 20 | 0.4 | 4 | 4 |",
    "| gemini-4-neon | 2026-10-01 | 3 | 15 | 0.15 | 3 | 3 |",
  ].join("\n") + "\n");
  assert.equal(h.run("scan").code, 0);

  const dbPath = join(h.dir, "data", "usage.db");
  const incSnap = snapshotDb(dbPath);
  const incDash = buildUsageRows(loadConfig(h.cfg));

  // Force full rebuild from archive and assert byte-for-byte parity.
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE meta SET value = '0' WHERE key = 'schema'");
  db.close();
  assert.equal(h.run("scan").code, 0);

  const fullSnap = snapshotDb(dbPath);
  const fullDash = buildUsageRows(loadConfig(h.cfg));
  assert.deepEqual(incSnap, fullSnap);

  // Dashboard rows: ignore `scanned` timestamp and SQL rowid ordering of sessions/facts/context.
  const normDash = (d) => {
    const sessKey = (i) => d.sessions[i]?.id;
    const modKey = (i) => d.models[i];
    const projKey = (i) => d.projects[i];
    const sortStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      today: d.today,
      models: [...d.models].sort(),
      providers: [...d.providers].sort(),
      projects: [...d.projects].sort(),
      types: [...d.types].sort(),
      efforts: d.efforts,
      transcripts: d.transcripts,
      sessions: d.sessions.map((s) => ({ ...s, p: projKey(s.p) })).sort((a, b) => sortStr(a.id, b.id)),
      facts: d.facts.map((f) => [sessKey(f[0]), f[1], f[2], modKey(f[3]), ...f.slice(4)]).sort((a, b) => sortStr(JSON.stringify(a), JSON.stringify(b))),
      subagents: d.subagents.map((a) => ({ ...a, s: sessKey(a.s), type: d.types[a.type] })).sort((a, b) => sortStr(JSON.stringify(a), JSON.stringify(b))),
      context: d.context.map((x) => [sessKey(x[0]), x[1], modKey(x[2]), ...x.slice(3)]).sort((a, b) => sortStr(JSON.stringify(a), JSON.stringify(b))),
      edges: d.edges,
      points: d.points,
    };
  };
  assert.deepEqual(normDash(incDash), normDash(fullDash));
});

test("v13 databases upgrade in place with ctime_ms and file_id indexes, using index plans", () => {
  const h = makeMultiHome();
  const s = sid(10);
  writeTranscript(h.claudeDir, "alpha", s, [
    user("2026-11-10T01:00:00Z", "hi", { cwd: h.repoA }),
    assistant("2026-11-10T01:00:05Z", "m10", { input_tokens: 100, output_tokens: 20 }, { model: "claude-sonnet-5-5", rec: { cwd: h.repoA } }),
  ]);
  assert.equal(h.run("scan").code, 0);

  // Drop the new column/indexes? SQLite <3.35/older won't drop column if indexed, so drop indexes first and simulate pre-upgrade files without ctime_ms via temp table copy.
  const dbPath = join(h.dir, "data", "usage.db");
  const db = new DatabaseSync(dbPath);
  for (const idx of ["requests_file", "tool_calls_file", "skills_file", "compactions_file", "owner_messages_file"]) {
    db.exec(`DROP INDEX IF EXISTS ${idx}`);
  }
  db.exec(`
    CREATE TABLE files_old(id INTEGER PRIMARY KEY, provider TEXT, path TEXT, kind TEXT, session_id TEXT, agent_id TEXT,
      generation INTEGER DEFAULT 0, offset INTEGER DEFAULT 0, lines INTEGER DEFAULT 0, head_hash TEXT,
      archive_size INTEGER DEFAULT 0, first_ts TEXT, own_first TEXT, own_last TEXT, cwd TEXT, live INTEGER DEFAULT 1,
      UNIQUE(provider, path));
    INSERT INTO files_old(id, provider, path, kind, session_id, agent_id, generation, offset, lines, head_hash, archive_size, first_ts, own_first, own_last, cwd, live)
      SELECT id, provider, path, kind, session_id, agent_id, generation, offset, lines, head_hash, archive_size, first_ts, own_first, own_last, cwd, live FROM files;
    DROP TABLE files;
    ALTER TABLE files_old RENAME TO files;
    CREATE INDEX files_session ON files(session_id);
  `);
  db.close();

  // Next scan upgrades schema v13 in place without triggering a full archive rebuild.
  assert.equal(h.run("scan").code, 0);

  const upgraded = new DatabaseSync(dbPath, { readOnly: true });
  assert.ok(upgraded.prepare("PRAGMA table_info(files)").all().some((c) => c.name === "ctime_ms"));
  for (const table of ["requests", "tool_calls", "skills", "compactions", "owner_messages"]) {
    const plan = upgraded.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${table} WHERE file_id = ?`).all(1).map((r) => r.detail).join(" ");
    assert.match(plan, /USING (?:COVERING )?INDEX/, `${table} should use index, got: ${plan}`);
  }
  upgraded.close();
});

test("racy-clean protection catches an immediate same-size rewrite", () => {
  const h = makeMultiHome();
  const s = sid(20);
  const p = writeTranscript(h.claudeDir, "alpha", s, [
    user("2026-11-10T01:00:00Z", "aaaa", { cwd: h.repoA }),
    assistant("2026-11-10T01:00:05Z", "m20a", { input_tokens: 100, output_tokens: 10 }, { model: "claude-sonnet-5-5", rec: { cwd: h.repoA } }),
  ]);
  const stat1 = writeTranscript;
  assert.equal(stat1 && h.run("scan").code, 0);

  // Immediately overwrite with exact same byte length (changed message_id "m20a" -> "m20b", same length, same timestamp)
  const raw = jsonl([
    user("2026-11-10T01:00:00Z", "bbbb", { cwd: h.repoA }),
    assistant("2026-11-10T01:00:05Z", "m20b", { input_tokens: 100, output_tokens: 10 }, { model: "claude-sonnet-5-5", rec: { cwd: h.repoA } }),
  ]);
  // Force same mtime to mimic coarse filesystem timestamps right after scan.
  touch(p, 0);
  writeFileSync(p, raw);
  utimesSync(p, 1700000000, 1700000000);
  const res = h.run("scan");
  assert.equal(res.code, 0);
  assert.match(res.stdout, /1 rewritten files kept as generations/);

  const db = new DatabaseSync(join(h.dir, "data", "usage.db"), { readOnly: true });
  assert.deepEqual(db.prepare("SELECT message_id FROM requests").all().map((r) => r.message_id), ["m20b"]);
  db.close();
});
