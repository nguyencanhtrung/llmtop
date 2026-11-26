// Everything that knows the Codex CLI/IDE rollout format under ~/.codex/sessions and session_index.jsonl.
// Token counts in Codex include cached_input_tokens inside input_tokens, so uncached input is input - cached - write.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { copyOther } from "../archive.mjs";
import { createPathTracker, extractCommandDirs, isAbsPath } from "../paths.mjs";
import { zoner } from "../zone.mjs";

export const defaultPath = "~/.codex/sessions";
export const label = "Codex";

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const list = (p) => (isDir(p) ? readdirSync(p, { withFileTypes: true }) : []);

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export function describe(rel) {
  if (!rel.endsWith(".jsonl")) return null;
  const parts = rel.split(sep);
  const m = rel.match(UUID_TAIL);
  const sessionId = m ? m[1] : basename(rel, ".jsonl");
  return { rel, kind: "main", slug: parts[0] || "codex", sessionId, agentId: null };
}

export function listHost(root) {
  const transcripts = [];
  const walk = (dir) => {
    for (const e of list(dir)) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const d = describe(relative(root, abs));
        if (d) transcripts.push(d);
      }
    }
  };
  walk(root);
  return { transcripts, others: [] };
}

// Copy session_index.jsonl (sibling of sessions/) into the archive so titles survive host deletion.
export function syncMeta(root, archiveDir) {
  const idx = join(dirname(root), "session_index.jsonl");
  if (!existsSync(idx)) return 0;
  return copyOther(idx, join(archiveDir, "session_index.jsonl")) ? 1 : 0;
}

const CODEX_FAMILY_NAMES = {
  sol: "GPT Sol",
  luna: "GPT Luna",
  astra: "GPT Astra",
  terra: "GPT Terra",
  codex: "GPT Codex",
  "codex-mini": "GPT Codex Mini",
  "codex-max": "GPT Codex Max",
  "codex-auto-review": "Codex Review",
  mini: "GPT Mini",
  nano: "GPT Nano",
  pro: "GPT Pro",
};

export function familyOf(model) {
  const clean = model.replace(/\[.*\]$/, "").replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  const m = clean.match(/^gpt-[\d.]+-([a-z][a-z0-9-]*)$/i);
  if (m) return m[1].toLowerCase();
  return clean;
}

export function displayModel(family) {
  if (CODEX_FAMILY_NAMES[family]) return CODEX_FAMILY_NAMES[family];
  const v = family.match(/^gpt-([\d.]+)$/i);
  if (v) return `GPT-${v[1]}`;
  return family;
}

const HARNESS_PREFIXES = ["<environment_context>", "<permissions instructions>", "<INSTRUCTIONS>", "<collaboration_mode>", "<turn_aborted>", "<subagent_notification>", "# AGENTS.md"];
function userMessageText(content) {
  const blocks = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === "input_text" || b?.type === "text").map((b) => b.text ?? "") : [];
  const kept = blocks.map((s) => s.trim()).filter((t) => t && !HARNESS_PREFIXES.some((p) => t.startsWith(p)));
  return kept.length ? kept.join("\n\n") : null;
}

function subagentTypeOf(source) {
  const s = source?.subagent;
  if (!s) return null;
  if (typeof s === "string") return s;
  if (s.other) return s.other;
  if (s.thread_spawn?.agent_role) return s.thread_spawn.agent_role;
  const k = Object.keys(s)[0];
  return k ?? "subagent";
}

function toolOutputText(payload) {
  const out = payload?.output;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return out.map((b) => (typeof b === "string" ? b : b?.text ?? "")).filter(Boolean).join("\n");
  return "";
}

function isToolError(payload, text) {
  if (payload?.is_error) return true;
  if (payload?.status === "error" || payload?.status === "failed") return true;
  if (/^Exit code:\s*[1-9]\d*/m.test(text)) return true;
  if (/^(?:Script failed|Tool call failed|Patch failed|Verification failed|Error:|Process exited with code [1-9]\d*)/m.test(text)) return true;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.metadata?.exit_code === "number" && parsed.metadata.exit_code !== 0) return true;
      if (parsed?.error || parsed?.is_error) return true;
    } catch { /* plain text output */ }
  }
  return false;
}

const WALL_TIME_RE = /\bWall time:?\s+([\d.]+)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)\b/i;
function parseToolDurationMs(text, callStartMs, outputTsMs) {
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const ms = parsed?.metadata?.duration_ms;
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
      const sec = parsed?.metadata?.duration_seconds;
      if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
    } catch { /* ignore */ }
  }
  const m = text.match(WALL_TIME_RE);
  if (m) {
    const val = Number(m[1]);
    if (Number.isFinite(val) && val >= 0) {
      const unit = m[2].toLowerCase();
      if (unit.startsWith("ms") || unit.startsWith("milli")) return Math.round(val);
      if (unit.startsWith("m")) return Math.round(val * 60_000);
      return Math.round(val * 1000);
    }
  }
  if (callStartMs !== null && Number.isFinite(outputTsMs)) {
    const dt = outputTsMs - callStartMs;
    if (dt >= 0 && dt < 600_000) return Math.round(dt);
  }
  return 0;
}

function callInputText(payload) {
  const parts = [];
  for (const raw of [payload?.input, payload?.arguments]) {
    if (typeof raw === "string" && raw) {
      parts.push(raw);
      if (raw.trimStart().startsWith("{")) {
        try {
          const o = JSON.parse(raw);
          for (const k of ["cmd", "command", "patch", "input", "path", "file_path", "target_file"]) {
            if (typeof o?.[k] === "string") parts.push(o[k]);
          }
        } catch { /* ignore */ }
      }
    } else if (raw && typeof raw === "object") {
      for (const v of Object.values(raw)) if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join("\n");
}

const lineCount = (s) => (s ? s.replace(/\n$/, "").split("\n").length : 0);

function countUnifiedDiff(diff) {
  let added = 0;
  let removed = 0;
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith("+++ ") || l.startsWith("--- ") || l.startsWith("@@")) continue;
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}

function countPatchLines(text) {
  if (!text.includes("*** Begin Patch")) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  const unesc = text.includes("*** Begin Patch\\n") ? text.replace(/\\n/g, "\n") : text;
  const re = /\*\*\* Begin Patch\r?\n([\s\S]*?)\*\*\* End Patch/g;
  let m;
  while ((m = re.exec(unesc)) !== null) {
    for (const line of m[1].split(/\r?\n/)) {
      if (line.startsWith("*** ") || line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

const SKILL_PATH_RE = /([^\s"'`<>()\\]*?skills\/([a-z0-9][a-z0-9._-]{0,63})\/SKILL\.md)\b/gi;
const SKILL_DOLLAR_RE = /(?:^|[\s(`"'])\$([a-z][a-z0-9_-]{1,63})\b/g;
function skillSourceOf(path) {
  if (/\/builtin\/skills\//i.test(path)) return "builtin";
  if (/^~\/|\/(?:home|Users)\/[^/]+\/\.(?:agents|codex|claude|gemini)\//i.test(path)) return "personal";
  return "project";
}

function extractSkillPaths(text) {
  const seen = new Map();
  SKILL_PATH_RE.lastIndex = 0;
  let m;
  while ((m = SKILL_PATH_RE.exec(text)) !== null) {
    const name = m[2].toLowerCase();
    if (!seen.has(name)) seen.set(name, skillSourceOf(m[1]));
  }
  return [...seen.entries()];
}

function extractDollarSkills(text) {
  const seen = new Set();
  SKILL_DOLLAR_RE.lastIndex = 0;
  let m;
  while ((m = SKILL_DOLLAR_RE.exec(text)) !== null) seen.add(m[1]);
  return [...seen];
}

export function createIngester(db, timeZone) {
  const zone = zoner(timeZone);
  const q = {
    record: db.prepare("INSERT OR IGNORE INTO records(uuid, file_id, line, type, ts) VALUES (?, ?, ?, ?, ?)"),
    request: db.prepare(`INSERT OR IGNORE INTO requests(message_id, file_id, line, session_id, agent_id, ts, day, hour, model, family,
      effort, is_sub, input, output, thinking, cache_read, cache_write, cache_write_1h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    owner: db.prepare("INSERT OR IGNORE INTO owner_messages(uuid, file_id, line, session_id, ts, kind, text) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    call: db.prepare("INSERT OR IGNORE INTO tool_calls(id, file_id, line, session_id, agent_id, ts, name, model, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"),
    result: db.prepare("UPDATE tool_calls SET is_error = ? WHERE id = ?"),
    skill: db.prepare("INSERT OR IGNORE INTO skills(id, file_id, line, session_id, ts, name, via, source, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    skillErr: db.prepare("UPDATE skills SET is_error = 1 WHERE id = ?"),
    compaction: db.prepare(`INSERT OR IGNORE INTO compactions(uuid, file_id, line, session_id, agent_id, ts, trigger, pre_tokens, post_tokens, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    fileMeta: db.prepare(`INSERT INTO file_meta(file_id, parent_session_id, subagent_type, tool_use_id, repo_url) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        parent_session_id = COALESCE(excluded.parent_session_id, file_meta.parent_session_id),
        subagent_type = COALESCE(excluded.subagent_type, file_meta.subagent_type),
        tool_use_id = COALESCE(excluded.tool_use_id, file_meta.tool_use_id),
        repo_url = COALESCE(excluded.repo_url, file_meta.repo_url)`),
    getStats: db.prepare("SELECT api_ms, tool_ms, lines_added, lines_removed, target_paths FROM file_meta WHERE file_id = ?"),
    upsertStats: db.prepare(`INSERT INTO file_meta(file_id, api_ms, tool_ms, lines_added, lines_removed) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET api_ms = excluded.api_ms, tool_ms = excluded.tool_ms,
        lines_added = excluded.lines_added, lines_removed = excluded.lines_removed`),
    upsertTargetPaths: db.prepare(`INSERT INTO file_meta(file_id, target_paths) VALUES (?, ?)
      ON CONFLICT(file_id) DO UPDATE SET target_paths = excluded.target_paths`),
  };
  const stateByFile = new Map();

  return function ingestLine(file, line, text) {
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      return { added: 0 };
    }
    if (!rec || typeof rec !== "object") return { added: 0 };
    let st = stateByFile.get(file.id);
    if (!st) {
      const prevStats = file.lines > 0 ? q.getStats.get(file.id) : null;
      st = {
        launchCwd: file.cwd ?? null,
        cwd: file.cwd ?? null,
        model: null, effort: null, sawTokenRec: false, lastTotal: null, lastCompactionLine: -999,
        callStart: new Map(), callSkills: new Map(),
        turnStartMs: null, turnToolMs: 0, openApiMs: 0, lastWaitFromMs: null,
        completedApiMs: prevStats?.api_ms ?? 0, toolMs: prevStats?.tool_ms ?? 0,
        baseAdded: prevStats?.lines_added ?? 0, baseRemoved: prevStats?.lines_removed ?? 0,
        sawFileChange: false, fcAdded: 0, fcRemoved: 0, patchAdded: 0, patchRemoved: 0,
        paths: createPathTracker(prevStats?.target_paths ?? null),
      };
      stateByFile.set(file.id, st);
    }
    const ownId = file.agent_id ?? file.session_id;
    const session = file.session_id;
    const agent = file.agent_id;
    const isSub = file.kind === "sub" ? 1 : 0;
    const p = rec.payload ?? {};
    const ts = rec.timestamp ?? p.timestamp ?? null;
    const parsedTs = ts ? Date.parse(ts) : NaN;
    const tsMs = Number.isFinite(parsedTs) ? parsedTs : null;
    let cwd = p.cwd ?? null;
    let added = 0;
    let statsDirty = false;
    let pathsDirty = false;

    const consumeOpenWait = () => {
      if (tsMs !== null && st.lastWaitFromMs !== null) {
        const dt = tsMs - st.lastWaitFromMs;
        if (dt > 0 && dt < 600_000) {
          st.openApiMs += dt;
          statsDirty = true;
        }
        st.lastWaitFromMs = null;
      }
    };
    const recordDollarSkills = (body) => {
      for (const name of extractDollarSkills(body)) {
        q.skill.run(`codex:${ownId}:${line}:cmd:${name}`, file.id, line, session, ts, name, "command", null, 0);
      }
    };

    const recordUsage = (msgId, u) => {
      if (!ts || !u) return false;
      const cacheRead = u.cached_input_tokens ?? 0;
      const cacheWrite = u.cache_write_input_tokens ?? 0;
      const input = Math.max(0, (u.input_tokens ?? 0) - cacheRead - cacheWrite);
      const output = u.output_tokens ?? 0;
      const thinking = u.reasoning_output_tokens ?? 0;
      if (!input && !output && !cacheRead && !cacheWrite) return false;
      const model = st.model ?? "unknown";
      const { day, hour } = zone(ts);
      q.record.run(`codex:${ownId}:${line}`, file.id, line, rec.type, ts);
      q.request.run(msgId, file.id, line, session, agent, ts, day, hour, model, familyOf(model), st.effort ?? null, isSub,
        input, output, thinking, cacheRead, cacheWrite, cacheWrite ? 0 : null);
      return true;
    };

    if (rec.type === "session_meta") {
      if (p.cwd) {
        st.launchCwd ??= p.cwd;
        st.cwd = p.cwd;
      }
      const subType = subagentTypeOf(p.source);
      const metaSub = p.parent_thread_id || subType ? (subType ?? "subagent") : null;
      const repoUrl = p.git?.repository_url ?? null;
      if (metaSub || repoUrl) q.fileMeta.run(file.id, p.parent_thread_id ?? null, metaSub, null, repoUrl);
      if (p.model) st.model = p.model;
    } else if (rec.type === "turn_context") {
      if (p.cwd) {
        st.launchCwd ??= p.cwd;
        st.cwd = p.cwd;
        if (p.cwd !== st.launchCwd && st.paths.add(p.cwd, { write: false })) pathsDirty = true;
      }
      if (p.model) st.model = p.model;
      const eff = p.effort ?? p.collaboration_mode?.settings?.reasoning_effort;
      if (eff) st.effort = eff;
    } else if (rec.type === "world_state") {
      if (p.state?.model) st.model = p.state.model;
      if (p.state?.effort) st.effort = p.state.effort;
    } else if (rec.type === "token_usage_record") {
      consumeOpenWait();
      st.sawTokenRec = true;
      const msgId = `codex:${p.response_id || `${ownId}:${line}`}`;
      if (recordUsage(msgId, p.usage)) added = 1;
    } else if (rec.type === "compacted") {
      if (line - st.lastCompactionLine > 5) {
        st.lastCompactionLine = line;
        q.record.run(`codex:${ownId}:${line}`, file.id, line, rec.type, ts);
        q.compaction.run(`codex:${ownId}:${line}`, file.id, line, session, agent, ts, "auto", null, null, null);
        added = 1;
      }
    } else if (rec.type === "response_item") {
      if (p.type === "configuration_update" && p.reasoning?.effort) {
        st.effort = p.reasoning.effort;
      } else if (p.type === "message" && p.role === "user") {
        const msg = userMessageText(p.content);
        if (msg) {
          q.record.run(`codex:${ownId}:${line}`, file.id, line, "user", ts);
          q.owner.run(`codex:${ownId}:${line}`, file.id, line, session, ts, "typed", msg);
          recordDollarSkills(msg);
          if (tsMs !== null && st.turnStartMs === null) {
            st.turnStartMs = tsMs;
            st.turnToolMs = 0;
            st.openApiMs = 0;
          }
          if (tsMs !== null) st.lastWaitFromMs = tsMs;
          added = 1;
        }
      } else if (p.type === "message" || p.type === "reasoning") {
        consumeOpenWait();
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        consumeOpenWait();
        q.record.run(`codex:${ownId}:${line}`, file.id, line, p.type, ts);
        q.call.run(`codex:${p.call_id || `${ownId}:${line}`}`, file.id, line, session, agent, ts, p.name ?? "unknown", st.model ?? null);
        if (tsMs !== null && p.call_id) st.callStart.set(p.call_id, tsMs);
        const inputStr = callInputText(p);
        if (inputStr) {
          const patch = countPatchLines(inputStr);
          if (patch.added || patch.removed) {
            st.patchAdded += patch.added;
            st.patchRemoved += patch.removed;
            if (!st.sawFileChange) statsDirty = true;
          }
          if (inputStr.includes("*** ")) {
            const unesc = inputStr.includes("*** Begin Patch\\n") ? inputStr.replace(/\\n/g, "\n") : inputStr;
            for (const m of unesc.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*([^\r\n`"]+)/gm)) {
              if (st.paths.add(m[1].trim(), { isFile: true, write: true, baseCwd: st.cwd })) pathsDirty = true;
            }
          }
          const vars = new Map();
          for (const m of inputStr.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`\n]+)["'`]/g)) {
            if (isAbsPath(m[2]) || m[2].startsWith(".")) vars.set(m[1], m[2]);
          }
          for (const m of inputStr.matchAll(/(?:workdir|"workdir")\s*:\s*(?:["'`]([^"'`\n]+)["'`]|([A-Za-z_$][\w$]*))/g)) {
            const wd = m[1] ?? (m[2] ? vars.get(m[2]) : null);
            if (wd && st.paths.add(wd, { write: false, baseCwd: st.cwd })) pathsDirty = true;
          }
          for (const dir of extractCommandDirs(inputStr, st.cwd)) {
            if (st.paths.add(dir, { write: false })) pathsDirty = true;
          }
          const loadedSkills = extractSkillPaths(inputStr);
          if (loadedSkills.length) {
            const ids = [];
            for (const [idx, [skillName, source]] of loadedSkills.entries()) {
              const skId = `codex:${ownId}:${line}:agent:${skillName}:${idx}`;
              q.skill.run(skId, file.id, line, session, ts, skillName, "agent", source, 0);
              ids.push(skId);
            }
            if (p.call_id) st.callSkills.set(p.call_id, ids);
          }
        }
        added = 1;
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const outText = toolOutputText(p);
        const err = isToolError(p, outText);
        if (p.call_id) {
          q.result.run(err ? 1 : 0, `codex:${p.call_id}`);
          if (err && st.callSkills.has(p.call_id)) {
            for (const skId of st.callSkills.get(p.call_id)) q.skillErr.run(skId);
          }
          st.callSkills.delete(p.call_id);
        }
        const dur = parseToolDurationMs(outText, p.call_id ? (st.callStart.get(p.call_id) ?? null) : null, tsMs);
        if (p.call_id) st.callStart.delete(p.call_id);
        if (dur > 0) {
          st.toolMs += dur;
          st.turnToolMs += dur;
          statsDirty = true;
        }
        if (tsMs !== null) st.lastWaitFromMs = tsMs;
      } else if (p.type === "compaction") {
        if (line - st.lastCompactionLine > 5) {
          st.lastCompactionLine = line;
          q.record.run(`codex:${ownId}:${line}`, file.id, line, p.type, ts);
          q.compaction.run(`codex:${ownId}:${line}`, file.id, line, session, agent, ts, "auto", null, null, null);
          added = 1;
        }
      }
    } else if (rec.type === "event_msg") {
      if (p.type === "task_started" || p.type === "turn_started") {
        if (tsMs !== null) {
          st.turnStartMs = tsMs;
          st.turnToolMs = 0;
          st.openApiMs = 0;
          st.lastWaitFromMs = tsMs;
        }
      } else if (p.type === "task_complete" || p.type === "turn_complete") {
        const totalTurn = typeof p.duration_ms === "number" && p.duration_ms >= 0
          ? p.duration_ms
          : (st.turnStartMs !== null && tsMs !== null ? Math.max(0, tsMs - st.turnStartMs) : null);
        if (totalTurn !== null) {
          st.completedApiMs += Math.max(0, totalTurn - Math.min(totalTurn, st.turnToolMs));
          statsDirty = true;
        } else if (st.openApiMs > 0) {
          st.completedApiMs += st.openApiMs;
          statsDirty = true;
        }
        st.turnStartMs = null;
        st.turnToolMs = 0;
        st.openApiMs = 0;
        st.lastWaitFromMs = null;
      } else if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
        const body = p.message.trim();
        q.record.run(`codex:${ownId}:${line}`, file.id, line, "user", ts);
        q.owner.run(`codex:${ownId}:${line}`, file.id, line, session, ts, "typed", body);
        recordDollarSkills(body);
        if (tsMs !== null && st.turnStartMs === null) {
          st.turnStartMs = tsMs;
          st.turnToolMs = 0;
          st.openApiMs = 0;
        }
        if (tsMs !== null) st.lastWaitFromMs = tsMs;
        added = 1;
      } else if (p.type === "item_completed" && p.item?.type === "FileChange") {
        if (!p.item.status || p.item.status === "completed") {
          for (const [fp, ch] of Object.entries(p.item.changes ?? {})) {
            if (st.paths.add(fp, { isFile: true, write: true, baseCwd: st.cwd })) pathsDirty = true;
            if (ch?.type === "add") st.fcAdded += lineCount(ch.content);
            else if (ch?.type === "delete") st.fcRemoved += lineCount(ch.content);
            else if (ch?.type === "update" && typeof ch.unified_diff === "string") {
              const d = countUnifiedDiff(ch.unified_diff);
              st.fcAdded += d.added;
              st.fcRemoved += d.removed;
            }
          }
          st.sawFileChange = true;
          statsDirty = true;
        }
      } else if (p.type === "token_count" && !st.sawTokenRec && p.info?.last_token_usage) {
        consumeOpenWait();
        const tot = p.info.total_token_usage;
        const totKey = tot ? `${tot.total_tokens}|${tot.input_tokens}|${tot.output_tokens}|${tot.cached_input_tokens}` : null;
        if (!totKey || totKey !== st.lastTotal) {
          st.lastTotal = totKey;
          if (recordUsage(`codex:${ownId}:${line}`, p.info.last_token_usage)) added = 1;
        }
      }
    }

    const totalApiMs = Math.round(st.completedApiMs + st.openApiMs);
    const linesAdded = st.baseAdded + (st.sawFileChange ? st.fcAdded : st.patchAdded);
    const linesRemoved = st.baseRemoved + (st.sawFileChange ? st.fcRemoved : st.patchRemoved);
    if (statsDirty && (totalApiMs > 0 || st.toolMs > 0 || linesAdded > 0 || linesRemoved > 0)) {
      q.upsertStats.run(file.id, totalApiMs, Math.round(st.toolMs), linesAdded, linesRemoved);
    }
    if (pathsDirty) {
      const json = st.paths.toJSON();
      if (json) q.upsertTargetPaths.run(file.id, json);
    }

    return { added, cwd, ts, own: true };
  };
}

export function postScan(db, archiveDir) {
  const idxPath = join(archiveDir, "session_index.jsonl");
  const titles = new Map();
  if (existsSync(idxPath)) {
    for (const line of readFileSync(idxPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.id && o.thread_name) titles.set(o.id, o.thread_name);
      } catch { /* ignore malformed index line */ }
    }
  }

  const allFiles = db.prepare("SELECT id, kind, session_id, agent_id FROM files WHERE provider = 'codex'").all();
  const byOwn = new Map();
  for (const f of allFiles) byOwn.set(f.agent_id ?? f.session_id, f);

  const metas = db.prepare("SELECT m.file_id, m.parent_session_id, m.subagent_type, m.tool_use_id FROM file_meta m JOIN files f ON f.id = m.file_id WHERE f.provider = 'codex'").all();
  const parentOf = new Map();
  for (const m of metas) {
    const f = allFiles.find((x) => x.id === m.file_id);
    if (f && m.parent_session_id) parentOf.set(f.agent_id ?? f.session_id, { parent: m.parent_session_id, type: m.subagent_type, toolUseId: m.tool_use_id });
  }
  const rootOf = (id) => {
    let cur = id;
    const seen = new Set([cur]);
    while (parentOf.has(cur)) {
      const next = parentOf.get(cur).parent;
      if (!next || seen.has(next) || !byOwn.has(next)) break;
      seen.add(next);
      cur = next;
    }
    return cur === id ? null : cur;
  };

  const setFileSub = db.prepare("UPDATE files SET kind = 'sub', session_id = ?, agent_id = ? WHERE id = ?");
  const setReqSub = db.prepare("UPDATE requests SET session_id = ?, agent_id = ?, is_sub = 1 WHERE file_id = ?");
  const setCallSub = db.prepare("UPDATE tool_calls SET session_id = ?, agent_id = ? WHERE file_id = ?");
  const setSkillSess = db.prepare("UPDATE skills SET session_id = ? WHERE file_id = ?");
  const setCompSub = db.prepare("UPDATE compactions SET session_id = ?, agent_id = ? WHERE file_id = ?");
  const setTitleSess = db.prepare("UPDATE titles SET session_id = ? WHERE file_id = ?");
  const putSub = db.prepare("INSERT OR REPLACE INTO subagents(agent_id, session_id, type, tool_use_id) VALUES (?, ?, ?, ?)");
  const putTitle = db.prepare("INSERT OR REPLACE INTO titles(file_id, line, session_id, kind, title) VALUES (?, 0, ?, 'custom', ?)");

  db.exec("BEGIN");
  try {
    for (const f of allFiles) {
      const ownId = f.agent_id ?? f.session_id;
      const root = rootOf(ownId);
      const sess = root ?? f.session_id;
      if (root) {
        setFileSub.run(root, ownId, f.id);
        setReqSub.run(root, ownId, f.id);
        setCallSub.run(root, ownId, f.id);
        setSkillSess.run(root, f.id);
        setCompSub.run(root, ownId, f.id);
        setTitleSess.run(root, f.id);
        const meta = parentOf.get(ownId);
        putSub.run(ownId, root, meta?.type ?? "subagent", meta?.toolUseId ?? null);
      }
      const title = titles.get(ownId);
      if (title) putTitle.run(f.id, sess, title);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const codex = { name: "codex", label, defaultPath, describe, listHost, syncMeta, createIngester, postScan, familyOf, displayModel };
