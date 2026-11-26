// `make demo`: ten weeks of made-up multi-provider use (Claude Code, Codex and Antigravity) in a temp folder,
// scanned and served, for screenshots and trying the dashboard without real transcripts. The same seed gives the same data, dated back from today.
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { priceAt, readPrices, requestCost } from "../../src/prices.mjs";
import { assistant, compaction, cost, sid, user, writeTranscript } from "./build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.argv[2] ?? 4311);
const DAYS = 70;

// mulberry32: a small seeded generator with a long period.
let seed = 7;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (weighted) => { let r = rnd() * weighted.reduce((n, [, w]) => n + w, 0); for (const [v, w] of weighted) if ((r -= w) < 0) return v; return weighted[0][0]; };

const PROJECTS = [["atlas-web", 30], ["billing-api", 20], ["mobile-app", 15], ["data-pipeline", 10], ["design-system", 8], ["infra", 6], ["docs-site", 4], ["cli-tools", 3], ["sandbox", 2], ["playground", 2]];
const VERBS = ["Fix", "Add", "Refactor", "Speed up", "Test", "Document", "Migrate", "Debug", "Review", "Clean up", "Redesign", "Harden"];
const THINGS = ["the checkout flow", "invoice export", "auth middleware", "the search index", "dark mode", "the router", "API rate limits", "feature flags", "webhook retries",
  "the audit log", "build tooling", "offline drafts", "the billing cron", "usage alerts", "onboarding", "a memory leak", "release notes", "the settings page", "push notifications", "CSV import"];
const TOOLS = [["Bash", 30], ["Read", 22], ["Edit", 16], ["Grep", 9], ["Write", 5], ["Glob", 5], ["TodoWrite", 4], ["WebFetch", 3], ["WebSearch", 2]];
const SUBS = [["Explore", 45], ["general-purpose", 30], ["code-reviewer", 15], ["Plan", 10]];
const MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
// Skills by where they load from; they draw on their own generator so the rest of the data stays as it was.
const SKILLS = [["deploy", "project", 20], ["review-pr", "project", 14], ["release-notes", "project", 10], ["db-migrate", "project", 8], ["seed-data", "project", 2],
  ["perf-audit", "project", 1], ["commit-style", "personal", 9], ["standup", "personal", 6], ["changelog", "personal", 2], ["docs:pdf", "plugin", 4], ["docs:xlsx", "plugin", 3],
  ["code-review", "builtin", 6], ["simplify", "builtin", 5], ["loop", "builtin", 2]];
let seed2 = 11;
const rnd2 = () => { seed2 = (seed2 + 0x6d2b79f5) | 0; let t = Math.imul(seed2 ^ (seed2 >>> 15), 1 | seed2); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickSkill = () => { let r = rnd2() * SKILLS.reduce((n, x) => n + x[2], 0); for (const x of SKILLS) if ((r -= x[2]) < 0) return x; return SKILLS[0]; };
const skillDir = ([name, source], cwd) => ({ project: `${cwd}/.claude/skills/${name}`, personal: join(homedir(), ".claude", "skills", name),
  plugin: `/opt/claude/skills-plugin/demo/skills/${name.split(":")[1]}`, builtin: `/tmp/claude/bundled-skills/2.1.0/${name}` })[source];
const loadedFrom = (ts, dir, link) => user(ts, [{ type: "text", text: `Base directory for this skill: ${dir}` }], { isMeta: true, ...link });

// Turn some of the main thread's tool calls into skill calls, and start some sessions with a typed skill command.
function withSkills(recs, cwd) {
  const out = [];
  if (rnd2() < 0.35) {
    const skill = pickSkill(), ts = recs[0].timestamp;
    const typed = user(ts, `<command-message>${skill[0]}</command-message>\n<command-name>/${skill[0]}</command-name>`, { cwd });
    out.push(typed, loadedFrom(ts, skillDir(skill, cwd), { parentUuid: typed.uuid, cwd }));
  }
  let pending = null;
  for (const r of recs) {
    const use = r.type === "assistant" && r.message.content[0]?.type === "tool_use" && r.message.content[0].name !== "Task" ? r.message.content[0] : null;
    if (use && rnd2() < 0.035) { pending = pickSkill(); use.name = "Skill"; use.input = { skill: pending[0] }; pending = [pending, use.id]; }
    out.push(r);
    if (pending && r.type === "user" && r.message.content[0]?.tool_use_id === pending[1]) {
      out.push(loadedFrom(r.timestamp, skillDir(pending[0], cwd), { sourceToolUseID: pending[1], cwd }));
      pending = null;
    }
  }
  return out;
}

const home = mkdtempSync(join(tmpdir(), "llmtop-demo-"));
const transcripts = join(home, "projects");
const codexRoot = join(home, "codex");
const codexSessions = join(codexRoot, "sessions");
const agyRoot = join(home, "agy");
mkdirSync(codexSessions, { recursive: true });
mkdirSync(join(agyRoot, "brain"), { recursive: true });
const configPath = join(home, "llmtop.config.json");
writeFileSync(configPath, JSON.stringify({
  providers: {
    claude: { transcripts },
    codex: { transcripts: codexSessions },
    agy: { transcripts: agyRoot },
  },
  data: join(home, "data"),
  port: PORT,
}));
const prices = readPrices({ prices: join(ROOT, "prices.md") }).rows;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

let k = 0, ids = 0;
const msgId = () => `msg_demo_${++ids}`;
const toolId = () => `toolu_demo_${++ids}`;

// One thread of requests: the context grows, the cache is rewritten at the start, after a compaction, after an idle gap
// longer than the cache lives, and now and then for no visible reason.
function thread({ t, model, effort, longCache, turns, cwd, owner, onTask }) {
  const recs = [], usage = {};
  let ctx = 0, last = null;
  const add = (m, u) => { const day = new Date(t).toISOString().slice(0, 10), p = priceAt(prices, m, day)?.p; const x = (usage[m] ??= { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0 });
    const w1 = u.cache_creation.ephemeral_1h_input_tokens;
    x.inputTokens += u.input_tokens; x.outputTokens += u.output_tokens; x.cacheReadInputTokens += u.cache_read_input_tokens; x.cacheCreationInputTokens += u.cache_creation_input_tokens;
    x.cacheCreationEphemeral1hInputTokens += w1; x.cacheCreationEphemeral5mInputTokens += u.cache_creation_input_tokens - w1;
    if (p) x.costUSD += requestCost(p, { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens, cache_write_1h: w1 }); };
  const life = longCache ? 3600e3 : 300e3;
  let api = 0, tool = 0, edits = 0;
  for (let turn = 0; turn < turns; turn++) {
    if (turn) t += (owner ? pick([[int(20, 240), 88], [int(400, 840), 6], [int(1200, 3000), 1], [int(4200, 10800), 5]]) : int(5, 30)) * 1000;
    if (owner) recs.push(user(new Date(t).toISOString(), owner(turn), { cwd }));
    const steps = int(2, 9);
    for (let s = 0; s < steps; s++) {
      if (ctx > 150000) {
        // The request that writes the summary leaves no record of its own; only the host's totals carry it.
        const w = int(6000, 12000);
        add(model, { input_tokens: int(3000, 4500), output_tokens: int(6000, 11000), cache_read_input_tokens: ctx, cache_creation_input_tokens: w,
          cache_creation: { ephemeral_5m_input_tokens: longCache ? 0 : w, ephemeral_1h_input_tokens: longCache ? w : 0 } });
        const pre = ctx, wait = int(40, 110);
        ctx = int(18000, 30000); last = null;
        recs.push(...compaction(new Date(t).toISOString(), { trigger: rnd() < 0.05 ? "manual" : "auto", pre, post: ctx, ms: wait * 1000, cwd, sidechain: !owner }));
        t += wait * 1000;
      }
      const grow = int(800, 3500), rebuild = last === null || t - last > life || rnd() < 0.004;
      const write = rebuild ? ctx + grow + (ctx ? 0 : int(12000, 20000)) : grow;
      ctx = rebuild ? write : ctx + grow;
      const out = int(150, 2600), u = { input_tokens: int(1, 40), output_tokens: out, cache_read_input_tokens: rebuild ? 0 : ctx - grow, cache_creation_input_tokens: write,
        cache_creation: { ephemeral_5m_input_tokens: longCache ? 0 : write, ephemeral_1h_input_tokens: longCache ? write : 0 }, output_tokens_details: { thinking_tokens: Math.round(out * (0.15 + rnd() * 0.4)) } };
      const name = s < steps - 1 ? (onTask && rnd() < 0.03 ? "Task" : pick(TOOLS)) : null, id = name && toolId();
      recs.push(assistant(new Date(t).toISOString(), msgId(), u, { model, content: name ? [{ type: "tool_use", id, name, input: {} }] : [{ type: "text", text: "Done." }], rec: { cwd, effort: effort(turn), isSidechain: !owner } }));
      add(model, u); api += out / 80; last = t;
      if (name) {
        const took = name === "Task" ? onTask(t, id) : int(1, 25);
        if (name === "Edit" || name === "Write") edits++;
        t += took * 1000; tool += took;
        recs.push(user(new Date(t).toISOString(), [{ type: "tool_result", tool_use_id: id, is_error: rnd() < 0.03 }], { cwd, toolUseResult: {}, isSidechain: !owner }));
      }
      t += int(4, 40) * 1000;
    }
  }
  return { recs, t, usage, api, tool, edits };
}

const CODEX_TOOLS = [["exec", 42], ["read_file", 24], ["apply_patch", 20], ["grep", 14]];
const AGY_TOOLS = [["run_command", 34], ["read_file", 30], ["edit_file", 24], ["grep_search", 12]];
const AGY_SUB_AGENTS = [["research", 60], ["self", 40]];
const codexIndex = [];
const agySummaries = [];

function writeCodexRollout(sessionId, ts, rows) {
  const iso = new Date(ts).toISOString();
  const dir = join(codexSessions, iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
  mkdirSync(dir, { recursive: true });
  const stamp = iso.slice(0, 19).replace(/:/g, "-");
  writeFileSync(join(dir, `rollout-${stamp}-${sessionId}.jsonl`), jsonl(rows));
}

function buildCodexSession(startMs, cwd, title) {
  const session = sid(++k);
  const model = pick([["gpt-6.2-sol", 56], ["gpt-6.2-astra", 24], ["gpt-6-luna", 20]]);
  const levels = [pick([["high", 55], ["xhigh", 25], ["medium", 20]]), pick([["xhigh", 45], ["high", 35], ["medium", 20]])];
  const switchAt = rnd() < 0.15 ? int(2, 5) : Infinity;
  const rows = [{ timestamp: new Date(startMs).toISOString(), type: "session_meta", payload: { id: session, cwd, timestamp: new Date(startMs).toISOString() } }];
  let t = startMs + 1000, ctx = 0, last = null, callSeq = 0, respSeq = 0;
  const turns = int(3, 12);
  let curEffort = "";

  const pushSubagent = (t0, role) => {
    const subId = sid(++k);
    const subModel = role === "Explore" ? pick([["gpt-6-luna", 65], ["gpt-6.2-sol", 35]]) : pick([["gpt-6.2-sol", 75], ["gpt-6.2-astra", 25]]);
    const subRows = [
      { timestamp: new Date(t0).toISOString(), type: "session_meta", payload: { id: subId, parent_thread_id: session, source: { subagent: { other: role } }, cwd } },
      { timestamp: new Date(t0 + 500).toISOString(), type: "turn_context", payload: { model: subModel, effort: "medium", cwd } },
      { timestamp: new Date(t0 + 1000).toISOString(), type: "event_msg", payload: { type: "task_started" } },
    ];
    let st = t0 + 1500, sctx = 0;
    const subSteps = int(1, 3);
    for (let s = 0; s < subSteps; s++) {
      const uncached = s === 0 ? int(20000, 26000) : int(600, 1800);
      const out = int(150, 900);
      st += Math.max(1500, Math.round(out / 0.08));
      subRows.push({
        timestamp: new Date(st).toISOString(),
        type: "token_usage_record",
        payload: {
          response_id: `sub_resp_${++ids}`,
          usage: { input_tokens: uncached + sctx, cached_input_tokens: sctx, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: Math.round(out * 0.25) },
        },
      });
      sctx += uncached;
    }
    subRows.push({ timestamp: new Date(st + 200).toISOString(), type: "event_msg", payload: { type: "task_complete", duration_ms: st - t0 } });
    writeCodexRollout(subId, t0, subRows);
    return st - t0;
  };

  for (let turn = 0; turn < turns; turn++) {
    if (turn) t += pick([[int(25, 210), 84], [int(380, 780), 9], [int(1200, 2600), 2], [int(4200, 9600), 5]]) * 1000;
    const effort = turn >= switchAt ? levels[1] : levels[0];
    if (effort !== curEffort) {
      rows.push({ timestamp: new Date(t).toISOString(), type: "turn_context", payload: { model, effort, cwd } });
      curEffort = effort;
      t += 500;
    }
    const turnStart = t;
    rows.push({ timestamp: new Date(t).toISOString(), type: "event_msg", payload: { type: "task_started" } });
    rows.push({ timestamp: new Date(t + 200).toISOString(), type: "event_msg", payload: { type: "user_message", message: turn ? "Continue with the next step" : title } });
    t += 1000;
    const steps = int(2, 6);
    for (let s = 0; s < steps; s++) {
      if (ctx > 140000) {
        ctx = int(20000, 32000); last = null;
        rows.push({ timestamp: new Date(t).toISOString(), type: "compacted", payload: { message: "" } });
        t += int(20, 60) * 1000;
      }
      const grow = int(700, 2800), rebuild = last === null || t - last > 300e3 || rnd() < 0.006;
      const uncached = rebuild ? Math.max(21000, ctx + grow) : grow;
      const cached = rebuild ? 0 : ctx;
      ctx = uncached + cached;
      const out = int(180, 2200), apiMs = Math.max(1500, Math.round(out / (0.065 + rnd() * 0.03)));
      t += apiMs;
      rows.push({
        timestamp: new Date(t).toISOString(),
        type: "token_usage_record",
        payload: {
          response_id: `resp_${session.slice(0, 8)}_${++respSeq}`,
          usage: { input_tokens: uncached + cached, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: Math.round(out * (0.2 + rnd() * 0.35)) },
        },
      });
      last = t;
      if (s < steps - 1) {
        const name = pick(CODEX_TOOLS), callId = `call_${session.slice(0, 8)}_${++callSeq}`;
        const failed = rnd() < 0.03;
        const toolMs = int(1, 14) * 1000;
        if (name === "apply_patch") {
          const added = int(4, 28), removed = int(1, 12);
          rows.push({ timestamp: new Date(t + 200).toISOString(), type: "response_item", payload: { type: "custom_tool_call", name, call_id: callId, input: "" } });
          if (!failed) {
            rows.push({
              timestamp: new Date(t + toolMs).toISOString(),
              type: "event_msg",
              payload: { type: "item_completed", item: { type: "FileChange", status: "completed", changes: { "src/app.ts": { type: "add", content: "x\n".repeat(added) }, "src/old.ts": { type: "delete", content: "y\n".repeat(removed) } } } },
            });
          }
          rows.push({
            timestamp: new Date(t + toolMs).toISOString(),
            type: "response_item",
            payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: `${failed ? "Script failed" : "Script completed"}\nWall time ${(toolMs / 1000).toFixed(1)} seconds` }] },
          });
        } else {
          rows.push({ timestamp: new Date(t + 200).toISOString(), type: "response_item", payload: { type: "function_call", name, call_id: callId, arguments: "{}" } });
          rows.push({
            timestamp: new Date(t + toolMs).toISOString(),
            type: "response_item",
            payload: { type: "function_call_output", call_id: callId, output: [{ type: "input_text", text: `${failed ? "Exit code: 1\nfailed" : "Script completed"}\nWall time ${(toolMs / 1000).toFixed(1)} seconds\nOutput:\nok` }] },
          });
          if (!failed && rnd() < 0.14) t += pushSubagent(t + 500, pick(SUBS));
        }
        t += toolMs + 1000;
      }
    }
    rows.push({ timestamp: new Date(t).toISOString(), type: "event_msg", payload: { type: "task_complete", duration_ms: t - turnStart } });
  }
  writeCodexRollout(session, startMs, rows);
  codexIndex.push({ id: session, thread_name: title, updated_at: new Date(t).toISOString() });
}

function buildAgySession(startMs, cwd, title) {
  const convId = sid(++k);
  const baseModel = pick([["gemini-4-neon", 68], ["gemini-4-hydrogen", 32]]);
  const effort = pick([["high", 55], ["xhigh", 25], ["medium", 20]]);
  const model = `${baseModel}-${effort}`;
  const rows = [];
  let t = startMs, ctx = 0, last = null, step = 0;
  const uri = pathToFileURL(cwd).href;
  const turns = int(3, 10);

  const pushSubagent = (t0, agentName) => {
    const subId = sid(++k);
    const subModel = agentName === "research" ? "gemini-4-hydrogen-medium" : "gemini-4-neon-high";
    const subRows = [];
    let st = t0, sctx = 0;
    const subSteps = int(2, 4);
    for (let s = 0; s < subSteps; s++) {
      const uncached = s === 0 ? int(20000, 25000) : int(600, 1500);
      const out = int(120, 700);
      st += Math.max(1500, Math.round(out / 0.085));
      subRows.push({
        step_index: s,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: new Date(st).toISOString(),
        model: subModel,
        input_tokens: uncached,
        cache_read_tokens: sctx,
        output_tokens: out,
        tool_calls: s < subSteps - 1 ? [{ name: "read_file", args: {} }] : [],
      });
      sctx += uncached;
    }
    const dir = join(agyRoot, "brain", subId, ".system_generated", "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript.jsonl"), jsonl(subRows));
    agySummaries.push({ id: subId, title: `${agentName} task`, uri, parent: convId, agent: agentName });
  };

  for (let turn = 0; turn < turns; turn++) {
    if (turn) t += pick([[int(25, 190), 84], [int(380, 780), 9], [int(1200, 2400), 2], [int(4200, 8400), 5]]) * 1000;
    rows.push({ step_index: step++, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: new Date(t).toISOString(), content: turn ? "Continue with the next step" : title });
    const steps = int(2, 5);
    for (let s = 0; s < steps; s++) {
      const grow = int(650, 2400), rebuild = last === null || t - last > 300e3 || rnd() < 0.008;
      const uncached = rebuild ? Math.max(21000, ctx + grow) : grow;
      const cached = rebuild ? 0 : ctx;
      ctx = uncached + cached;
      const out = int(160, 1900), apiMs = Math.max(1500, Math.round(out / (0.075 + rnd() * 0.025)));
      t += apiMs;
      const toolCalls = [];
      if (s < steps - 1) {
        const name = pick(AGY_TOOLS);
        if (name === "edit_file") {
          const rm = int(1, 8), add = int(3, 18);
          toolCalls.push({ name, args: { Target: JSON.stringify("line\n".repeat(rm).trim()), Replacement: JSON.stringify("next\n".repeat(add).trim()) } });
        } else {
          toolCalls.push({ name, args: {} });
        }
      }
      rows.push({
        step_index: step++,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: new Date(t).toISOString(),
        model,
        input_tokens: uncached,
        cache_read_tokens: cached,
        output_tokens: out,
        tool_calls: toolCalls,
      });
      last = t;
      if (toolCalls.length) {
        t += int(1, 6) * 1000;
        const failed = rnd() < 0.03;
        rows.push({ step_index: step++, source: "SYSTEM", type: "GENERIC", status: failed ? "ERROR" : "DONE", created_at: new Date(t).toISOString(), content: failed ? "Command exited with code 1" : "ok" });
        if (!failed && rnd() < 0.16) pushSubagent(t + 500, pick(AGY_SUB_AGENTS));
      }
    }
  }
  const dir = join(agyRoot, "brain", convId, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transcript.jsonl"), jsonl(rows));
  agySummaries.push({ id: convId, title, uri, parent: "", agent: "" });
}

for (let d = DAYS - 1; d >= 0; d--) {
  const date = new Date(); date.setDate(date.getDate() - d);
  const weekend = date.getDay() === 0 || date.getDay() === 6, ramp = 0.35 + 0.65 * (1 - d / DAYS);
  const sessions = Math.round((weekend ? int(0, 2) : int(3, 7)) * ramp + (rnd() < ramp ? 1 : 0));
  for (let n = 0; n < sessions; n++) {
    const project = pick(PROJECTS), cwd = `/work/${project}`;
    const start = new Date(date); start.setHours(pick([[9, 2], [10, 4], [11, 4], [13, 2], [14, 4], [15, 4], [16, 3], [17, 2], [20, 1], [21, 2], [22, 1]]), int(0, 59), int(0, 59), 0);
    const title = `${VERBS[int(0, VERBS.length - 1)]} ${THINGS[int(0, THINGS.length - 1)]}`;
    const provider = pick([["claude", 52], ["codex", 32], ["agy", 16]]);
    if (provider === "codex") { buildCodexSession(start.getTime(), cwd, title); continue; }
    if (provider === "agy") { buildAgySession(start.getTime(), cwd, title); continue; }

    const session = sid(++k), slug = `-work-${project}`;
    const main = MODELS[pick([["opus", 76], ["sonnet", 20], ["haiku", 4]])], levels = [pick([["high", 60], ["xhigh", 25], ["medium", 15]]), pick([["xhigh", 50], ["high", 30], ["low", 20]])];
    const switchAt = rnd() < 0.2 ? int(2, 8) : Infinity;
    let subTool = 0;
    const onTask = (t, toolUseId) => {
      const agent = `demo${++ids}`, type = pick(SUBS);
      const r = thread({ t, model: MODELS[type === "Explore" ? pick([["haiku", 50], ["sonnet", 50]]) : pick([["sonnet", 70], ["opus", 30]])], effort: () => "medium", longCache: false, turns: int(1, 3), cwd });
      writeTranscript(transcripts, slug, session, r.recs, { agent });
      writeFileSync(join(transcripts, slug, session, "subagents", `agent-${agent}.meta.json`), JSON.stringify({ agentType: type, toolUseId }));
      for (const [m, u] of Object.entries(r.usage)) Object.assign(usageAll[m] ??= { costUSD: 0 }, Object.fromEntries(Object.entries(u).map(([key, v]) => [key, (usageAll[m]?.[key] ?? 0) + v])));
      subTool += r.api;
      return Math.round((r.t - t) / 1000);
    };
    const usageAll = {};
    const r = thread({ t: start.getTime(), model: main, effort: (turn) => (turn >= switchAt ? levels[1] : levels[0]), longCache: rnd() < 0.3, turns: int(3, 26), cwd,
      owner: (turn) => (turn ? "Continue with the next step" : "Let's work on this"), onTask });
    for (const [m, u] of Object.entries(r.usage)) Object.assign(usageAll[m] ??= { costUSD: 0 }, Object.fromEntries(Object.entries(u).map(([key, v]) => [key, (usageAll[m]?.[key] ?? 0) + v])));
    // Every third session searched the web: Claude Code runs Haiku in the background for it and writes no request to the transcript.
    if (k % 3 === 0) {
      const searches = (k % 5) + 1, u = { inputTokens: 9000 * searches, outputTokens: 700 * searches, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: searches };
      const h = (usageAll[MODELS.haiku] ??= { costUSD: 0 });
      for (const [key, v] of Object.entries(u)) h[key] = (h[key] ?? 0) + v;
      h.costUSD += (u.inputTokens * 0.1 + u.outputTokens * 0.5) / 1e6 + searches * 0.01;
    }
    const total = Object.values(usageAll).reduce((n, u) => n + u.costUSD, 0);
    const end = { ...cost(total, { startTime: start.getTime(), modelUsage: usageAll }), totalAPIDuration: Math.round((r.api + subTool) * 1000), totalToolDuration: Math.round(r.tool * 1000),
      totalLinesAdded: r.edits * int(15, 70), totalLinesRemoved: r.edits * int(2, 14), sessionId: session };
    writeTranscript(transcripts, slug, session, [...withSkills(r.recs, cwd), { type: "ai-title", aiTitle: title, sessionId: session }, end]);
  }
}

writeFileSync(join(codexRoot, "session_index.jsonl"), jsonl(codexIndex));
const sumDb = new DatabaseSync(join(agyRoot, "conversation_summaries.db"));
sumDb.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT, agent_name TEXT);");
sumDb.exec("CREATE TABLE conversation_parents(conversation_id TEXT PRIMARY KEY, parent_id TEXT);");
const insSum = sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)");
for (const s of agySummaries) insSum.run(s.id, s.title, JSON.stringify([s.uri]), s.parent, s.agent);
sumDb.close();

const env = { ...process.env, LLMTOP_CONFIG: configPath };
spawnSync(process.execPath, [join(ROOT, "bin", "llmtop.mjs"), "scan"], { env, stdio: "inherit" });
spawn(process.execPath, [join(ROOT, "bin", "llmtop.mjs"), "serve"], { env, stdio: "inherit" });
