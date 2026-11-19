// The check gate: a task's checks run as one command, and commit refuses a task whose checks did not pass on its
// current files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  startRun, ensureWorktree, setTask, readLedger, commitTask, runChecks, RunRefused,
} from "../plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs";
import { readChecks } from "../plugins/multi-model-review/skills/multi-model-orchestrate/checks.mjs";
import { UsageError } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { tmpDir, runCli, git, makeRepo } from "./helpers.mjs";

const CLI = path.resolve("plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs");
const NODE = JSON.stringify(process.execPath); // quoted: the path may contain spaces
const OK = `${NODE} -e 0`;
const FAIL = `${NODE} -e "process.exit(3)"`;

// The checks file in the user's repo. It is committed before the run starts, so the run sees a clean folder.
function writeChecks(repo, value) {
  fs.mkdirSync(path.join(repo, ".orchestrate"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".orchestrate", "checks.json"), typeof value === "string" ? value : JSON.stringify(value));
  git(repo, "add", ".orchestrate");
  git(repo, "commit", "-q", "-m", "checks");
}

function setup(checks) {
  const dir = tmpDir("cg");
  const repo = makeRepo(path.join(dir, "repo"));
  if (checks !== undefined) writeChecks(repo, checks);
  const root = path.join(dir, "runs");
  const r = startRun({ repo, topic: "demo", root, date: "20261119" });
  const t1 = ensureWorktree(r.run, "t1");
  fs.appendFileSync(path.join(t1.path, "calc.py"), "\ndef sub(a, b):\n    return a - b\n");
  setTask(r.run, "t1", { title: "Task 1: sub", worker: "Some model" });
  return { repo, root, env: { MMO_RUN_ROOT: root }, ...r, t1 };
}
const body = (s) => git(s.repo, "log", "-1", "--format=%B", s.runBranch);

test("check passes and commit succeeds", () => {
  const s = setup({ checks: [{ name: "ok", run: OK }] });
  const r = runChecks(s.run, "t1");
  assert.equal(r.result, "passed");
  assert.equal(r.failed, null);
  assert.match(fs.readFileSync(r.log, "utf8"), /ok/);
  assert.equal(readLedger(s.run).tasks.t1.checks.result, "passed");
  commitTask(s.run, "t1", {});
  assert.match(body(s), /Tests: passed/);
});

test("check fails, the CLI exits 11, and commit refuses", () => {
  const s = setup({ checks: [{ name: "unit", run: FAIL }] });
  const cli = runCli(CLI, ["check", "--run", s.run, "--id", "t1"]);
  assert.equal(cli.code, 11);
  assert.equal(cli.json.result, "failed");
  assert.equal(cli.json.failed, "unit");
  assert.throws(() => commitTask(s.run, "t1", {}), (e) => e instanceof RunRefused && /check/.test(e.reason));
  assert.equal(runCli(CLI, ["commit", "--run", s.run, "--id", "t1"]).code, 7);
});

test("override commits with a trailer", () => {
  const s = setup({ checks: [{ name: "unit", run: FAIL }] });
  runChecks(s.run, "t1");
  commitTask(s.run, "t1", { override: "flaky upstream" });
  assert.match(body(s), /Checks-override: flaky upstream/);
  assert.match(body(s), /Tests: failed/);
});

test("an edit after the check needs a new check", () => {
  const s = setup({ checks: [{ name: "ok", run: OK }] });
  runChecks(s.run, "t1");
  fs.appendFileSync(path.join(s.t1.path, "calc.py"), "# later edit\n");
  assert.throws(() => commitTask(s.run, "t1", {}), RunRefused);
  runChecks(s.run, "t1");
  assert.doesNotThrow(() => commitTask(s.run, "t1", {}));
});

test("test artifacts do not invalidate the check", () => {
  const make = `${NODE} -e "const f=require('fs');f.mkdirSync('__pycache__',{recursive:true});f.writeFileSync('__pycache__/x.pyc','1');f.mkdirSync('.pytest_cache',{recursive:true});f.writeFileSync('.coverage','1')"`;
  const s = setup({ checks: [{ name: "py", run: make }] });
  assert.equal(runChecks(s.run, "t1").result, "passed");
  assert.ok(fs.existsSync(path.join(s.t1.path, "__pycache__", "x.pyc")));
  fs.rmSync(path.join(s.t1.path, "__pycache__"), { recursive: true }); // the manager's artifact cleanup
  assert.doesNotThrow(() => commitTask(s.run, "t1", {}));
});

test("a worker cannot rewrite its own gate", () => {
  const s = setup({ checks: [{ name: "unit", run: FAIL }] });
  fs.writeFileSync(path.join(s.t1.path, ".orchestrate", "checks.json"), JSON.stringify({ checks: [{ name: "unit", run: OK }] }));
  assert.equal(runChecks(s.run, "t1").result, "failed");
});

test("--cmd works without a checks file; neither is a usage error", () => {
  const s = setup();
  assert.equal(readChecks(s.repo), null);
  assert.throws(() => runChecks(s.run, "t1"), UsageError);
  assert.equal(runCli(CLI, ["check", "--run", s.run, "--id", "t1"]).code, 2);
  assert.equal(runChecks(s.run, "t1", { cmds: [OK] }).result, "passed");
  const cli = runCli(CLI, ["check", "--run", s.run, "--id", "t1", "--cmd", FAIL]);
  assert.equal(cli.code, 11);
});

test("a malformed checks file is a usage error naming the file", () => {
  for (const bad of ['{"checks":[]}', "not json", '{"checks":[{"name":"x"}]}']) {
    const s = setup(bad);
    assert.throws(() => runChecks(s.run, "t1"), (e) => e instanceof UsageError && /\.orchestrate[\\/]checks\.json/.test(e.message));
  }
});

test("a hung check is stopped at the timeout and fails", () => {
  const s = setup({ timeoutMinutes: 0.02, checks: [{ name: "hang", run: `${NODE} -e "setTimeout(()=>{},60000)"` }] });
  const r = runChecks(s.run, "t1");
  assert.equal(r.result, "failed");
  assert.match(fs.readFileSync(r.log, "utf8"), /timed out/);
});

test("checks stop at the first failure", () => {
  const s = setup({ checks: [{ name: "first", run: FAIL }, { name: "second-check", run: OK }] });
  const r = runChecks(s.run, "t1");
  assert.equal(r.failed, "first");
  assert.doesNotMatch(fs.readFileSync(r.log, "utf8"), /second-check/);
});

test("a run with no check keeps the old commit rules", () => {
  const s = setup();
  assert.throws(() => commitTask(s.run, "t1", {}), UsageError); // --tests is still required
  commitTask(s.run, "t1", { tests: "not run" });
  assert.match(body(s), /Tests: not run/);
});

test("the ledger's checks field cannot be set by hand", () => {
  const s = setup({ checks: [{ name: "unit", run: FAIL }] });
  assert.throws(() => setTask(s.run, "t1", { checks: "passed" }), UsageError);
});
