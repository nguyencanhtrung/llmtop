import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { buildUsageRows } from "../src/dashboard.mjs";
import { runLlmtop } from "./fixtures/home.mjs";

function makeCodexHome() {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-codex-"));
  const codexHome = join(dir, "codex-home");
  const sessions = join(codexHome, "sessions");
  mkdirSync(join(sessions, "2026", "11", "10"), { recursive: true });
  const cfg = join(dir, "llmtop.config.json");
  writeFileSync(cfg, JSON.stringify({ providers: { codex: { transcripts: sessions } }, data: "data", prices: "prices.md", timeZone: "Etc/GMT-7" }));
  return { dir, codexHome, sessions, cfg, run: (...a) => runLlmtop(cfg, a) };
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("codex subtracts cached tokens from input, avoids token_usage_record + token_count double counting, links subagents and titles, and recovers from archive", () => {
  const home = makeCodexHome();
  const repo = join(home.dir, "work", "alpha");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(home.dir, "prices.md"), `| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-sol | 2026-10-01 | 2 | 10 | 0.10 | 2 | 2 |
| gpt-6-luna | 2026-10-01 | 0.10 | 0.50 | 0.01 | 0.10 | 0.10 |
`);

  const mainId = "01a2172a-ef3f-7fa1-b51b-ca3045f16795";
  const subId = "01a2172a-ef3f-7fa1-b51b-ca3045f16796";
  const legacyId = "01a2172a-ef3f-7fa1-b51b-ca3045f16797";

  writeFileSync(join(home.codexHome, "session_index.jsonl"), jsonl([
    { id: mainId, thread_name: "Fix webhook retries", updated_at: "2026-11-10T02:00:00Z" },
    { id: legacyId, thread_name: "Legacy token count", updated_at: "2026-11-10T03:00:00Z" },
  ]));

  // Modern rollout with BOTH token_usage_record and event_msg:token_count for the same step.
  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-00-00-${mainId}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:00:00Z", type: "session_meta", payload: { id: mainId, cwd: repo, timestamp: "2026-11-10T01:00:00Z" } },
    { timestamp: "2026-11-10T01:00:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", effort: "high", cwd: repo } },
    { timestamp: "2026-11-10T01:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md\nignore" }, { type: "input_text", text: "Fix the retry bug" }] } },
    { timestamp: "2026-11-10T01:00:05Z", type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_1", arguments: "{}" } },
    { timestamp: "2026-11-10T01:00:06Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "Exit code: 1\nboom" } },
    { timestamp: "2026-11-10T01:00:07Z", type: "token_usage_record", payload: { response_id: "resp_1", usage: { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 1300 } } },
    { timestamp: "2026-11-10T01:00:07Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40 }, total_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 100, total_tokens: 1300 } } } },
    { timestamp: "2026-11-10T01:00:08Z", type: "compacted", payload: { message: "" } },
  ]));

  // Subagent rollout linked via session_meta.payload.parent_thread_id.
  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-01-00-${subId}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:01:00Z", type: "session_meta", payload: { id: subId, parent_thread_id: mainId, source: { subagent: { other: "guardian" } }, cwd: repo } },
    { timestamp: "2026-11-10T01:01:01Z", type: "turn_context", payload: { model: "gpt-6-luna", effort: "low", cwd: repo } },
    { timestamp: "2026-11-10T01:01:02Z", type: "token_usage_record", payload: { response_id: "resp_sub", usage: { input_tokens: 500, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 550 } } },
  ]));

  // Legacy rollout with ONLY event_msg:token_count, including a duplicate rate-limit event.
  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T10-00-00-${legacyId}.jsonl`), jsonl([
    { timestamp: "2026-11-10T02:00:00Z", type: "session_meta", payload: { id: legacyId, cwd: repo } },
    { timestamp: "2026-11-10T02:00:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", effort: "medium", cwd: repo } },
    { timestamp: "2026-11-10T02:00:02Z", type: "event_msg", payload: { type: "user_message", message: "Check old format" } },
    { timestamp: "2026-11-10T02:00:05Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 }, total_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 20, total_tokens: 320 } } } },
    { timestamp: "2026-11-10T02:00:06Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 }, total_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 20, total_tokens: 320 } } } },
  ]));

  const scan = home.run("scan");
  assert.equal(scan.code, 0, scan.stderr);

  const u = JSON.parse(home.run("usage", "--since", "2026-11-10", "--until", "2026-11-10", "--by", "provider", "--json").stdout);
  assert.equal(u.total.sessions, 2);
  assert.equal(u.total.q, 3);
  // uncached input: (1200-1000) + (500-400) + (300-200) = 400
  assert.equal(u.total.i, 400);
  // cache_read: 1000 + 400 + 200 = 1600
  assert.equal(u.total.cr, 1600);
  // output: 100 + 50 + 20 = 170; thinking: 40 + 10 + 5 = 55
  assert.equal(u.total.o, 170);
  assert.equal(u.total.th, 55);
  assert.equal(u.groups[0].rows[0].key, "Codex");

  const dash = buildUsageRows(loadConfig(home.cfg));
  assert.deepEqual(dash.providers, ["Codex"]);
  assert.deepEqual([...dash.models].sort(), ["GPT Luna", "GPT Sol"]);
  assert.equal(dash.sessions.find((s) => s.id === mainId.slice(0, 8)).title, "Fix webhook retries");
  assert.equal(dash.sessions.find((s) => s.id === mainId.slice(0, 8)).compact, 1);
  assert.equal(dash.subagents.length, 1);
  assert.equal(dash.types[0], "guardian");
  assert.deepEqual(dash.tools[0], { shell: [1, 1] });

  // Expected estimated cost:
  // gpt-6.2-sol: (200+100)*2/1e6 + 1200*0.1/1e6 + 120*10/1e6 = 0.0006 + 0.00012 + 0.0012 = 0.00192
  // gpt-6-luna: 100*0.1/1e6 + 400*0.01/1e6 + 50*0.5/1e6 = 0.00001 + 0.000004 + 0.000025 = 0.000039
  assert.ok(Math.abs(u.total.c - 0.001959) < 1e-9);

  // Delete host folder + database and rebuild strictly from archive.
  rmSync(home.codexHome, { recursive: true });
  rmSync(join(home.dir, "data", "usage.db"));
  assert.equal(home.run("scan").code, 0);
  const after = buildUsageRows(loadConfig(home.cfg));
  assert.equal(after.sessions.length, 2);
  assert.equal(after.sessions.find((s) => s.id === mainId.slice(0, 8)).title, "Fix webhook retries");
  assert.equal(after.subagents.length, 1);
});

test("codex extracts working time, patch lines, array output errors, skills, and implicit cache rebuilds", () => {
  const home = makeCodexHome();
  const repo = join(home.dir, "work", "delta");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(home.dir, "prices.md"), `| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-sol | 2026-10-01 | 2 | 10 | 0.2 | 2 | 2 |
`);

  const sidRich = "01a2172a-ef3f-7fa1-b51b-ca3045f18888";
  const patch = "*** Begin Patch\n*** Update File: app.js\n@@\n-old1\n-old2\n+new1\n+new2\n+new3\n*** End Patch";
  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-00-00-${sidRich}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:00:00Z", type: "session_meta", payload: { id: sidRich, cwd: repo } },
    { timestamp: "2026-11-10T01:00:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", effort: "high", cwd: repo } },
    { timestamp: "2026-11-10T01:00:02Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-11-10T01:00:02Z", type: "event_msg", payload: { type: "user_message", message: "Use $code-review to patch $HOME safely" } },
    { timestamp: "2026-11-10T01:00:03Z", type: "response_item", payload: { type: "function_call", name: "exec", call_id: "c1", arguments: JSON.stringify({ cmd: "cat ~/.agents/skills/code-review/SKILL.md" }) } },
    { timestamp: "2026-11-10T01:00:05Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script completed\nWall time 1.5 seconds\nOutput:\nok" }] } },
    { timestamp: "2026-11-10T01:00:06Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: patch } },
    { timestamp: "2026-11-10T01:00:07Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "Script failed\nWall time 0.5 seconds" }] } },
    { timestamp: "2026-11-10T01:00:08Z", type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 30000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 200 } } },
    { timestamp: "2026-11-10T01:00:08Z", type: "event_msg", payload: { type: "task_complete", duration_ms: 6000 } },
    { timestamp: "2026-11-10T01:07:00Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-11-10T01:07:04Z", type: "token_usage_record", payload: { response_id: "r2", usage: { input_tokens: 25000, cached_input_tokens: 5000, cache_write_input_tokens: 0, output_tokens: 100 } } },
    { timestamp: "2026-11-10T01:07:04Z", type: "event_msg", payload: { type: "task_complete", duration_ms: 4000 } },
  ]));

  assert.equal(home.run("scan").code, 0);
  const dash = buildUsageRows(loadConfig(home.cfg));
  const sess = dash.sessions[0];
  assert.equal(sess.api, 8);
  assert.equal(sess.tool, 2);
  assert.equal(sess.la, 3);
  assert.equal(sess.lr, 2);
  assert.deepEqual(dash.tools[0], { exec: [1, 0], apply_patch: [1, 1] });
  assert.deepEqual(dash.skills[0]["code-review"], [1, 1, 0, "2026-11-10"]);
  assert.equal(dash.skills[0].HOME, undefined);
  assert.equal(dash.skillSources["code-review"], "personal");

  const u = JSON.parse(home.run("usage", "--since", "2026-11-10", "--until", "2026-11-10", "--json").stdout);
  assert.equal(u.total.rebuild.start.n, 1);
  assert.equal(u.total.rebuild.idle.n, 1);
  assert.equal(u.total.rebuild.idle.tokens, 20000);
});

test("codex consolidates model versions into families while pricing exact versions, prefers FileChange over duplicate Begin Patch, and handles JS-wrapped Begin Patch", () => {
  const home = makeCodexHome();
  const repo = join(home.dir, "work", "epsilon");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(home.dir, "prices.md"), `| model | from | input | output | cache read | cache write 5m | cache write 1h |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-sol | 2026-10-01 | 2 | 10 | 0.2 | 2 | 2 |
| gpt-5.6-sol | 2026-10-01 | 1 | 5 | 0.1 | 1 | 1 |
`);

  const sidFc = "01a2172b-ef3f-7fa1-b51b-ca3045f19901";
  const sidPatch = "01a2172c-ef3f-7fa1-b51b-ca3045f19902";

  // Rollout with BOTH JS-wrapped apply_patch AND authoritative FileChange (add + update + delete).
  const jsPatch = 'text(await tools.apply_patch(`*** Begin Patch\n*** Update File: app.js\n@@\n-x\n+y\n*** End Patch`))';
  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-00-00-${sidFc}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:00:00Z", type: "session_meta", payload: { id: sidFc, cwd: repo } },
    { timestamp: "2026-11-10T01:00:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: repo } },
    { timestamp: "2026-11-10T01:00:02Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: jsPatch } },
    {
      timestamp: "2026-11-10T01:00:03Z", type: "event_msg", payload: {
        type: "item_completed",
        item: {
          type: "FileChange",
          status: "completed",
          changes: {
            "a.txt": { type: "add", content: "one\ntwo\n" },
            "b.txt": { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n keep\n-old\n+new1\n+new2\n" },
            "c.txt": { type: "delete", content: "gone1\ngone2\ngone3\n" },
          },
        },
      },
    },
    { timestamp: "2026-11-10T01:00:04Z", type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } },
  ]));

  // Older rollout with ONLY JS-wrapped escaped-newline apply_patch and different Sol version (gpt-5.6-sol).
  const escapedPatch = 'const patch = "*** Begin Patch\\n*** Update File: old.js\\n@@\\n-a\\n-b\\n+c\\n*** End Patch"; tools.apply_patch(patch);';
  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-05-00-${sidPatch}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:05:00Z", type: "session_meta", payload: { id: sidPatch, cwd: repo } },
    { timestamp: "2026-11-10T01:05:01Z", type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: repo } },
    { timestamp: "2026-11-10T01:05:02Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c2", input: escapedPatch } },
    { timestamp: "2026-11-10T01:05:03Z", type: "token_usage_record", payload: { response_id: "r2", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } },
  ]));

  assert.equal(home.run("scan").code, 0);
  const dash = buildUsageRows(loadConfig(home.cfg));
  assert.deepEqual(dash.models, ["GPT Sol"]);

  const sFc = dash.sessions.find((s) => s.id === sidFc.slice(0, 8));
  const sPatch = dash.sessions.find((s) => s.id === sidPatch.slice(0, 8));
  // FileChange only: add 2 + update 2 = 4 added; delete 3 + update 1 = 4 removed (no double-counting jsPatch).
  assert.equal(sFc.la, 4);
  assert.equal(sFc.lr, 4);
  // Fallback patch only: +c = 1 added, -a -b = 2 removed.
  assert.equal(sPatch.la, 1);
  assert.equal(sPatch.lr, 2);

  // Cost uses exact model versions:
  // gpt-6.2-sol: 1000*2/1e6 + 100*10/1e6 = 0.003
  // gpt-5.6-sol: 1000*1/1e6 + 100*5/1e6 = 0.0015
  // Total = 0.0045 under single consolidated GPT Sol family.
  const byModel = JSON.parse(home.run("usage", "--since", "2026-11-10", "--until", "2026-11-10", "--by", "model", "--json").stdout);
  assert.equal(byModel.groups[0].rows.length, 1);
  assert.equal(byModel.groups[0].rows[0].key, "GPT Sol");
  assert.ok(Math.abs(byModel.groups[0].rows[0].c - 0.0045) < 1e-9);
});

test("codex resolves target project from repository_url on deleted temp cwds and from FileChange inside steering folders", () => {
  const home = makeCodexHome();
  const steering = join(home.dir, "steering");
  const appA = join(steering, "app-a");
  mkdirSync(join(steering, ".git"), { recursive: true });
  mkdirSync(join(appA, ".git"), { recursive: true });
  const sidUrl = "01a2172d-ef3f-7fa1-b51b-ca3045f10001";
  const sidSteer = "01a2172e-ef3f-7fa1-b51b-ca3045f10002";

  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-10-00-${sidUrl}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:10:00Z", type: "session_meta", payload: { id: sidUrl, cwd: "/tmp/nonexistent-sandbox/repo", git: { repository_url: "git@github.com:org/target-repo.git" } } },
    { timestamp: "2026-11-10T01:10:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: "/tmp/nonexistent-sandbox/repo" } },
    { timestamp: "2026-11-10T01:10:02Z", type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } },
  ]));

  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-11-00-${sidSteer}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:11:00Z", type: "session_meta", payload: { id: sidSteer, cwd: steering, git: { repository_url: "git@github.com:org/steering.git" } } },
    { timestamp: "2026-11-10T01:11:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: steering } },
    { timestamp: "2026-11-10T01:11:02Z", type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", status: "completed", changes: { [join(appA, "index.js")]: { type: "add", content: "x\n" } } } } },
    { timestamp: "2026-11-10T01:11:03Z", type: "token_usage_record", payload: { response_id: "r2", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } },
  ]));

  assert.equal(home.run("scan").code, 0);
  const dash = buildUsageRows(loadConfig(home.cfg));
  const byId = Object.fromEntries(dash.sessions.map((s) => [s.id, dash.projects[s.p]]));
  assert.equal(byId[sidUrl.slice(0, 8)], "target-repo");
  assert.equal(byId[sidSteer.slice(0, 8)], "app-a");
});

test("codex steering session resolves generic/temp clone origin via JS workdir vars and git -C without launch cwd inflation", () => {
  const home = makeCodexHome();
  const steering = join(home.dir, "steering");
  const cloneRepo = join(home.dir, "scratch", "repo");
  mkdirSync(join(steering, ".git"), { recursive: true });
  mkdirSync(join(cloneRepo, ".git"), { recursive: true });
  writeFileSync(join(cloneRepo, ".git", "config"), '[remote "origin"]\n\turl = git@ssh.example.com:team/real-app.git\n');

  const sidJs = "01a2172f-ef3f-7fa1-b51b-ca3045f10003";
  const jsCall = `const p = ${JSON.stringify(cloneRepo)};\ntext(await tools.exec_command({ workdir: p, cmd: "git status" }));`;
  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-12-00-${sidJs}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:12:00Z", type: "session_meta", payload: { id: sidJs, cwd: steering } },
    { timestamp: "2026-11-10T01:12:01Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: steering } },
    { timestamp: "2026-11-10T01:12:02Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: steering } },
    { timestamp: "2026-11-10T01:12:03Z", type: "turn_context", payload: { model: "gpt-6.2-sol", cwd: steering } },
    { timestamp: "2026-11-10T01:12:04Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: jsCall } },
    { timestamp: "2026-11-10T01:12:05Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c2", input: `git -C ${JSON.stringify(cloneRepo)} log -1` } },
    { timestamp: "2026-11-10T01:12:06Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c3", input: `git -C ${JSON.stringify(cloneRepo)} diff` } },
    { timestamp: "2026-11-10T01:12:07Z", type: "token_usage_record", payload: { response_id: "r3", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } },
  ]));

  assert.equal(home.run("scan").code, 0);
  const dash = buildUsageRows(loadConfig(home.cfg));
  assert.deepEqual(dash.projects, ["real-app"]);
});

test("codex backfills early guardian requests and tool calls from thread_settings_applied without overwriting later model switches, and parses object world_state models", () => {
  const home = makeCodexHome();
  const repo = join(home.dir, "work", "zeta");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const gId = "01a21730-ef3f-7fa1-b51b-ca3045f10004";
  const wsId = "01a21731-ef3f-7fa1-b51b-ca3045f10005";

  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-20-00-${gId}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:20:00Z", type: "session_meta", payload: { id: gId, source: { subagent: { other: "guardian" } }, cwd: repo } },
    { timestamp: "2026-11-10T01:20:01Z", type: "response_item", payload: { type: "function_call", name: "shell", call_id: "g_call_1", arguments: "{}" } },
    { timestamp: "2026-11-10T01:20:02Z", type: "token_usage_record", payload: { response_id: "g_r1", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } } },
    { timestamp: "2026-11-10T01:20:03Z", type: "compacted", payload: { message: "" } },
    { timestamp: "2026-11-10T01:20:04Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "codex-auto-review", reasoning_effort: "low" } } },
    { timestamp: "2026-11-10T01:20:05Z", type: "world_state", payload: { state: { model: "codex-auto-review" } } },
    { timestamp: "2026-11-10T01:21:00Z", type: "turn_context", payload: { model: "gpt-6.2-sol", effort: "high", cwd: repo } },
    { timestamp: "2026-11-10T01:21:01Z", type: "token_usage_record", payload: { response_id: "g_r2", usage: { input_tokens: 400, cached_input_tokens: 0, output_tokens: 20 } } },
  ]));

  writeFileSync(join(home.sessions, "2026", "11", "10", `rollout-2026-11-10T09-25-00-${wsId}.jsonl`), jsonl([
    { timestamp: "2026-11-10T01:25:00Z", type: "session_meta", payload: { id: wsId, cwd: repo } },
    { timestamp: "2026-11-10T01:25:01Z", type: "world_state", payload: { state: { model: { model: "gpt-5.6-luna", instructions: "hash" }, collaboration_mode: { mode: "default", model: "gpt-5.6-luna" } } } },
    { timestamp: "2026-11-10T01:25:02Z", type: "token_usage_record", payload: { response_id: "ws_r1", usage: { input_tokens: 600, cached_input_tokens: 100, output_tokens: 30 } } },
  ]));

  const scanRes = home.run("scan");
  assert.equal(scanRes.code, 0, scanRes.stderr);

  const db = new DatabaseSync(join(home.dir, "data", "usage.db"), { readOnly: true });
  const reqs = Object.fromEntries(db.prepare("SELECT message_id, model, family, effort FROM requests").all().map((r) => [r.message_id, r]));
  const call = db.prepare("SELECT model FROM tool_calls WHERE id = ?").get("codex:g_call_1");
  db.close();

  assert.equal(reqs["codex:g_r1"].model, "codex-auto-review");
  assert.equal(reqs["codex:g_r1"].family, "codex-auto-review");
  assert.equal(reqs["codex:g_r1"].effort, "low");
  assert.equal(call.model, "codex-auto-review");

  assert.equal(reqs["codex:g_r2"].model, "gpt-6.2-sol");
  assert.equal(reqs["codex:g_r2"].family, "sol");
  assert.equal(reqs["codex:g_r2"].effort, "high");

  assert.equal(reqs["codex:ws_r1"].model, "gpt-5.6-luna");
  assert.equal(reqs["codex:ws_r1"].family, "luna");
});
