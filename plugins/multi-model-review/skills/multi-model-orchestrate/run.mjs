// A multi-model run: the run branch, the run folder, per-task worktrees and the ledger that survives restarts.
// Zero dependencies. Every git call goes through runGit (no shell), so paths and text need no quoting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOLS, MODEL_ID, SESSION_ID, UsageError, safePath, runGit, readJson, repoFingerprint,
} from "../multi-model-review/core.mjs";

// A preflight or landing refusal. The CLI exits 7 and prints the reason.
export class RunRefused extends Error {
  constructor(reason) { super(reason); this.name = "RunRefused"; this.reason = reason; this.exitCode = 7; }
}
// Refusals with their own exit code. All print {ok:false, reason} and exit with exitCode.
export class OutsideChange extends RunRefused {
  constructor(reason) { super(reason); this.name = "OutsideChange"; this.exitCode = 5; }
}
export class NothingToCommit extends RunRefused {
  constructor(reason) { super(reason); this.name = "NothingToCommit"; this.exitCode = 8; }
}
export class Conflict extends RunRefused {
  constructor(reason, files = []) { super(reason); this.name = "Conflict"; this.files = files; }
}

const TOPIC = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
// A task id becomes part of a branch name and a folder name, so also refuse what git refuses in a ref.
const validId = (id) => typeof id === "string" && TASK_ID.test(id) && !id.includes("..") && !id.endsWith(".lock") && !id.endsWith(".");
const checkId = (id) => {
  if (!validId(id)) throw new UsageError(`task id must match ${TASK_ID} and must not contain "..", end in ".lock" or end in ".": ${id}`);
};
const STATUSES = ["pending", "running", "passed", "stalled", "skipped", "failed"];
const TEST_STATES = ["passed", "failed", "not run"];
const TASK_KEYS = ["title", "status", "worker", "tool", "model", "session", "reviewer", "fixRounds", "tests", "commit", "note", "wave"];
const MAX_TEXT = 500;

export const runRoot = () => process.env.MMO_RUN_ROOT || path.join(os.homedir(), ".claude", "orchestrate");
export const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

// Run git in dir. Returns {code, out, err}; throws only when git cannot be started.
function gitRaw(dir, ...args) {
  const r = runGit(dir, args);
  if (r.spawnError) throw new Error(`could not run git: ${r.spawnError.message}`);
  return r;
}
function git(dir, ...args) {
  const r = gitRaw(dir, ...args);
  if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? args[0]} failed in ${dir}: ${r.err.trim()}`);
  return r.out;
}

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// The paths named by `git status --porcelain` text (a rename gives the new path).
export function dirtyPaths(porcelain) {
  return porcelain.split(/\r?\n/).filter((l) => l.length > 3).map((l) => {
    let p = l.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  });
}

export function startRun({ repo, topic, root = runRoot(), date = today(), allowSubmodules = false }) {
  if (typeof topic !== "string" || !TOPIC.test(topic)) throw new UsageError(`topic must match ${TOPIC}: ${topic}`);
  const dir = safePath(repo ?? "", "repo");
  if (!fs.existsSync(dir)) throw new RunRefused(`not a git repository: ${dir} does not exist`);
  const top = gitRaw(dir, "rev-parse", "--show-toplevel");
  if (top.code !== 0) throw new RunRefused(`not a git repository: ${dir}`);
  const repoDir = safePath(top.out.trim(), "repo");
  if (gitRaw(repoDir, "rev-parse", "--verify", "-q", "HEAD").code !== 0) throw new RunRefused("the repository has no commits yet; make a first commit");
  const branch = gitRaw(repoDir, "symbolic-ref", "-q", "--short", "HEAD");
  if (branch.code !== 0) throw new RunRefused("HEAD is detached; make a branch first (git switch -c <name>) and start again");
  if (!allowSubmodules && fs.existsSync(path.join(repoDir, ".gitmodules"))) {
    throw new RunRefused("this repository uses submodules, which worktrees do not populate; pass --allow-submodules to continue anyway");
  }
  const rootDir = safePath(root, "run root");
  if (inside(repoDir, rootDir)) throw new RunRefused(`the run folder must be outside the repository (MMO_RUN_ROOT is inside it): ${rootDir}`);

  const userBranch = branch.out.trim();
  const base = git(repoDir, "rev-parse", "HEAD").trim();
  const userStatusAtStart = git(repoDir, "status", "--porcelain");
  const userFingerprintAtStart = repoFingerprint(repoDir);

  let n = 1;
  const suffix = () => (n === 1 ? "" : `-${n}`);
  while (gitRaw(repoDir, "show-ref", "--verify", "-q", `refs/heads/orchestrate/${topic}${suffix()}`).code === 0
    || fs.existsSync(path.join(rootDir, `${date}-${topic}${suffix()}`))) n++;
  const runBranch = `orchestrate/${topic}${suffix()}`;
  const run = safePath(path.join(rootDir, `${date}-${topic}${suffix()}`), "run");
  const runWorktree = path.join(run, "wt", "_run");

  fs.mkdirSync(path.join(run, "briefs"), { recursive: true });
  git(repoDir, "worktree", "add", "-b", runBranch, runWorktree, "HEAD");
  const dirty = dirtyPaths(userStatusAtStart);
  writeLedger(run, { version: 1, topic, repo: repoDir, base, userBranch, runBranch, runWorktree, userStatusAtStart,
    userFingerprintAtStart, dirty, createdAt: new Date().toISOString(), tasks: {} });
  return { run, runBranch, runWorktree, base, userBranch, dirty };
}

const ledgerFile = (run) => path.join(run, "ledger.json");

export function readLedger(run) {
  const dir = safePath(run ?? "", "run");
  const ledger = readJson(ledgerFile(dir), null);
  if (!ledger || ledger.version !== 1) throw new UsageError(`no run ledger found in ${dir}`);
  return ledger;
}

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderLedger(ledger) {
  const lines = [`# Run ${ledger.topic}`, "",
    `Run branch \`${ledger.runBranch}\` from \`${ledger.userBranch}\` at \`${String(ledger.base).slice(0, 9)}\``, "",
    "| Task | Status | Worker | Reviewer | Fix rounds | Tests | Commit |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const [id, t] of Object.entries(ledger.tasks ?? {})) {
    const commit = t.commit ? String(t.commit).slice(0, 9) : "";
    lines.push(`| ${cell(t.title ? `${id}: ${t.title}` : id)} | ${cell(t.status ?? "pending")} | ${cell(t.worker)} | ${cell(t.reviewer)} | ${cell(t.fixRounds)} | ${cell(t.tests)} | ${cell(commit)} |`);
  }
  return lines.join("\n") + "\n";
}

// Write to a temp file and rename it into place, so a crash never leaves half a ledger.
export function writeLedger(run, ledger) {
  fs.mkdirSync(run, { recursive: true });
  const file = ledgerFile(run);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  fs.renameSync(tmp, file);
  fs.writeFileSync(path.join(run, "ledger.md"), renderLedger(ledger));
}

function checkField(key, value) {
  const bad = (why) => { throw new UsageError(`task field ${key}: ${why}`); };
  if (key === "status") { if (!STATUSES.includes(value)) bad(`must be one of ${STATUSES.join(", ")}`); return value; }
  if (key === "tests") { if (!TEST_STATES.includes(value)) bad(`must be one of ${TEST_STATES.join(", ")}`); return value; }
  if (key === "fixRounds" || key === "wave") {
    const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n) || n < 0 || n > 1000) bad("must be a whole number");
    return n;
  }
  if (typeof value !== "string") bad("must be text");
  if (key === "tool") { if (!TOOLS.includes(value)) bad(`must be one of ${TOOLS.join(", ")}`); return value; }
  if (key === "model") { if (!MODEL_ID.test(value)) bad("is not a valid model id"); return value; }
  if (key === "session") { if (!SESSION_ID.test(value)) bad("is not a valid session id"); return value; }
  if (key === "commit") { if (!/^[0-9a-f]{7,64}$/.test(value)) bad("must be a commit hash"); return value; }
  if (/[\x00-\x1f\x7f]/.test(value) || value.length > MAX_TEXT) bad(`must be one line of at most ${MAX_TEXT} characters`);
  return value;
}

export function setTask(run, id, fields) {
  checkId(id);
  const dir = safePath(run ?? "", "run");
  const ledger = readLedger(dir);
  const clean = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!TASK_KEYS.includes(k)) throw new UsageError(`unknown task field ${k}; allowed: ${TASK_KEYS.join(", ")}`);
    clean[k] = checkField(k, v);
  }
  ledger.tasks[id] = { ...(ledger.tasks[id] ?? {}), ...clean };
  writeLedger(dir, ledger);
  return ledger.tasks[id];
}

export function ensureWorktree(run, id) {
  checkId(id);
  const dir = safePath(run ?? "", "run");
  const ledger = readLedger(dir);
  const branch = `orchestrate/${ledger.topic}--${id}`;
  const wt = path.join(dir, "wt", id);
  if (fs.existsSync(wt)) {
    const head = fs.existsSync(path.join(wt, ".git")) ? gitRaw(wt, "symbolic-ref", "-q", "--short", "HEAD") : { code: 1, out: "" };
    if (head.code === 0 && head.out.trim() === branch) return { path: wt, branch, created: false };
    throw new RunRefused(`${wt} exists but is not a worktree on ${branch}`);
  }
  gitRaw(ledger.repo, "worktree", "prune"); // forget worktrees whose folder was deleted by hand
  const branchExists = gitRaw(ledger.repo, "show-ref", "--verify", "-q", `refs/heads/${branch}`).code === 0;
  if (branchExists) git(ledger.repo, "worktree", "add", wt, branch);
  else git(ledger.repo, "worktree", "add", "-b", branch, wt, ledger.runBranch);
  return { path: wt, branch, created: true };
}

// tipMatches: the run branch is exactly where the ledger says it should be. With no passed tasks that is the base.
// Otherwise the tip is some passed task's commit and every passed task's commit is the tip or an ancestor of it.
export function runStatus(run) {
  const dir = safePath(run ?? "", "run");
  const ledger = readLedger(dir);
  const runTip = git(ledger.repo, "rev-parse", ledger.runBranch).trim();
  const passed = Object.values(ledger.tasks).filter((t) => t.status === "passed");
  let tipMatches;
  if (passed.length === 0) tipMatches = runTip === ledger.base;
  else {
    const full = passed.map((t) => {
      if (!t.commit) return null;
      const r = gitRaw(ledger.repo, "rev-parse", "--verify", "-q", t.commit);
      return r.code === 0 ? r.out.trim() : null;
    });
    tipMatches = full.every(Boolean) && full.includes(runTip)
      && full.every((c) => c === runTip || gitRaw(ledger.repo, "merge-base", "--is-ancestor", c, runTip).code === 0);
  }
  return { ...ledger, runTip, tipMatches };
}

// ---- commit and land ----

// The committer identity comes from the user's own git config; CI machines may have none.
function identity(repo) {
  const get = (k, dflt) => { const r = gitRaw(repo, "config", "--get", k); return r.code === 0 && r.out.trim() ? r.out.trim() : dflt; };
  return ["-c", `user.name=${get("user.name", "Orchestrate")}`, "-c", `user.email=${get("user.email", "orchestrate@localhost")}`];
}

// Commit messages go to git by file, never as an argument. The file is removed afterwards.
function withMessage(run, name, message, fn) {
  const file = path.join(run, name);
  fs.writeFileSync(file, message.endsWith("\n") ? message : message + "\n");
  try { return fn(file); } finally { fs.rmSync(file, { force: true }); }
}

// Every changed or untracked file in dir (a rename gives the new path).
function statusPaths(dir) {
  const parts = git(dir, "status", "--porcelain=v1", "-z", "-uall").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++; // the next entry is the old name
  }
  return out;
}

export function commitTask(run, id, { title, tests, reworkOf } = {}) {
  checkId(id);
  const dir = safePath(run ?? "", "run");
  const ledger = readLedger(dir);
  const t = ledger.tasks[id] ?? {};
  const testsValue = checkField("tests", tests);
  const subject = checkField("title", title ?? t.title ?? "");
  if (!subject.trim()) throw new UsageError("a commit needs a title: pass --title or set the task's title");
  if (reworkOf !== undefined) checkField("commit", reworkOf);

  // 1. Nothing in the user's folder may have changed since the run started. The fingerprint also catches a
  //    further edit to a file that was already dirty, which the status text alone would miss.
  if (repoFingerprint(ledger.repo) !== ledger.userFingerprintAtStart) {
    throw new OutsideChange("the user's folder changed since the run started; nothing was committed. Find out what wrote there before continuing");
  }
  // 2. The task must have changed something.
  const wt = path.join(dir, "wt", id);
  const branch = `orchestrate/${ledger.topic}--${id}`;
  if (!fs.existsSync(wt)) throw new RunRefused(`no worktree for task ${id}: ${wt}`);
  if (git(wt, "status", "--porcelain").trim() === "") throw new NothingToCommit(`task ${id} changed nothing in its worktree`);

  // 3. Commit in the task worktree, with the agent trailers.
  const trailers = [];
  if (t.worker) trailers.push(`Implemented-by: ${t.worker}`);
  if (t.tool && t.session) trailers.push(`Worker-session: ${t.tool} ${t.session}`);
  if (t.reviewer) trailers.push(`Reviewed-by: ${t.reviewer}`);
  trailers.push(`Fix-rounds: ${t.fixRounds ?? 0}`);
  trailers.push(`Tests: ${testsValue}`);
  if (reworkOf) trailers.push(`Rework-of: ${reworkOf}`);
  const who = identity(ledger.repo);
  git(wt, "add", "-A");
  withMessage(dir, `commit-msg-${id}.txt`, `${subject}\n\n${trailers.join("\n")}\n`, (file) =>
    git(wt, ...who, "commit", "-q", "--cleanup=verbatim", "-F", file));
  const taskCommit = git(wt, "rev-parse", "HEAD").trim();
  const files = git(wt, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", taskCommit).split("\0").filter(Boolean);

  // 4. Put it on the run branch.
  const pick = gitRaw(ledger.runWorktree, ...who, "cherry-pick", taskCommit);
  if (pick.code !== 0) {
    const conflicted = gitRaw(ledger.runWorktree, "diff", "--name-only", "--diff-filter=U", "-z").out.split("\0").filter(Boolean);
    gitRaw(ledger.runWorktree, "cherry-pick", "--abort");
    const what = conflicted.length ? `in: ${conflicted.join(", ")}` : `(${pick.err.trim()})`;
    throw new Conflict(`task ${id} conflicts with the run branch ${what}. Its worktree is kept at ${wt}`, conflicted);
  }
  const commit = git(ledger.runWorktree, "rev-parse", "HEAD").trim();

  // 5. The task's worktree and branch are done with.
  git(ledger.repo, "worktree", "remove", "--force", wt);
  gitRaw(ledger.repo, "branch", "-D", branch);

  // 6. Record it.
  setTask(dir, id, { status: "passed", commit, tests: testsValue });
  return { commit, files };
}

export function landRun(run, { mode = "merge" } = {}) {
  if (!["merge", "squash", "uncommitted"].includes(mode)) throw new UsageError(`mode must be merge, squash or uncommitted: ${mode}`);
  const dir = safePath(run ?? "", "run");
  const ledger = readLedger(dir);
  const { repo, base, runBranch, topic } = ledger;

  const here = gitRaw(repo, "symbolic-ref", "-q", "--short", "HEAD");
  if (here.code !== 0 || here.out.trim() !== ledger.userBranch) {
    const now = here.code === 0 ? here.out.trim() : "a detached HEAD";
    throw new RunRefused(`the user's folder is on ${now}, not ${ledger.userBranch}; switch back and land again`);
  }
  const changed = git(repo, "diff", "--name-only", "-z", `${base}..${runBranch}`).split("\0").filter(Boolean);
  const dirty = new Set(statusPaths(repo));
  const overlap = changed.filter((f) => dirty.has(f));
  if (overlap.length) {
    throw new RunRefused(`these files have uncommitted edits in the user's folder and the run changed them too: ${overlap.join(", ")}. Commit or stash them and land again`);
  }

  const commits = Number(git(repo, "rev-list", "--count", `${base}..${runBranch}`).trim());
  const who = identity(repo);
  const passed = Object.entries(ledger.tasks).filter(([, t]) => t.status === "passed");

  if (mode === "merge") {
    if (git(repo, "rev-parse", "HEAD").trim() === base) git(repo, "merge", "--ff-only", runBranch);
    else {
      const r = gitRaw(repo, ...who, "merge", "--no-ff", "-m", `Merge orchestrate run ${topic}`, runBranch);
      if (r.code !== 0) {
        gitRaw(repo, "merge", "--abort");
        throw new Conflict(`the run does not merge cleanly into ${ledger.userBranch}: ${(r.out + r.err).trim()}`);
      }
    }
  } else {
    const r = gitRaw(repo, "merge", "--squash", runBranch);
    if (r.code !== 0) {
      gitRaw(repo, "reset", "--merge"); // safe: no file the run changed had uncommitted edits
      throw new Conflict(`the run does not apply cleanly to ${ledger.userBranch}: ${(r.out + r.err).trim()}`);
    }
    if (mode === "squash") {
      if (gitRaw(repo, "diff", "--cached", "--quiet").code === 0) throw new RunRefused("the run changes nothing compared with the current branch; nothing to commit");
      const lines = passed.map(([tid, t]) => `- ${t.title || tid}${t.worker ? ` (${t.worker})` : ""}`);
      withMessage(dir, "land-msg.txt", `Orchestrate run ${topic}: ${passed.length} tasks\n\n${lines.join("\n")}\n`, (file) =>
        git(repo, ...who, "commit", "-q", "--cleanup=verbatim", "-F", file));
    }
  }

  gitRaw(repo, "worktree", "remove", "--force", ledger.runWorktree);
  writeLedger(dir, { ...readLedger(dir), landed: { mode, at: new Date().toISOString() } });
  return { mode, commits, files: changed, kept: runBranch };
}

// ---- CLI commands ----
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const need = (args, name) => { const v = flag(args, name); if (v === undefined) throw new UsageError(`missing ${name}`); return v; };
const print = (v) => console.log(JSON.stringify(v, null, 2));

export const start = (args) => print(startRun({ repo: need(args, "--repo"), topic: need(args, "--topic"), allowSubmodules: args.includes("--allow-submodules") }));
export const task = (args) => {
  const fields = {};
  args.forEach((a, i) => {
    if (a !== "--set") return;
    const kv = args[i + 1] ?? "";
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new UsageError(`--set needs key=value, got ${kv}`);
    fields[kv.slice(0, eq)] = kv.slice(eq + 1);
  });
  print(setTask(need(args, "--run"), need(args, "--id"), fields));
};
export const worktree = (args) => print(ensureWorktree(need(args, "--run"), need(args, "--id")));
export const status = (args) => print(runStatus(need(args, "--run")));
export const commit = (args) => {
  const tests = need(args, "--tests");
  print(commitTask(need(args, "--run"), need(args, "--id"), {
    tests: tests === "not-run" ? "not run" : tests, title: flag(args, "--title"), reworkOf: flag(args, "--rework-of"),
  }));
};
export const land = (args) => {
  if (args.includes("--squash") && args.includes("--uncommitted")) throw new UsageError("use only one of --squash and --uncommitted");
  print(landRun(need(args, "--run"), { mode: args.includes("--squash") ? "squash" : args.includes("--uncommitted") ? "uncommitted" : "merge" }));
};
