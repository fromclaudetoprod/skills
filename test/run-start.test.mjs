import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  startRun, runRoot, ensureWorktree, setTask, readLedger, runStatus, RunRefused,
} from "../plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs";
import { repoFingerprint } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { tmpDir, runCli, git, makeRepo } from "./helpers.mjs";

const CLI = path.resolve("plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs");
const setup = () => {
  const dir = tmpDir("run");
  const repo = makeRepo(path.join(dir, "repo"));
  const root = path.join(dir, "runs");
  return { dir, repo, root, env: { MMO_RUN_ROOT: root } };
};

test("start creates run branch, run worktree and ledger", () => {
  const { repo, root } = setup();
  const r = startRun({ repo, topic: "demo", root, date: "20261024" });
  assert.equal(r.runBranch, "orchestrate/demo");
  assert.equal(r.userBranch, "main");
  assert.ok(git(repo, "branch", "--list", "orchestrate/demo").trim());
  assert.ok(fs.existsSync(path.join(r.run, "wt", "_run", "calc.py")));
  assert.ok(fs.existsSync(path.join(r.run, "briefs")));
  assert.equal(path.basename(r.run), "20261024-demo");
  assert.match(fs.readFileSync(path.join(r.run, "ledger.md"), "utf8"), /\| Task \|/);
  const l = readLedger(r.run);
  assert.equal(l.userStatusAtStart, "");
  assert.equal(l.userFingerprintAtStart, repoFingerprint(repo));
  assert.deepEqual(l.tasks, {});
});

test("start through the CLI prints JSON", () => {
  const { repo, env } = setup();
  const r = runCli(CLI, ["start", "--repo", repo, "--topic", "demo"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.runBranch, "orchestrate/demo");
});

test("second start gets a numbered branch", () => {
  const { repo, root } = setup();
  startRun({ repo, topic: "demo", root, date: "20261024" });
  const b = startRun({ repo, topic: "demo", root, date: "20261024" });
  assert.equal(b.runBranch, "orchestrate/demo-2");
  assert.equal(path.basename(b.run), "20261024-demo-2");
  assert.equal(startRun({ repo, topic: "demo", root, date: "20261024" }).runBranch, "orchestrate/demo-3");
});

test("refuses a folder that is not a repo", () => {
  const { dir, env } = setup();
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  const r = runCli(CLI, ["start", "--repo", plain, "--topic", "demo"], { env });
  assert.equal(r.code, 7);
  assert.match(r.json.reason, /not a git repository/);
});

test("refuses a repo with no commits", () => {
  const { dir, env } = setup();
  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  git(empty, "init", "-q", "-b", "main");
  const r = runCli(CLI, ["start", "--repo", empty, "--topic", "demo"], { env });
  assert.equal(r.code, 7);
  assert.match(r.json.reason, /no commits/);
});

test("refuses detached HEAD", () => {
  const { repo, env } = setup();
  git(repo, "checkout", "-q", "--detach");
  const r = runCli(CLI, ["start", "--repo", repo, "--topic", "demo"], { env });
  assert.equal(r.code, 7);
  assert.match(r.json.reason, /branch/);
});

test("refuses submodules unless allowed", () => {
  const { repo, env } = setup();
  fs.writeFileSync(path.join(repo, ".gitmodules"), "");
  const r = runCli(CLI, ["start", "--repo", repo, "--topic", "demo"], { env });
  assert.equal(r.code, 7);
  assert.match(r.json.reason, /submodules/);
  const ok = runCli(CLI, ["start", "--repo", repo, "--topic", "demo", "--allow-submodules"], { env });
  assert.equal(ok.code, 0, ok.err);
});

test("refuses a run root inside the repo", () => {
  const { repo } = setup();
  const r = runCli(CLI, ["start", "--repo", repo, "--topic", "demo"], { env: { MMO_RUN_ROOT: path.join(repo, "runs") } });
  assert.equal(r.code, 7);
  assert.match(r.json.reason, /outside the repository/);
  assert.throws(() => startRun({ repo, topic: "demo", root: repo }), RunRefused);
});

test("rejects a bad topic as a usage error", () => {
  const { repo, env } = setup();
  const r = runCli(CLI, ["start", "--repo", repo, "--topic", "Bad Topic"], { env });
  assert.equal(r.code, 2);
});

test("records the user's dirty files", () => {
  const { repo, root } = setup();
  fs.appendFileSync(path.join(repo, "calc.py"), "# edit\n");
  const r = startRun({ repo, topic: "demo", root });
  assert.deepEqual(r.dirty, ["calc.py"]);
  const l = readLedger(r.run);
  assert.match(l.userStatusAtStart, /calc\.py/);
  assert.equal(l.userFingerprintAtStart, repoFingerprint(repo));
});

test("worktree is created once and reused on resume", () => {
  const { repo, root } = setup();
  const { run } = startRun({ repo, topic: "demo", root });
  const a = ensureWorktree(run, "t1");
  const b = ensureWorktree(run, "t1");
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.path, b.path);
  assert.equal(a.branch, "orchestrate/demo--t1");
  assert.ok(fs.existsSync(path.join(a.path, "calc.py")));
  const listed = git(repo, "worktree", "list").split(/\r?\n/).filter((l) => l.includes("t1"));
  assert.equal(listed.length, 1);
});

test("worktree and task work through the CLI", () => {
  const { repo, env } = setup();
  const { run } = runCli(CLI, ["start", "--repo", repo, "--topic", "demo"], { env }).json;
  const w = runCli(CLI, ["worktree", "--run", run, "--id", "t1"], { env });
  assert.equal(w.code, 0, w.err);
  assert.equal(w.json.created, true);
  const t = runCli(CLI, ["task", "--run", run, "--id", "t1", "--set", "status=running", "--set", "title=Add sub"], { env });
  assert.equal(t.code, 0, t.err);
  assert.equal(t.json.status, "running");
  assert.equal(runCli(CLI, ["task", "--run", run, "--id", "t1", "--set", "bogus=1"], { env }).code, 2);
  assert.equal(runCli(CLI, ["status", "--run", run], { env }).json.tasks.t1.title, "Add sub");
});

test("task rejects unknown keys and statuses", () => {
  const { repo, root } = setup();
  const { run } = startRun({ repo, topic: "demo", root });
  assert.throws(() => setTask(run, "t1", { bogus: 1 }), /unknown task field/);
  assert.throws(() => setTask(run, "t1", { status: "done" }), /status/);
  assert.throws(() => setTask(run, "t1", { tests: "maybe" }), /tests/);
  assert.throws(() => setTask(run, "../x", { status: "running" }), /task id/);
  setTask(run, "t1", { status: "running", worker: "GPT-6.1-Sol via Codex CLI" });
  assert.equal(readLedger(run).tasks.t1.worker, "GPT-6.1-Sol via Codex CLI");
  assert.match(fs.readFileSync(path.join(run, "ledger.md"), "utf8"), /GPT-6\.1-Sol via Codex CLI/);
  setTask(run, "t1", { fixRounds: "2" });
  assert.equal(readLedger(run).tasks.t1.status, "running");
  assert.equal(readLedger(run).tasks.t1.fixRounds, 2);
});

test("status: tipMatches follows the passed tasks' commits", () => {
  const { repo, root } = setup();
  const { run, runWorktree } = startRun({ repo, topic: "demo", root });
  assert.equal(runStatus(run).tipMatches, true);
  const commit = (name) => {
    fs.writeFileSync(path.join(runWorktree, name), name);
    git(runWorktree, "add", name);
    git(runWorktree, "commit", "-q", "-m", name);
    return git(runWorktree, "rev-parse", "HEAD").trim();
  };
  const c1 = commit("a.txt");
  assert.equal(runStatus(run).tipMatches, false);
  setTask(run, "t1", { status: "passed", commit: c1 });
  assert.equal(runStatus(run).tipMatches, true);
  const c2 = commit("b.txt");
  assert.equal(runStatus(run).tipMatches, false);
  setTask(run, "t2", { status: "passed", commit: c2 });
  const s = runStatus(run);
  assert.equal(s.tipMatches, true);
  assert.equal(s.runTip, c2);
  setTask(run, "t3", { status: "passed" });
  assert.equal(runStatus(run).tipMatches, false);
});

test("the default run root is not under any tool's config folder", async () => {
  const { runRoot, toolConfigDirHit } = await import("../plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs");
  const saved = process.env.MMO_RUN_ROOT;
  delete process.env.MMO_RUN_ROOT;
  try {
    assert.equal(toolConfigDirHit(runRoot()), null);
    assert.ok(runRoot().endsWith("orchestrate-runs"));
  } finally { if (saved !== undefined) process.env.MMO_RUN_ROOT = saved; }
});

test("refuses a run root inside ~/.claude, ~/.codex, ~/.cursor or ~/.gemini (any case)", async () => {
  const { toolConfigDirHit } = await import("../plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs");
  const home = tmpDir("home");
  for (const d of [".claude", ".codex", ".cursor", ".gemini"]) assert.equal(toolConfigDirHit(path.join(home, d, "orchestrate"), home), d);
  assert.equal(toolConfigDirHit(path.join(home, ".claude"), home), ".claude");
  assert.equal(toolConfigDirHit(path.join(home, ".claudex", "x"), home), null);
  assert.equal(toolConfigDirHit(path.join(home, "orchestrate-runs"), home), null);
  if (process.platform === "win32") assert.equal(toolConfigDirHit(path.join(home, ".CLAUDE", "x"), home), ".claude");
});

test("toolConfigDirHit resolves links and short names of the deepest existing ancestor, and honours CLAUDE_CONFIG_DIR and CODEX_HOME", async (t) => {
  const { toolConfigDirHit } = await import("../plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs");
  const home = tmpDir("home2");
  const cfg = tmpDir("cfg"), codex = tmpDir("codexhome");
  assert.equal(toolConfigDirHit(path.join(cfg, "runs", "x"), home, { CLAUDE_CONFIG_DIR: cfg }), "CLAUDE_CONFIG_DIR");
  assert.equal(toolConfigDirHit(path.join(codex, "a"), home, { CODEX_HOME: codex }), "CODEX_HOME");
  assert.equal(toolConfigDirHit(path.join(cfg, "runs"), home, {}), null);
  assert.equal(toolConfigDirHit(path.join(cfg, "runs"), home, { CLAUDE_CONFIG_DIR: "" }), null);
  // config vars pointing at home itself or a filesystem root are not config folders
  assert.equal(toolConfigDirHit(path.join(home, "orchestrate-runs", "x"), home, { CLAUDE_CONFIG_DIR: home, CODEX_HOME: path.parse(home).root }), null);
  // a link that leads into ~/.claude, with the run root not yet created below it
  fs.mkdirSync(path.join(home, ".claude"));
  const link = path.join(tmpDir("lnk"), "alias");
  try { fs.symlinkSync(path.join(home, ".claude"), link, "junction"); } catch { t.skip("cannot create links here"); return; }
  assert.equal(toolConfigDirHit(path.join(link, "orchestrate", "run1"), home, {}), ".claude");
});

test("start refuses a run root under ~/.claude with exit 7 and a reason", () => {
  const { repo } = setup();
  const root = path.join(os.homedir(), ".claude", "orchestrate-test-never-created");
  const r = runCli(CLI, ["start", "--repo", repo, "--topic", "demo"], { env: { MMO_RUN_ROOT: root } });
  assert.equal(r.code, 7);
  assert.match(r.json.reason, /must not be inside ~\/\.claude.*sensitive/);
  assert.ok(!fs.existsSync(root));
});
