import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  startRun, ensureWorktree, setTask, readLedger, commitTask, landRun, RunRefused, OutsideChange, NothingToCommit, Conflict,
} from "../plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs";
import { tmpDir, runCli, git, makeRepo } from "./helpers.mjs";

const CLI = path.resolve("plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs");
const SUB = "def subtract(a, b):\n    return a - b\n";
const TASK1 = { title: "Task 1: subtract", worker: "GPT-6.1-Sol via Codex CLI", tool: "codex", session: "019a",
  reviewer: "Claude Opus 5.5 (this session)", fixRounds: 1 };

// A repo, a run on it, and task t1 with a `subtract` function written in its worktree (not yet committed).
function setup({ dirty = false } = {}) {
  const dir = tmpDir("cl");
  const repo = makeRepo(path.join(dir, "repo"));
  if (dirty) fs.appendFileSync(path.join(repo, "calc.py"), "# my edit\n");
  const root = path.join(dir, "runs");
  const r = startRun({ repo, topic: "demo", root, date: "20261024" });
  const t1 = ensureWorktree(r.run, "t1");
  fs.appendFileSync(path.join(t1.path, "calc.py"), "\n" + SUB);
  setTask(r.run, "t1", TASK1);
  return { dir, repo, root, env: { MMO_RUN_ROOT: root }, ...r, t1 };
}
const tip = (repo, branch) => git(repo, "rev-parse", branch).trim();

// Task t2 edits a second file, so it never conflicts with t1.
function commitSecond(s, name = "t2", text = "# notes\n") {
  const w = ensureWorktree(s.run, name);
  fs.writeFileSync(path.join(w.path, `${name}.txt`), text);
  setTask(s.run, name, { title: `Task 2: ${name}`, worker: "Grok 4.7 High via Cursor CLI" });
  return commitTask(s.run, name, { tests: "passed" });
}

test("commit carries the agent trailers", () => {
  const s = setup();
  const r = commitTask(s.run, "t1", { tests: "passed" });
  const body = git(s.repo, "log", "-1", "--format=%B", s.runBranch);
  assert.match(body, /^Task 1: subtract\n\nImplemented-by: GPT-6\.1-Sol via Codex CLI\nWorker-session: codex 019a\nReviewed-by: Claude Opus 5\.5 \(this session\)\nFix-rounds: 1\nTests: passed\n/);
  assert.equal(r.commit, tip(s.repo, s.runBranch));
  assert.deepEqual(r.files, ["calc.py"]);
  assert.ok(!fs.existsSync(s.t1.path));
  assert.equal(git(s.repo, "branch", "--list", "orchestrate/demo--t1").trim(), "");
  const t = readLedger(s.run).tasks.t1;
  assert.equal(t.status, "passed");
  assert.equal(t.commit, r.commit);
  assert.equal(t.tests, "passed");
  assert.deepEqual(fs.readdirSync(s.run).filter((f) => f.endsWith(".txt")), []);
});

test("a title with # and shell characters is kept as written", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed", title: "# -x \"quoted\" $(whoami) & more" });
  assert.equal(git(s.repo, "log", "-1", "--format=%s", s.runBranch).trim(), "# -x \"quoted\" $(whoami) & more");
});

test("tests not run is recorded, never passed", () => {
  const s = setup();
  assert.throws(() => commitTask(s.run, "t1", { tests: "maybe" }), /tests/);
  commitTask(s.run, "t1", { tests: "not run" });
  const body = git(s.repo, "log", "-1", "--format=%B", s.runBranch);
  assert.match(body, /Tests: not run/);
  assert.doesNotMatch(body, /Tests: passed/);
});

test("rework-of is a trailer", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed", reworkOf: "abc1234" });
  assert.match(git(s.repo, "log", "-1", "--format=%B", s.runBranch), /Rework-of: abc1234/);
});

test("refuses when the user's folder changed", () => {
  const s = setup();
  const before = tip(s.repo, s.runBranch);
  fs.writeFileSync(path.join(s.repo, "stray.txt"), "x");
  assert.throws(() => commitTask(s.run, "t1", { tests: "passed" }), OutsideChange);
  assert.equal(tip(s.repo, s.runBranch), before);
  assert.ok(fs.existsSync(s.t1.path));
  const r = runCli(CLI, ["commit", "--run", s.run, "--id", "t1", "--tests", "passed"]);
  assert.equal(r.code, 5);
  assert.match(r.json.reason, /changed/);
});

test("refuses when the user re-edited a file that was already dirty", () => {
  const ok = setup({ dirty: true });
  assert.doesNotThrow(() => commitTask(ok.run, "t1", { tests: "passed" }));
  const s = setup({ dirty: true });
  const before = tip(s.repo, s.runBranch);
  fs.appendFileSync(path.join(s.repo, "calc.py"), "# another edit\n"); // same status line, different content
  assert.throws(() => commitTask(s.run, "t1", { tests: "passed" }), OutsideChange);
  assert.equal(tip(s.repo, s.runBranch), before);
});

test("refuses an empty change", () => {
  const s = setup();
  const w = ensureWorktree(s.run, "t2");
  assert.throws(() => commitTask(s.run, "t2", { tests: "passed", title: "Nothing" }), NothingToCommit);
  assert.ok(fs.existsSync(w.path));
  assert.equal(runCli(CLI, ["commit", "--run", s.run, "--id", "t2", "--tests", "not-run", "--title", "Nothing"]).code, 8);
});

test("second task builds on the first", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  const t2 = ensureWorktree(s.run, "t2");
  assert.match(fs.readFileSync(path.join(t2.path, "calc.py"), "utf8"), /def subtract/);
});

test("two tasks from the same base: the second conflicts and nothing is lost", () => {
  const dir = tmpDir("cf");
  const repo = makeRepo(path.join(dir, "repo"));
  const { run, runBranch, runWorktree } = startRun({ repo, topic: "demo", root: path.join(dir, "runs"), date: "20261024" });
  const a = ensureWorktree(run, "a");
  const b = ensureWorktree(run, "b"); // both start from the same base, as in a wave
  fs.writeFileSync(path.join(a.path, "calc.py"), "def add(a, b):\n    return a + b + 1\n");
  fs.writeFileSync(path.join(b.path, "calc.py"), "def add(a, b):\n    return a - b\n");
  setTask(run, "a", { title: "Task A" });
  setTask(run, "b", { title: "Task B" });
  commitTask(run, "a", { tests: "passed" });
  const afterA = tip(repo, runBranch);
  assert.throws(() => commitTask(run, "b", { tests: "passed" }),
    (e) => e instanceof Conflict && e.exitCode === 7 && e.files.includes("calc.py") && /calc\.py/.test(e.reason));
  assert.ok(fs.existsSync(b.path));
  assert.equal(tip(repo, runBranch), afterA);
  assert.equal(git(runWorktree, "status", "--porcelain").trim(), ""); // the cherry-pick was aborted
  assert.notEqual(readLedger(run).tasks.b.status, "passed");
});

test("committing works with no git identity configured", () => {
  const s = setup();
  const emptyHome = tmpDir("home");
  git(s.repo, "config", "--unset", "user.name");
  git(s.repo, "config", "--unset", "user.email");
  // A global config with no identity; keep the line-ending setting so the worktrees look the same as before.
  const eol = spawnSync("git", ["config", "--get", "core.autocrlf"], { encoding: "utf8" }).stdout.trim();
  const globalConfig = path.join(emptyHome, "gitconfig");
  fs.writeFileSync(globalConfig, eol ? `[core]
	autocrlf = ${eol}
` : "");
  const env = { HOME: emptyHome, USERPROFILE: emptyHome, XDG_CONFIG_HOME: emptyHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
  const r = runCli(CLI, ["commit", "--run", s.run, "--id", "t1", "--tests", "passed"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(git(s.repo, "log", "-1", "--format=%an <%ae>", s.runBranch).trim(), "Orchestrate <orchestrate@localhost>");
});

test("land merge fast-forwards with one commit per task", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  commitSecond(s);
  const r = landRun(s.run, { mode: "merge" });
  assert.equal(r.commits, 2);
  assert.equal(r.kept, "orchestrate/demo");
  assert.deepEqual([...r.files].sort(), ["calc.py", "t2.txt"]);
  const log = git(s.repo, "log", "--format=%s", "main");
  assert.match(log, /Task 1: subtract/);
  assert.match(log, /Task 2: t2/);
  assert.equal(git(s.repo, "log", "-1", "--format=%P", "HEAD").trim().split(" ").length, 1); // a fast-forward, no merge commit
  assert.equal(tip(s.repo, "main"), tip(s.repo, s.runBranch));
  assert.ok(git(s.repo, "branch", "--list", "orchestrate/demo").trim());
  assert.ok(!fs.existsSync(s.runWorktree));
  assert.ok(fs.existsSync(path.join(s.repo, "t2.txt")));
  assert.equal(readLedger(s.run).landed.mode, "merge");
});

test("land merges when the user committed meanwhile", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  fs.writeFileSync(path.join(s.repo, "other.txt"), "hello");
  git(s.repo, "add", "other.txt");
  git(s.repo, "commit", "-q", "-m", "Unrelated");
  landRun(s.run, { mode: "merge" });
  assert.equal(git(s.repo, "log", "-1", "--format=%P", "HEAD").trim().split(" ").length, 2);
  assert.match(git(s.repo, "log", "-1", "--format=%s", "HEAD"), /Merge orchestrate run demo/);
  assert.ok(fs.existsSync(path.join(s.repo, "other.txt")));
  assert.match(fs.readFileSync(path.join(s.repo, "calc.py"), "utf8"), /def subtract/);
});

test("land squash makes one commit", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  commitSecond(s);
  const before = tip(s.repo, "main");
  landRun(s.run, { mode: "squash" });
  assert.equal(git(s.repo, "rev-list", "--count", `${before}..HEAD`).trim(), "1");
  const msg = git(s.repo, "log", "-1", "--format=%B");
  assert.match(msg, /^Orchestrate run demo: 2 tasks\n/);
  assert.match(msg, /- Task 1: subtract \(GPT-6\.1-Sol via Codex CLI\)/);
  assert.match(msg, /- Task 2: t2 \(Grok 4\.7 High via Cursor CLI\)/);
  assert.ok(git(s.repo, "branch", "--list", "orchestrate/demo").trim());
});

test("land uncommitted leaves changes staged", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  const head = tip(s.repo, "HEAD");
  landRun(s.run, { mode: "uncommitted" });
  assert.equal(git(s.repo, "diff", "--cached", "--name-only").trim(), "calc.py");
  assert.equal(tip(s.repo, "HEAD"), head);
});

test("land through the CLI", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  assert.equal(runCli(CLI, ["land", "--run", s.run, "--squash", "--uncommitted"]).code, 2);
  const r = runCli(CLI, ["land", "--run", s.run, "--squash"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.mode, "squash");
});

test("land refuses to overwrite the user's edits", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  fs.appendFileSync(path.join(s.repo, "calc.py"), "# mine\n");
  assert.throws(() => landRun(s.run, { mode: "merge" }), (e) => e instanceof RunRefused && /calc\.py/.test(e.reason));
  assert.match(fs.readFileSync(path.join(s.repo, "calc.py"), "utf8"), /# mine/);
  assert.ok(fs.existsSync(s.runWorktree));
});

test("land refuses when the user's folder moved to another branch", () => {
  const s = setup();
  commitTask(s.run, "t1", { tests: "passed" });
  git(s.repo, "switch", "-q", "-c", "elsewhere");
  assert.throws(() => landRun(s.run, { mode: "merge" }), (e) => e instanceof RunRefused && /elsewhere/.test(e.reason));
  assert.equal(tip(s.repo, "main"), readLedger(s.run).base);
});

test("ensureWorktree refuses a plain folder in the worktree's place", () => {
  const s = setup();
  fs.mkdirSync(path.join(s.run, "wt", "t9"));
  assert.throws(() => ensureWorktree(s.run, "t9"), RunRefused);
});

test("ensureWorktree recovers when a task folder was deleted by hand", () => {
  const s = setup();
  fs.rmSync(s.t1.path, { recursive: true, force: true });
  const again = ensureWorktree(s.run, "t1");
  assert.equal(again.created, true);
  assert.ok(fs.existsSync(path.join(again.path, "calc.py")));
});

test("task ids that git would refuse are rejected", () => {
  const s = setup();
  for (const id of ["a..b", "x.lock", "x.", "-x", "../y", ""]) {
    assert.throws(() => setTask(s.run, id, { status: "running" }), /task id/, id);
    assert.throws(() => ensureWorktree(s.run, id), /task id/, id);
  }
});

test("the ledger is written whole, with no temp files left behind", () => {
  const s = setup();
  assert.deepEqual(fs.readdirSync(s.run).filter((f) => f.endsWith(".tmp")), []);
  assert.equal(readLedger(s.run).tasks.t1.worker, TASK1.worker);
});
