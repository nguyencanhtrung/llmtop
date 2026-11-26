import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { buildUsageRows } from "../src/dashboard.mjs";
import { assistant, sid, user, writeTranscript } from "./fixtures/build.mjs";
import { runLlmtop } from "./fixtures/home.mjs";

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function makeAgyHome() {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-agy-"));
  const agyHome = join(dir, "agy-home");
  mkdirSync(join(agyHome, "brain"), { recursive: true });
  const cfg = join(dir, "llmtop.config.json");
  writeFileSync(cfg, JSON.stringify({ providers: { agy: { transcripts: agyHome } }, data: "data", prices: "prices.md", timeZone: "Etc/GMT-7" }));
  return { dir, agyHome, cfg, run: (...a) => runLlmtop(cfg, a) };
}

test("agy ingests PLANNER_RESPONSE without subtracting cache_read, splits model/effort, reads summaries.db, and rebuilds from archive", () => {
  const home = makeAgyHome();
  const repo = join(home.dir, "work", "beta");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(home.dir, "prices.md"), `| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| gemini-4-neon | 2026-10-01 | 3 | 15 | 0.15 | 3 | 3 |
| gemini-4-carbon | 2026-10-01 | 2 | 10 | 0.10 | 2 | 2 |
| gemini-4-carbon | 2026-12-01 | 4 | 20 | 0.20 | 4 | 4 |
| gemini-5-carbon | 2026-12-01 | 4 | 20 | 0.20 | 4 | 4 |
`);

  const convMain = "conv-main-1111";
  const convSub = "conv-sub-2222";
  mkdirSync(join(home.agyHome, "brain", convMain, ".system_generated", "logs"), { recursive: true });
  mkdirSync(join(home.agyHome, "brain", convSub, ".system_generated", "logs"), { recursive: true });

  const sumDb = new DatabaseSync(join(home.agyHome, "conversation_summaries.db"));
  sumDb.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT, agent_name TEXT);");
  sumDb.exec("CREATE TABLE conversation_parents(conversation_id TEXT PRIMARY KEY, parent_id TEXT);");
  sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(
    convMain, "Build multi-provider support", JSON.stringify([pathToFileURL(repo).href]), "", "",
  );
  sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(
    convSub, "Codebase Research", JSON.stringify([pathToFileURL(repo).href]), convMain, "research",
  );
  sumDb.close();

  writeFileSync(join(home.agyHome, "brain", convMain, ".system_generated", "logs", "transcript.jsonl"), jsonl([
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T02:00:00Z", content: "Inspect codebase" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T02:00:05Z", model: "gemini-4-neon-xhigh", input_tokens: 1000, cache_read_tokens: 5000, output_tokens: 200, tool_calls: [{ name: "run_command", args: {} }] },
    { step_index: 2, source: "SYSTEM", type: "GENERIC", status: "ERROR", created_at: "2026-11-26T02:00:06Z", content: "", error: "command failed" },
  ]));

  writeFileSync(join(home.agyHome, "brain", convSub, ".system_generated", "logs", "transcript.jsonl"), jsonl([
    { step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-12-02T02:00:00Z", model: "gemini-4-carbon-medium", input_tokens: 500, cache_read_tokens: 1000, output_tokens: 100, tool_calls: [{ name: "read_file", args: {} }] },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-12-02T02:01:00Z", model: "gemini-5-carbon-high", input_tokens: 500, cache_read_tokens: 0, output_tokens: 100 },
  ]));

  assert.equal(home.run("scan").code, 0);

  const u = JSON.parse(home.run("usage", "--since", "2026-11-26", "--until", "2026-12-02", "--by", "model", "--json").stdout);
  assert.equal(u.total.sessions, 1);
  assert.equal(u.total.i, 2000);
  assert.equal(u.total.cr, 6000);
  assert.equal(u.total.o, 400);
  // Cost:
  // 2026-11-26 gemini-4-neon: 1000*3/1e6 + 5000*0.15/1e6 + 200*15/1e6 = 0.00675
  // 2026-12-02 gemini-4-carbon: 500*4/1e6 + 1000*0.20/1e6 + 100*20/1e6 = 0.0042
  // 2026-12-02 gemini-5-carbon: 500*4/1e6 + 100*20/1e6 = 0.004
  assert.ok(Math.abs(u.total.c - 0.01495) < 1e-9);

  const dash = buildUsageRows(loadConfig(home.cfg));
  assert.deepEqual(dash.providers, ["Antigravity"]);
  assert.deepEqual(dash.projects, ["beta"]);
  assert.equal(dash.sessions[0].title, "Build multi-provider support");
  assert.deepEqual(dash.models.sort(), ["Gemini Carbon", "Gemini Neon"]);
  assert.equal(dash.subagents.length, 1);
  assert.equal(dash.types[0], "research");
  assert.deepEqual(dash.tools[0], { run_command: [1, 1], read_file: [1, 0] });

  // Delete host dir & database and recover strictly from archive/agy/.
  rmSync(home.agyHome, { recursive: true });
  rmSync(join(home.dir, "data", "usage.db"));
  assert.equal(home.run("scan").code, 0);
  const after = buildUsageRows(loadConfig(home.cfg));
  assert.equal(after.sessions[0].title, "Build multi-provider support");
  assert.deepEqual(after.projects, ["beta"]);
  assert.equal(after.subagents.length, 1);
});

test("multi-provider CLI and dashboard stay in parity and hide providers with no data", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-multi-"));
  const claudeDir = join(dir, "claude");
  const codexDir = join(dir, "codex", "sessions");
  const agyDir = join(dir, "agy");
  mkdirSync(join(codexDir, "2026", "11", "10"), { recursive: true });
  mkdirSync(join(agyDir, "brain", "c1", ".system_generated", "logs"), { recursive: true });
  const repo = join(dir, "work", "gamma");
  mkdirSync(join(repo, ".git"), { recursive: true });

  writeFileSync(join(dir, "prices.md"), `| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| claude-sonnet-5-5 | 2026-10-01 | 2 | 10 | 0.10 | 2.50 | 4 |
| gpt-6.2-sol | 2026-10-01 | 2 | 10 | 0.10 | 2 | 2 |
| gemini-4-neon | 2026-10-01 | 3 | 15 | 0.15 | 3 | 3 |
`);
  const cfg = join(dir, "llmtop.config.json");
  writeFileSync(cfg, JSON.stringify({
    providers: { claude: { transcripts: claudeDir }, codex: { transcripts: codexDir }, agy: { transcripts: agyDir } },
    data: "data", prices: "prices.md", timeZone: "Etc/GMT-7",
  }));

  writeTranscript(claudeDir, "gamma", sid(1), [
    user("2026-11-10T01:00:00Z", "claude hi", { cwd: repo }),
    assistant("2026-11-10T01:00:05Z", "m1", { input_tokens: 100, output_tokens: 50 }, { model: "claude-sonnet-5-5", rec: { cwd: repo } }),
  ]);
  writeFileSync(join(codexDir, "2026", "11", "10", `rollout-2026-11-10T09-00-00-${sid(2)}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:00:00Z", type: "session_meta", payload: { id: sid(2), cwd: repo } },
    { timestamp: "2026-11-10T01:00:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: repo } },
    { timestamp: "2026-11-10T01:00:02Z", type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 75 } } },
  ]));
  // Leave AGY empty on first scan -> only Claude and Codex should appear.
  assert.equal(runLlmtop(cfg, ["scan"]).code, 0);
  let dash = buildUsageRows(loadConfig(cfg));
  assert.deepEqual([...dash.providers].sort(), ["Claude", "Codex"]);

  // Now populate AGY and re-scan -> all 3 providers appear and match CLI --by provider & --provider filters.
  writeFileSync(join(agyDir, "brain", "c1", ".system_generated", "logs", "transcript.jsonl"), jsonl([
    { step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-10T01:00:00Z", model: "gemini-4-neon-high", input_tokens: 300, cache_read_tokens: 0, output_tokens: 120 },
  ]));
  assert.equal(runLlmtop(cfg, ["scan"]).code, 0);
  dash = buildUsageRows(loadConfig(cfg));
  assert.deepEqual([...dash.providers].sort(), ["Antigravity", "Claude", "Codex"]);

  const byProv = JSON.parse(runLlmtop(cfg, ["usage", "--since", "2026-11-10", "--until", "2026-11-10", "--by", "provider", "--json"]).stdout);
  assert.deepEqual(Object.fromEntries(byProv.groups[0].rows.map((r) => [r.key, r.o])), { Claude: 50, Codex: 75, Antigravity: 120 });

  const onlyCodex = JSON.parse(runLlmtop(cfg, ["usage", "--since", "2026-11-10", "--until", "2026-11-10", "--provider", "codex", "--json"]).stdout);
  assert.equal(onlyCodex.total.o, 75);
  assert.equal(onlyCodex.total.sessions, 1);

  const bad = runLlmtop(cfg, ["usage", "--provider", "nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no provider named nope/);
});

test("agy extracts working time, line diffs, content error markers, skills, and implicit cache rebuilds", () => {
  const home = makeAgyHome();
  const repo = join(home.dir, "work", "epsilon");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(home.dir, "prices.md"), `| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| gemini-4-neon | 2026-10-01 | 3 | 15 | 0.15 | 3 | 3 |
`);

  const conv = "conv-rich-3333";
  mkdirSync(join(home.agyHome, "brain", conv, ".system_generated", "logs"), { recursive: true });
  const sumDb = new DatabaseSync(join(home.agyHome, "conversation_summaries.db"));
  sumDb.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT, agent_name TEXT);");
  sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(conv, "Rich metrics", JSON.stringify([pathToFileURL(repo).href]), "", "");
  sumDb.close();

  writeFileSync(join(home.agyHome, "brain", conv, ".system_generated", "logs", "transcript.jsonl"), jsonl([
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-26T02:00:00Z", content: "/plan update file" },
    {
      step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-26T02:00:04Z",
      model: "gemini-4-neon-high", input_tokens: 30000, cache_read_tokens: 0, output_tokens: 150,
      tool_calls: [
        { name: "read_file", args: { Path: JSON.stringify("/home/u/.agents/skills/plan/SKILL.md") } },
        { name: "edit_file", args: { Target: JSON.stringify("line1\nold2"), Replacement: JSON.stringify("line1\nnew2\nnew3") } },
        { name: "write_file", args: { Content: JSON.stringify("a\nb\n") } },
      ],
    },
    { step_index: 2, source: "SYSTEM", type: "GENERIC", created_at: "2026-11-26T02:00:06Z", content: "Command exited with code 1\nfailed" },
    { step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-26T02:07:06Z", content: "continue" },
    { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-26T02:07:09Z", model: "gemini-4-neon-high", input_tokens: 25000, cache_read_tokens: 10000, output_tokens: 80 },
  ]));

  assert.equal(home.run("scan").code, 0);
  const dash = buildUsageRows(loadConfig(home.cfg));
  const sess = dash.sessions[0];
  assert.equal(sess.api, 7);
  assert.equal(sess.tool, 2);
  assert.equal(sess.la, 4);
  assert.equal(sess.lr, 1);
  assert.deepEqual(dash.tools[0].write_file, [1, 1]);
  assert.deepEqual(dash.skills[0].plan, [1, 1, 0, "2026-11-26"]);
  assert.equal(dash.skillSources.plan, "personal");

  const u = JSON.parse(home.run("usage", "--since", "2026-11-26", "--until", "2026-11-26", "--json").stdout);
  assert.equal(u.total.rebuild.start.n, 1);
  assert.equal(u.total.rebuild.idle.n, 1);
  assert.equal(u.total.rebuild.idle.tokens, 25000);
});

test("agy launched from a non-git folder resolves to the target git repo it edits", () => {
  const home = makeAgyHome();
  const parent = join(home.dir, "umbrella");
  const child = join(parent, "child-repo");
  mkdirSync(join(child, ".git"), { recursive: true });
  writeFileSync(join(home.dir, "prices.md"), `| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| gemini-4-neon | 2026-10-01 | 3 | 15 | 0.15 | 3 | 3 |
`);

  const conv = "conv-target-4444";
  mkdirSync(join(home.agyHome, "brain", conv, ".system_generated", "logs"), { recursive: true });
  const sumDb = new DatabaseSync(join(home.agyHome, "conversation_summaries.db"));
  sumDb.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT, agent_name TEXT);");
  sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(conv, "Target child", JSON.stringify([pathToFileURL(parent).href]), "", "");
  sumDb.close();

  writeFileSync(join(home.agyHome, "brain", conv, ".system_generated", "logs", "transcript.jsonl"), jsonl([
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-26T03:00:00Z", content: "edit child" },
    {
      step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-26T03:00:02Z",
      model: "gemini-4-neon-high", input_tokens: 100, cache_read_tokens: 0, output_tokens: 20,
      tool_calls: [{ name: "edit_file", args: { Path: JSON.stringify(join(child, "app.ts")), Target: JSON.stringify("a"), Replacement: JSON.stringify("b") } }],
    },
  ]));

  assert.equal(home.run("scan").code, 0);
  const dash = buildUsageRows(loadConfig(home.cfg));
  assert.deepEqual(dash.projects, ["child-repo"]);
});
