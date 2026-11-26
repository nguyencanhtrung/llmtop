import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfigDir, defaultConfigPath, loadConfig, ROOT } from "../src/config.mjs";
import { projectOf } from "../src/derive.mjs";

test("default config and data resolve under XDG / ~/.config/llmtop", () => {
  const home = "/tmp/fake-home";
  assert.equal(defaultConfigDir({}, home), join(home, ".config", "llmtop"));
  assert.equal(defaultConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg-cfg" }, home), join("/tmp/xdg-cfg", "llmtop"));
  assert.equal(defaultConfigDir({ XDG_CONFIG_HOME: "relative/path" }, home), join(home, ".config", "llmtop"));

  assert.equal(defaultConfigPath({ LLMTOP_CONFIG: "/custom/cfg.json", XDG_CONFIG_HOME: "/tmp/xdg-cfg" }, home), "/custom/cfg.json");

  const dir = mkdtempSync(join(tmpdir(), "llmtop-xdg-"));
  const xdgCfg = defaultConfigPath({ XDG_CONFIG_HOME: dir }, home);
  assert.equal(xdgCfg, join(dir, "llmtop", "config.json"));

  const c = loadConfig(undefined, { XDG_CONFIG_HOME: dir });
  assert.equal(c.configPath, xdgCfg);
  assert.equal(c.data, join(dir, "llmtop", "data"));
  assert.equal(c.archive, join(dir, "llmtop", "data", "archive"));
  assert.equal(c.database, join(dir, "llmtop", "data", "usage.db"));

  const customData = join(dir, "custom-data");
  const cDataEnv = loadConfig(undefined, { XDG_CONFIG_HOME: dir, LLMTOP_DATA: customData });
  assert.equal(cDataEnv.data, customData);

  const file = join(dir, "explicit.json");
  writeFileSync(file, JSON.stringify({ data: "./stored" }));
  assert.equal(loadConfig(file, { LLMTOP_DATA: customData }).data, join(dir, "stored"));
});

test("a missing config file means defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-test-"));
  const c = loadConfig(join(dir, "none.json"));
  assert.equal(c.providers.claude.transcripts, join(homedir(), ".claude", "projects"));
  assert.equal(c.providers.codex.transcripts, join(homedir(), ".codex", "sessions"));
  assert.equal(c.providers.agy.transcripts, join(homedir(), ".gemini", "antigravity-cli"));
  assert.equal(c.data, join(dir, "data"));
  assert.equal(c.database, join(dir, "data", "usage.db"));
  assert.equal(c.prices, join(ROOT, "prices.md"));
  assert.equal(c.port, 4310);
  assert.equal(c.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("known keys are read and unknown keys are returned untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-test-"));
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify({ port: 5000, timeZone: "UTC", extra: { a: 1 } }));
  const c = loadConfig(file);
  assert.deepEqual([c.port, c.timeZone, c.extra], [5000, "UTC", { a: 1 }]);
  writeFileSync(file, "{");
  assert.throws(() => loadConfig(file), /cannot read config/);
});

test("the project is the nearest folder with .git at or above the cwd, else the cwd's own name", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-test-"));
  mkdirSync(join(dir, "alpha", ".git"), { recursive: true });
  mkdirSync(join(dir, "alpha", "pkg", "deep"), { recursive: true });
  mkdirSync(join(dir, "plain"), { recursive: true });
  assert.deepEqual(projectOf(join(dir, "alpha", "pkg", "deep")), { name: "alpha", onDisk: true });
  assert.deepEqual(projectOf(join(dir, "plain")), { name: "plain", onDisk: true });
  assert.deepEqual(projectOf(join(dir, "gone", "x")), { name: "x", onDisk: false });
  assert.deepEqual(projectOf(join(dir, "alpha", "deleted-sub")), { name: "deleted-sub", onDisk: false });

  mkdirSync(join(dir, "main-repo", ".git", "worktrees", "wt1"), { recursive: true });
  mkdirSync(join(dir, "wt-dir"), { recursive: true });
  writeFileSync(join(dir, "wt-dir", ".git"), `gitdir: ${join(dir, "main-repo", ".git", "worktrees", "wt1")}\n`);
  assert.deepEqual(projectOf(join(dir, "wt-dir")), { name: "main-repo", onDisk: true });

  mkdirSync(join(dir, "sandbox", "repo", ".git"), { recursive: true });
  writeFileSync(join(dir, "sandbox", "repo", ".git", "config"), '[remote "origin"]\n\turl = git@host:org/my-target.git\n');
  assert.deepEqual(projectOf(join(dir, "sandbox", "repo")), { name: "my-target", onDisk: true });

  mkdirSync(join(dir, "scratch", "repo", ".git", "worktrees", "wt2"), { recursive: true });
  writeFileSync(join(dir, "scratch", "repo", ".git", "config"), '[remote "origin"]\n\turl = git@host:org/real-proj.git\n');
  mkdirSync(join(dir, "wt2-dir"), { recursive: true });
  writeFileSync(join(dir, "wt2-dir", ".git"), `gitdir: ${join(dir, "scratch", "repo", ".git", "worktrees", "wt2")}\n`);
  assert.deepEqual(projectOf(join(dir, "wt2-dir")), { name: "real-proj", onDisk: true });

  mkdirSync(join(dir, "detached", "repo", ".git"), { recursive: true });
  writeFileSync(join(dir, "detached", "repo", ".git", "config"), "[core]\n\tbare = false\n");
  writeFileSync(join(dir, "detached", "repo", "pyproject.toml"), '[project]\nname = "demo-app"\nversion = "0.1.0"\n');
  assert.deepEqual(projectOf(join(dir, "detached", "repo")), { name: "demo-app", onDisk: true });
  assert.equal(projectOf(null), null);
});

test("providers default to claude, codex and agy and expand their transcripts path; an unknown one is an error naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-test-"));
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify({ providers: { claude: { transcripts: "~/x" }, codex: { transcripts: "~/y" }, agy: { transcripts: "~/z" } } }));
  assert.deepEqual(loadConfig(file).providers, {
    claude: { transcripts: join(homedir(), "x") },
    codex: { transcripts: join(homedir(), "y") },
    agy: { transcripts: join(homedir(), "z") },
  });
  const defaults = loadConfig(join(dir, "none.json")).providers;
  assert.deepEqual(Object.keys(defaults), ["claude", "codex", "agy"]);
  assert.equal(defaults.claude.transcripts, join(homedir(), ".claude", "projects"));
  assert.equal(defaults.codex.transcripts, join(homedir(), ".codex", "sessions"));
  assert.equal(defaults.agy.transcripts, join(homedir(), ".gemini", "antigravity-cli"));
  writeFileSync(file, JSON.stringify({ providers: { claude: {}, mystery: {} } }));
  assert.throws(() => loadConfig(file), /unknown provider "mystery"/);
});

test("a host package's own keys pass through the loader untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmtop-test-"));
  const file = join(dir, "c.json");
  const own = { sources: ["~/a"], nested: { n: 1 }, flag: true };
  writeFileSync(file, JSON.stringify({ port: 5001, ...own }));
  const c = loadConfig(file);
  assert.deepEqual({ sources: c.sources, nested: c.nested, flag: c.flag }, own);
  assert.equal(c.port, 5001);
});
