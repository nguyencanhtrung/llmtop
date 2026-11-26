import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assistant, sid, user, writeTranscript } from "./fixtures/build.mjs";
import { makeHome } from "./fixtures/home.mjs";
import { loadConfig } from "../src/config.mjs";
import { scan } from "../src/scan.mjs";

const counts = (home) => {
  const db = new DatabaseSync(join(home.data, "usage.db"));
  return Object.fromEntries(["files", "records", "requests", "owner_messages", "tool_calls", "sessions"].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
};

test("scan creates the archive and database, and a second scan adds nothing", () => {
  const home = makeHome();
  writeTranscript(home.transcripts, "slug", sid(50), [user("2026-11-01T01:00:00Z", "hi"), assistant("2026-11-01T01:00:01Z", "m50", {})]);
  writeTranscript(home.transcripts, "slug", sid(51), [user("2026-11-01T02:00:00Z", "ho")]);
  const first = home.run("scan");
  assert.equal(first.code, 0);
  assert.match(first.stdout, /^added 2 transcript files, \d+ bytes, 2 sessions, 3 records/);
  const before = counts(home);
  assert.equal(home.run("scan").stdout, "nothing new\n");
  assert.deepEqual(counts(home), before);
});

test("a deleted transcript still resolves with show and keeps its session", () => {
  const home = makeHome();
  const s = sid(52);
  writeTranscript(home.transcripts, "slug", s, [user("2026-11-01T01:00:00Z", "keep me"), assistant("2026-11-01T01:00:01Z", "m52", {})]);
  home.run("scan");
  rmSync(join(home.transcripts, "slug"), { recursive: true });
  assert.equal(home.run("scan").code, 0);
  assert.equal(JSON.parse(home.run("show", `${s.slice(0, 8)}:1`).stdout).message.content, "keep me");
  assert.equal(counts(home).sessions, 1);
  // A rebuilt database recovers the deleted session from the archive alone.
  rmSync(join(home.data, "usage.db"));
  home.run("scan");
  assert.equal(counts(home).sessions, 1);
  assert.equal(counts(home).requests, 1);
});

test("scan reads the host folder without writing to it", () => {
  const home = makeHome();
  writeTranscript(home.transcripts, "slug", sid(53), [user("2026-11-01T01:00:00Z", "ro")]);
  const tree = (dir) => readdirSync(dir, { recursive: true }).map((p) => `${p}:${statSync(join(dir, p)).mtimeMs}`).sort();
  const host = join(home.dir, "home");
  const before = tree(host);
  const walk = (dir, mode) => {
    for (const p of readdirSync(dir, { recursive: true })) chmodSync(join(dir, p), statSync(join(dir, p)).isDirectory() ? mode | 0o111 : mode);
    chmodSync(dir, mode | 0o111);
  };
  walk(host, 0o444);
  try {
    const r = home.run("scan");
    assert.equal(r.code, 0, r.stderr);
  } finally {
    walk(host, 0o644);
  }
  assert.deepEqual(tree(host), before);
});

test("show reports a bad reference", () => {
  const home = makeHome();
  writeTranscript(home.transcripts, "slug", sid(54), [user("2026-11-01T01:00:00Z", "x")]);
  home.run("scan");
  assert.match(home.run("show", "00000054:9").stderr, /has no line 9/);
  assert.match(home.run("show", "ffff:1").stderr, /no archived transcript/);
  assert.notEqual(home.run("show", "nonsense").code, 0);
});

test("the archive sits under archive/<provider>/ and sessions and files carry the provider", () => {
  const home = makeHome();
  const s = sid(55);
  writeTranscript(home.transcripts, "slug", s, [user("2026-11-01T01:00:00Z", "p"), assistant("2026-11-01T01:00:01Z", "m55", {})]);
  assert.equal(home.run("scan").code, 0);
  assert.deepEqual(readdirSync(join(home.data, "archive")), ["claude"]);
  assert.ok(statSync(join(home.data, "archive", "claude", "slug", `${s}.jsonl.zst`)).isFile());
  const db = new DatabaseSync(join(home.data, "usage.db"));
  assert.deepEqual(db.prepare("SELECT DISTINCT provider FROM files").all().map((r) => r.provider), ["claude"]);
  assert.deepEqual(db.prepare("SELECT DISTINCT provider FROM sessions").all().map((r) => r.provider), ["claude"]);
  db.close();
  assert.equal(JSON.parse(home.run("show", `${s.slice(0, 8)}:1`).stdout).message.content, "p");
});

// A session's project is named by its first cwd, read again on every scan.
function projectsOf(home) {
  const db = new DatabaseSync(join(home.data, "usage.db"));
  const rows = Object.fromEntries(db.prepare("SELECT id, project FROM sessions").all().map((r) => [r.id, r.project]));
  db.close();
  return rows;
}

test("the project is the nearest .git at or above the cwd, else the cwd's own name, and survives the folder's deletion", () => {
  const home = makeHome();
  const work = join(home.dir, "work");
  mkdirSync(join(work, "outer", ".git"), { recursive: true });
  mkdirSync(join(work, "outer", "inner", ".git"), { recursive: true });
  mkdirSync(join(work, "outer", "inner", "src"), { recursive: true });
  mkdirSync(join(work, "outer", "docs"), { recursive: true });
  mkdirSync(join(work, "loose", "sub"), { recursive: true });
  mkdirSync(join(work, "temp"), { recursive: true });
  const at = (k, cwd) => writeTranscript(home.transcripts, "slug", sid(k), [user("2026-11-01T01:00:00Z", "go", { cwd })]);
  at(1, join(work, "outer", "inner", "src"));
  at(2, join(work, "outer", "docs"));
  at(3, join(work, "outer"));
  at(4, join(work, "loose", "sub"));
  at(5, join(work, "temp"));
  home.run("scan");
  assert.deepEqual(projectsOf(home), { [sid(1)]: "inner", [sid(2)]: "outer", [sid(3)]: "outer", [sid(4)]: "sub", [sid(5)]: "temp" });
  rmSync(join(work, "temp"), { recursive: true });
  rmSync(join(work, "outer", "inner"), { recursive: true });
  home.run("scan");
  assert.equal(projectsOf(home)[sid(5)], "temp");
  assert.equal(projectsOf(home)[sid(1)], "inner");
});

test("a scan reports its progress over the transcripts and why it runs", async () => {
  const home = makeHome();
  for (const k of [70, 71]) writeTranscript(home.transcripts, "slug", sid(k), [user("2026-11-01T01:00:00Z", "start"), assistant("2026-11-01T01:00:01Z", `m${k}`, {})]);
  const config = loadConfig(home.config);
  const run = async () => {
    const seen = [];
    await scan(config, { onProgress: (p) => seen.push(p) });
    return seen;
  };
  const first = await run();
  assert.deepEqual(first.map((p) => [p.reason, p.step, p.done, p.total]), [
    ["first", "find", 0, 2], ["first", "read", 0, 2], ["first", "read", 0, 2], ["first", "read", 1, 2], ["first", "read", 1, 2], ["first", "finish", 2, 2],
  ]);
  // The bytes read only grow, and end at the size of the transcripts.
  const read = first.filter((p) => p.step !== "find");
  const size = readdirSync(join(home.transcripts, "slug")).reduce((n, f) => n + statSync(join(home.transcripts, "slug", f)).size, 0);
  assert.ok(read.every((p, k) => p.totalBytes === size && (k === 0 || p.bytes >= read[k - 1].bytes)));
  assert.equal(read.at(-1).bytes, size);
  // Nothing new to read weighs nothing.
  const again = await run();
  assert.deepEqual([again[0].reason, again.at(-1).totalBytes], ["update", 0]);
  // A database left by an older schema is emptied and read again from the archive.
  const db = new DatabaseSync(config.database);
  db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema'").run();
  db.close();
  const rebuilt = (await run()).at(-1);
  assert.deepEqual([rebuilt.reason, rebuilt.step, rebuilt.done, rebuilt.total], ["rebuild", "finish", 2, 2]);
  assert.ok(rebuilt.totalBytes > 0);
});

test("a session started in a steering repo resolves to the child repo it edits, while edits in steering stay steering", () => {
  const home = makeHome();
  const steering = join(home.dir, "steering");
  const subapp = join(steering, "subapp");
  mkdirSync(join(steering, ".git"), { recursive: true });
  mkdirSync(join(subapp, ".git"), { recursive: true });
  mkdirSync(join(subapp, "src"), { recursive: true });

  const editCall = (id, filePath) => ({
    type: "assistant",
    uuid: id,
    sessionId: null,
    timestamp: "2026-11-01T01:00:05Z",
    message: {
      id,
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "tool_use", id: `tu-${id}`, name: "Edit", input: { file_path: filePath } }],
    },
  });

  const s1 = sid(80);
  const s2 = sid(81);
  writeTranscript(home.transcripts, "slug", s1, [
    user("2026-11-01T01:00:00Z", "edit subapp", { cwd: steering }),
    { ...editCall("e1", join(subapp, "src", "main.ts")), sessionId: s1 },
  ]);
  writeTranscript(home.transcripts, "slug", s2, [
    user("2026-11-01T01:00:00Z", "edit steering notes", { cwd: steering }),
    { ...editCall("e2", join(steering, "README.md")), sessionId: s2 },
  ]);

  assert.equal(home.run("scan").code, 0);
  assert.equal(projectsOf(home)[s1], "subapp");
  assert.equal(projectsOf(home)[s2], "steering");
});

test("auto-discovered repo names recover deleted/moved child targets and review-note sessions without climbing ancestors", () => {
  const home = makeHome();
  const root = join(home.dir, "umbrella");
  const steering = join(root, "steering");
  const targetRepo = join(home.dir, "live", "targetapp");
  const deletedWorktree = join(root, "targetapp.feat-branch");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(steering, ".git"), { recursive: true });
  mkdirSync(join(steering, "docs"), { recursive: true });
  mkdirSync(join(targetRepo, ".git"), { recursive: true });

  const bash = (id, command) => ({
    type: "assistant",
    uuid: id,
    sessionId: null,
    timestamp: "2026-11-01T01:00:05Z",
    message: {
      id,
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "tool_use", id: `tu-${id}`, name: "Bash", input: { command } }],
    },
  });
  const edit = (id, filePath) => ({
    type: "assistant",
    uuid: id,
    sessionId: null,
    timestamp: "2026-11-01T01:00:04Z",
    message: {
      id,
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "tool_use", id: `tu-${id}`, name: "Edit", input: { file_path: filePath } }],
    },
  });

  const sLive = sid(85);
  const sGone = sid(86);
  const sWt = sid(87);
  // Seed targetapp as a known real repo in the DB.
  writeTranscript(home.transcripts, "slug", sLive, [user("2026-11-01T01:00:00Z", "work", { cwd: targetRepo })]);
  // Review session launched in steering: edits 1 review note in steering/docs, runs 6 bash commands in deleted steering/code/targetapp.
  const cmds = Array.from({ length: 6 }, (_, i) => ({ ...bash(`b${i}`, `cd ${join(steering, "code", "targetapp")} && git status`), sessionId: sGone }));
  writeTranscript(home.transcripts, "slug", sGone, [
    user("2026-11-01T01:00:00Z", "review targetapp", { cwd: steering }),
    { ...edit("n1", join(steering, "docs", "review.md")), sessionId: sGone },
    ...cmds,
  ]);
  // Deleted worktree cwd named <repo>.<branch>.
  writeTranscript(home.transcripts, "slug", sWt, [user("2026-11-01T01:00:00Z", "wt", { cwd: deletedWorktree })]);

  assert.equal(home.run("scan").code, 0);
  const p = projectsOf(home);
  assert.equal(p[sLive], "targetapp");
  assert.equal(p[sGone], "targetapp");
  assert.equal(p[sWt], "targetapp");
});
