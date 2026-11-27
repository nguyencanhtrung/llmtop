import assert from "node:assert/strict";
import { test } from "node:test";
import { makeHome } from "./fixtures/home.mjs";

test("no command or an unknown one prints usage and exits non-zero", () => {
  const home = makeHome();
  for (const args of [[], ["nope"]]) {
    const r = home.run(...args);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /usage: llmtop/);
  }
  assert.match(home.run("nope").stderr, /unknown command: nope/);
});

test("--help and --version print expected output and exit zero", () => {
  const home = makeHome();
  for (const flag of ["-h", "--help", "help"]) {
    const r = home.run(flag);
    assert.equal(r.code, 0, flag);
    assert.match(r.stdout, /^usage: llmtop/, flag);
    assert.match(r.stdout, /\bstart\b/, flag);
    assert.match(r.stdout, /--daemon/, flag);
    assert.match(r.stdout, /\bstop\b/, flag);
    assert.match(r.stdout, /\bupdate\b/, flag);
    assert.match(r.stdout, /\buninstall\b/, flag);
  }
  for (const flag of ["-v", "--version", "version"]) {
    const r = home.run(flag);
    assert.equal(r.code, 0, flag);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/, flag);
  }
});

test("an unknown provider in the config stops every command with an error naming it", () => {
  const home = makeHome({ providers: { mystery: { transcripts: "x" } } });
  for (const args of [["scan"], ["usage"], ["serve"]]) {
    const r = home.run(...args);
    assert.equal(r.code, 1, args[0]);
    assert.match(r.stderr, /^error: unknown provider "mystery"/, args[0]);
  }
});
