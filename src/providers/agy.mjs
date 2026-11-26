// Everything that knows the Antigravity CLI format under ~/.gemini/antigravity-cli:
// brain/<id>/.system_generated/logs/transcript.jsonl and conversation_summaries.db.
// input_tokens in PLANNER_RESPONSE excludes cache_read_tokens; effort is encoded as a model suffix.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createPathTracker, extractCommandDirs } from "../paths.mjs";
import { zoner } from "../zone.mjs";

export const defaultPath = "~/.gemini/antigravity-cli";
export const label = "Antigravity";

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const list = (p) => (isDir(p) ? readdirSync(p, { withFileTypes: true }) : []);

export function describe(rel) {
  const parts = rel.split(sep);
  if (parts.length === 5 && parts[0] === "brain" && parts[2] === ".system_generated" && parts[3] === "logs" && parts[4] === "transcript.jsonl") {
    return { rel, kind: "main", slug: parts[1], sessionId: parts[1], agentId: null };
  }
  return null;
}

export function listHost(root) {
  const transcripts = [];
  const brain = join(root, "brain");
  for (const e of list(brain)) {
    if (!e.isDirectory()) continue;
    const rel = join("brain", e.name, ".system_generated", "logs", "transcript.jsonl");
    if (isFile(join(root, rel))) {
      const d = describe(rel);
      if (d) transcripts.push(d);
    }
  }
  return { transcripts, others: [] };
}

function uriToPath(raw) {
  if (!raw) return null;
  let first = raw;
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      first = Array.isArray(arr) ? arr[0] : null;
    } catch {
      return null;
    }
  }
  if (typeof first !== "string" || !first) return null;
  if (first.startsWith("file://")) {
    try {
      return fileURLToPath(first);
    } catch {
      return null;
    }
  }
  return first;
}

// Snapshot conversation metadata from conversation_summaries.db into archive/agy/summaries.json (read-only on host).
export function syncMeta(root, archiveDir) {
  const dbPath = join(root, "conversation_summaries.db");
  if (!existsSync(dbPath)) return 0;
  const outPath = join(archiveDir, "summaries.json");
  let merged = {};
  if (existsSync(outPath)) {
    try {
      merged = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      merged = {};
    }
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT conversation_id, title, workspace_uris, parent_conversation_id, agent_name FROM conversation_summaries").all();
    const parents = new Map();
    try {
      for (const r of db.prepare("SELECT conversation_id, parent_id FROM conversation_parents").all()) parents.set(r.conversation_id, r.parent_id);
    } catch { /* optional table */ }
    for (const r of rows) {
      const cwd = uriToPath(r.workspace_uris);
      const parentId = r.parent_conversation_id || parents.get(r.conversation_id) || "";
      merged[r.conversation_id] = {
        ...(r.title ? { title: r.title } : {}),
        ...(cwd ? { cwd } : {}),
        ...(parentId ? { parentId } : {}),
        ...(r.agent_name ? { agentName: r.agent_name } : {}),
      };
    }
  } catch {
    return 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  if (!Object.keys(merged).length) return 0;
  const next = JSON.stringify(merged, null, 1) + "\n";
  const prev = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (next === prev) return 0;
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(outPath, next);
  return 1;
}

const EFFORT_RE = /^(.*)-(low|medium|high|xhigh|max)$/;
export function splitModelEffort(raw) {
  if (!raw) return { model: "unknown", effort: null };
  const m = raw.match(EFFORT_RE);
  return m ? { model: m[1], effort: m[2] } : { model: raw, effort: null };
}

export function familyOf(model) {
  const base = splitModelEffort(model.replace(/\[.*\]$/, "")).model;
  const m = base.match(/^gemini-[\d.]+-([a-z][a-z0-9-]*)$/i);
  return m ? `gemini-${m[1].toLowerCase()}` : base;
}

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
export function displayModel(family) {
  const v = family.match(/^gemini-[\d.]+-(.+)$/i);
  if (v) return `Gemini ${v[1].split("-").map(cap).join(" ")}`;
  const m = family.match(/^gemini-(.+)$/i);
  if (m) return `Gemini ${m[1].split("-").map(cap).join(" ")}`;
  return family;
}

function unquote(v) {
  if (typeof v !== "string") return "";
  if (v.startsWith('"')) {
    try {
      const p = JSON.parse(v);
      if (typeof p === "string") return p;
    } catch { /* raw string */ }
  }
  return v;
}

const lineCount = (s) => (s ? s.replace(/\n$/, "").split("\n").length : 0);
function diffPair(target, replacement) {
  if (!target && !replacement) return { added: 0, removed: 0 };
  if (!target) return { added: lineCount(replacement), removed: 0 };
  if (!replacement) return { added: 0, removed: lineCount(target) };
  const a = target.replace(/\n$/, "").split("\n");
  const b = replacement.replace(/\n$/, "").split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length;
  let sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) {
    sa--;
    sb--;
  }
  return { added: sb - p, removed: sa - p };
}

function diffLineCounts(name, args) {
  if (!args || typeof args !== "object") return { added: 0, removed: 0 };
  if (name === "edit_file" || name === "replace_file_content") {
    return diffPair(unquote(args.Target ?? args.TargetContent ?? ""), unquote(args.Replacement ?? args.ReplacementContent ?? ""));
  }
  if (name === "multi_replace_file_content") {
    let chunks = args.ReplacementChunks;
    if (typeof chunks === "string") {
      try { chunks = JSON.parse(chunks); } catch { chunks = null; }
    }
    if (!Array.isArray(chunks)) return { added: 0, removed: 0 };
    let added = 0;
    let removed = 0;
    for (const c of chunks) {
      const d = diffPair(String(c?.TargetContent ?? ""), String(c?.ReplacementContent ?? ""));
      added += d.added;
      removed += d.removed;
    }
    return { added, removed };
  }
  if (name === "write_file" || name === "write_to_file") {
    return { added: lineCount(unquote(args.Content ?? args.CodeContent ?? "")), removed: 0 };
  }
  return { added: 0, removed: 0 };
}

const SKILL_PATH_RE = /([^\s"'`<>()\\]*?skills\/([a-z0-9][a-z0-9._-]{0,63})\/SKILL\.md)\b/i;
const SLASH_CMD_RE = /^\/([a-z0-9][a-z0-9_-]{0,63})(?=\s|$)/i;
function skillSourceOf(path) {
  if (/\/builtin\/skills\//i.test(path)) return "builtin";
  if (/^~\/|\/(?:home|Users)\/[^/]+\/\.(?:agents|codex|claude|gemini)\//i.test(path)) return "personal";
  return "project";
}

function isGenericError(rec) {
  if (rec.error) return true;
  if (rec.status === "ERROR" || rec.status === "FAILED") return true;
  if (typeof rec.content === "string") {
    if (/Command exited with code [1-9]\d*|Encountered error in tool execution/i.test(rec.content)) return true;
  }
  return false;
}

export function createIngester(db, timeZone) {
  const zone = zoner(timeZone);
  const q = {
    record: db.prepare("INSERT OR IGNORE INTO records(uuid, file_id, line, type, ts) VALUES (?, ?, ?, ?, ?)"),
    request: db.prepare(`INSERT OR IGNORE INTO requests(message_id, file_id, line, session_id, agent_id, ts, day, hour, model, family,
      effort, is_sub, input, output, thinking, cache_read, cache_write, cache_write_1h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    owner: db.prepare("INSERT OR IGNORE INTO owner_messages(uuid, file_id, line, session_id, ts, kind, text) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    call: db.prepare("INSERT OR IGNORE INTO tool_calls(id, file_id, line, session_id, agent_id, ts, name, model, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)"),
    callErr: db.prepare("UPDATE tool_calls SET is_error = 1 WHERE id = ?"),
    skill: db.prepare("INSERT OR IGNORE INTO skills(id, file_id, line, session_id, ts, name, via, source, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)"),
    skillErr: db.prepare("UPDATE skills SET is_error = 1 WHERE id = ?"),
    getStats: db.prepare("SELECT api_ms, tool_ms, lines_added, lines_removed, target_paths FROM file_meta WHERE file_id = ?"),
    upsertStats: db.prepare(`INSERT INTO file_meta(file_id, api_ms, tool_ms, lines_added, lines_removed) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET api_ms = excluded.api_ms, tool_ms = excluded.tool_ms,
        lines_added = excluded.lines_added, lines_removed = excluded.lines_removed`),
    upsertTargetPaths: db.prepare(`INSERT INTO file_meta(file_id, target_paths) VALUES (?, ?)
      ON CONFLICT(file_id) DO UPDATE SET target_paths = excluded.target_paths`),
  };
  const stateByFile = new Map();
  const AGY_WRITE_TOOLS = new Set(["edit_file", "write_file", "replace_file_content", "multi_replace_file_content", "write_to_file"]);
  const AGY_READ_TOOLS = new Set(["read_file", "view_file", "grep_search", "find_by_name", "list_dir", "run_command"]);

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
        lastType: null, lastTsMs: null, lastCalls: [],
        apiMs: prevStats?.api_ms ?? 0, toolMs: prevStats?.tool_ms ?? 0,
        linesAdded: prevStats?.lines_added ?? 0, linesRemoved: prevStats?.lines_removed ?? 0,
        paths: createPathTracker(prevStats?.target_paths ?? null),
      };
      stateByFile.set(file.id, st);
    }
    const ownId = file.agent_id ?? file.session_id;
    const session = file.session_id;
    const agent = file.agent_id;
    const isSub = file.kind === "sub" ? 1 : 0;
    const step = rec.step_index ?? line;
    const ts = rec.created_at ?? null;
    const parsedTs = ts ? Date.parse(ts) : NaN;
    const tsMs = Number.isFinite(parsedTs) ? parsedTs : null;
    const uuid = `agy:${ownId}:${step}`;
    let added = 0;
    let statsDirty = false;
    let pathsDirty = false;

    if (tsMs !== null && st.lastTsMs !== null) {
      const dt = tsMs - st.lastTsMs;
      if (dt > 0 && dt < 600_000) {
        if (rec.type === "PLANNER_RESPONSE" && (st.lastType === "USER_INPUT" || st.lastType === "GENERIC" || st.lastType === "SYSTEM_MESSAGE")) {
          st.apiMs += Math.round(dt);
          statsDirty = true;
        } else if (rec.type === "GENERIC" && st.lastType === "PLANNER_RESPONSE") {
          st.toolMs += Math.round(dt);
          statsDirty = true;
        }
      }
    }

    if (rec.type === "PLANNER_RESPONSE") {
      const { model, effort } = splitModelEffort(rec.model ?? "unknown");
      const input = rec.input_tokens ?? 0;
      const cacheRead = rec.cache_read_tokens ?? 0;
      const output = rec.output_tokens ?? 0;
      if ((input > 0 || output > 0 || cacheRead > 0) && ts) {
        const { day, hour } = zone(ts);
        q.record.run(uuid, file.id, line, rec.type, ts);
        q.request.run(uuid, file.id, line, session, agent, ts, day, hour, model, familyOf(model), effort, isSub,
          input, output, 0, cacheRead, 0, null);
        added = 1;
      }
      const calls = [];
      for (const [idx, tc] of (Array.isArray(rec.tool_calls) ? rec.tool_calls : []).entries()) {
        if (!tc?.name) continue;
        const id = `${uuid}:${idx}`;
        q.call.run(id, file.id, line, session, agent, ts, tc.name, model);
        const diff = diffLineCounts(tc.name, tc.args);
        if (diff.added || diff.removed) {
          st.linesAdded += diff.added;
          st.linesRemoved += diff.removed;
          statsDirty = true;
        }
        if (tc.args && typeof tc.args === "object") {
          if (AGY_WRITE_TOOLS.has(tc.name)) {
            for (const k of ["Path", "TargetFile", "AbsolutePath"]) {
              const val = unquote(tc.args[k]);
              if (val && st.paths.add(val, { isFile: true, write: true })) pathsDirty = true;
            }
          } else if (AGY_READ_TOOLS.has(tc.name)) {
            for (const k of ["Path", "AbsolutePath"]) {
              const val = unquote(tc.args[k]);
              if (val && st.paths.add(val, { isFile: true, write: false })) pathsDirty = true;
            }
            for (const k of ["SearchPath", "DirectoryPath", "Cwd"]) {
              const val = unquote(tc.args[k]);
              if (val && st.paths.add(val, { isFile: false, write: false })) pathsDirty = true;
            }
            if (tc.name === "run_command" && tc.args.CommandLine) {
              const cmd = unquote(tc.args.CommandLine);
              const cmdCwd = unquote(tc.args.Cwd) || null;
              for (const dir of extractCommandDirs(cmd, cmdCwd)) {
                if (st.paths.add(dir, { write: false })) pathsDirty = true;
              }
            }
          }
        }
        const skillIds = [];
        if (tc.args && typeof tc.args === "object") {
          for (const val of Object.values(tc.args)) {
            const m = unquote(val).match(SKILL_PATH_RE);
            if (m) {
              const skName = m[2].toLowerCase();
              const skId = `${id}:skill:${skName}`;
              q.skill.run(skId, file.id, line, session, ts, skName, "agent", skillSourceOf(m[1]));
              skillIds.push(skId);
              break;
            }
          }
        }
        calls.push({ id, skillIds });
        added = 1;
      }
      if (calls.length) st.lastCalls = calls;
    } else if (rec.type === "USER_INPUT") {
      const body = typeof rec.content === "string" ? rec.content.trim() : "";
      if ((!rec.source || rec.source === "USER_EXPLICIT") && body) {
        q.record.run(uuid, file.id, line, rec.type, ts);
        q.owner.run(uuid, file.id, line, session, ts, "typed", body);
        const cmd = body.match(SLASH_CMD_RE);
        if (cmd) q.skill.run(`${uuid}:cmd:${cmd[1].toLowerCase()}`, file.id, line, session, ts, cmd[1].toLowerCase(), "command", null);
        added = 1;
      }
    } else if (rec.type === "GENERIC" && isGenericError(rec)) {
      const last = st.lastCalls[st.lastCalls.length - 1];
      if (last) {
        q.callErr.run(last.id);
        for (const skId of last.skillIds) q.skillErr.run(skId);
      }
    }

    if (tsMs !== null) {
      st.lastTsMs = tsMs;
      st.lastType = rec.type;
    }
    if (statsDirty && (st.apiMs > 0 || st.toolMs > 0 || st.linesAdded > 0 || st.linesRemoved > 0)) {
      q.upsertStats.run(file.id, st.apiMs, st.toolMs, st.linesAdded, st.linesRemoved);
    }
    if (pathsDirty) {
      const json = st.paths.toJSON();
      if (json) q.upsertTargetPaths.run(file.id, json);
    }

    return { added, cwd: null, ts, own: true };
  };
}

export function postScan(db, archiveDir) {
  const path = join(archiveDir, "summaries.json");
  if (!existsSync(path)) return;
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }

  const allFiles = db.prepare("SELECT id, kind, session_id, agent_id, cwd FROM files WHERE provider = 'agy'").all();
  const byOwn = new Map();
  for (const f of allFiles) byOwn.set(f.agent_id ?? f.session_id, f);

  const rootOf = (id) => {
    let cur = id;
    const seen = new Set([cur]);
    while (meta[cur]?.parentId) {
      const next = meta[cur].parentId;
      if (!next || seen.has(next) || !byOwn.has(next)) break;
      seen.add(next);
      cur = next;
    }
    return cur === id ? null : cur;
  };

  const setCwd = db.prepare("UPDATE files SET cwd = ? WHERE id = ?");
  const setFileSub = db.prepare("UPDATE files SET kind = 'sub', session_id = ?, agent_id = ? WHERE id = ?");
  const setReqSub = db.prepare("UPDATE requests SET session_id = ?, agent_id = ?, is_sub = 1 WHERE file_id = ?");
  const setCallSub = db.prepare("UPDATE tool_calls SET session_id = ?, agent_id = ? WHERE file_id = ?");
  const setSkillSess = db.prepare("UPDATE skills SET session_id = ? WHERE file_id = ?");
  const setTitleSess = db.prepare("UPDATE titles SET session_id = ? WHERE file_id = ?");
  const putSub = db.prepare("INSERT OR REPLACE INTO subagents(agent_id, session_id, type, tool_use_id) VALUES (?, ?, ?, NULL)");
  const putTitle = db.prepare("INSERT OR REPLACE INTO titles(file_id, line, session_id, kind, title) VALUES (?, 0, ?, 'ai', ?)");

  db.exec("BEGIN");
  try {
    for (const f of allFiles) {
      const ownId = f.agent_id ?? f.session_id;
      const m = meta[ownId];
      if (!m) continue;
      if (m.cwd && !f.cwd) setCwd.run(m.cwd, f.id);
      const root = rootOf(ownId);
      const sess = root ?? f.session_id;
      if (root) {
        setFileSub.run(root, ownId, f.id);
        setReqSub.run(root, ownId, f.id);
        setCallSub.run(root, ownId, f.id);
        setSkillSess.run(root, f.id);
        setTitleSess.run(root, f.id);
        putSub.run(ownId, root, m.agentName || "subagent");
      }
      if (m.title) putTitle.run(f.id, sess, m.title);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const agy = { name: "agy", label, defaultPath, describe, listHost, syncMeta, createIngester, postScan, familyOf, displayModel };
