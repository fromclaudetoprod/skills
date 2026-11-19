// The check gate: the commands a task must pass before anyone reviews it, run in the task's worktree.
// Zero dependencies. The commands come from the user's own repo folder (never the worktree, so a worker cannot rewrite
// its own gate) and run through the shell, because they are the user's own command lines.
//
// What a check vouches for is a snapshot: the task's base commit plus the exact tree `git add` would commit (test
// artifacts excluded from both). commit takes the same snapshot again and must get the same answer.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError, runGit } from "../multi-model-review/core.mjs";

export const CHECKS_FILE = path.join(".orchestrate", "checks.json");
export const DEFAULT_TIMEOUT_MINUTES = 20;
const LOG_CAP = 2 * 1024 * 1024;
const MAX_CHECKS = 20;

// {checks:[{name, run}], timeoutMinutes} from <repo>/.orchestrate/checks.json; null when there is no such file.
export function readChecks(repo) {
  const file = path.join(repo, CHECKS_FILE);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new UsageError(`could not read ${file}: ${e.message}`);
  }
  const bad = (why) => { throw new UsageError(`${file}: ${why}`); };
  let data;
  try { data = JSON.parse(text); } catch (e) { bad(`not valid JSON (${e.message})`); }
  if (data === null || typeof data !== "object" || Array.isArray(data)) bad("must be an object with a \"checks\" list");
  return { checks: cleanChecks(data.checks, bad), timeoutMinutes: cleanTimeout(data.timeoutMinutes, bad) };
}

function cleanChecks(list, bad) {
  if (!Array.isArray(list) || list.length === 0) bad("\"checks\" must be a non-empty list");
  if (list.length > MAX_CHECKS) bad(`at most ${MAX_CHECKS} checks`);
  return list.map((c, i) => {
    if (c === null || typeof c !== "object") bad(`check ${i + 1} must be an object with "name" and "run"`);
    if (typeof c.run !== "string" || !c.run.trim()) bad(`check ${i + 1} needs a "run" command`);
    if (/[\r\n\0]/.test(c.run)) bad(`check ${i + 1}: "run" must be one line`);
    const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : `check ${i + 1}`;
    if (/[\x00-\x1f\x7f]/.test(name) || name.length > 80) bad(`check ${i + 1}: "name" must be one short line`);
    return { name, run: c.run };
  });
}

function cleanTimeout(value, bad) {
  if (value === undefined) return DEFAULT_TIMEOUT_MINUTES;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 240) bad("\"timeoutMinutes\" must be more than 0 and at most 240");
  return value;
}

// Commands passed with --cmd when the repo has no checks file. Same rules as the file.
export function checksFromCmds(cmds) {
  const bad = (why) => { throw new UsageError(`--cmd: ${why}`); };
  return { checks: cleanChecks(cmds.map((run, i) => ({ name: cmds.length === 1 ? "tests" : `check ${i + 1}`, run })), bad), timeoutMinutes: DEFAULT_TIMEOUT_MINUTES };
}

// Python's test leftovers. They are never committed and never part of a snapshot, and runChecks deletes them before
// the checks run, so any that exist afterwards were made by the checks from the checked source.
export const ARTIFACT_PATHSPECS = [
  ":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/*.pyc", ":(exclude,glob)**/.pytest_cache/**", ":(exclude,glob).coverage",
];
export function isArtifact(p) {
  const parts = p.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  return parts.includes("__pycache__") || parts.includes(".pytest_cache") || p.endsWith(".pyc") || (parts.length === 1 && parts[0] === ".coverage");
}
// The top-most artifact path within p (the __pycache__ folder rather than a file in it), or null.
function artifactRoot(p) {
  const parts = p.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  const i = parts.findIndex((s) => s === "__pycache__" || s === ".pytest_cache");
  if (i >= 0) return parts.slice(0, i + 1).join("/");
  return isArtifact(p) ? parts.join("/") : null;
}

function gitOk(wt, args, env) {
  const r = env
    ? spawnSync("git", ["-C", wt, ...args], { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    : (() => { const x = runGit(wt, args); return { status: x.code, stdout: x.out, stderr: x.err, error: x.spawnError }; })();
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed in ${wt}: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
}

// {head, tree}: the commit the task sits on and the tree `git add -A` (artifacts excluded) would record, built in a
// throwaway index so the real one (which `git add -N` touches) never matters.
export function snapshot(wt) {
  const index = path.join(os.tmpdir(), `mmo-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    const head = gitOk(wt, ["rev-parse", "HEAD"]).trim();
    gitOk(wt, ["read-tree", "HEAD"], env);
    gitOk(wt, ["add", "-A", "--", ".", ...ARTIFACT_PATHSPECS], env);
    const tree = gitOk(wt, ["write-tree"], env).trim();
    return { head, tree };
  } finally { try { fs.rmSync(index, { force: true }); } catch { /* temp file */ } }
}
export const fingerprintOf = (snap) => crypto.createHash("sha256").update(`${snap.head}\0${snap.tree}`).digest("hex");
export const worktreeFingerprint = (wt) => fingerprintOf(snapshot(wt));

// Delete untracked artifacts (ignored or not) so none can be planted ahead of the checks.
export function clearArtifacts(wt) {
  const listed = [
    ...gitOk(wt, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ...gitOk(wt, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean);
  const roots = new Set(listed.map(artifactRoot).filter(Boolean));
  for (const r of roots) fs.rmSync(path.join(wt, r), { recursive: true, force: true });
  return [...roots];
}

// Ignored files changed after the worktree was made and before the checks started, outside dependency folders. They
// can make checks pass yet never reach the commit or the review diff, so the manager must look at them.
const DEP_DIRS = new Set(["node_modules", ".venv", "venv", ".tox", "bin", "obj", "packages", "target", ".gradle", ".nuget", ".next", ".turbo", ".cache", ".mypy_cache", ".ruff_cache"]);
export function ignoredChanges(wt, before) {
  let since;
  try { since = fs.statSync(path.join(wt, ".git")).mtimeMs; } catch { return []; }
  const out = [];
  let seen = 0;
  const visit = (rel) => {
    if (out.length >= 20 || seen > 5000) return;
    const parts = rel.replace(/\/$/, "").split("/");
    if (parts.some((s) => DEP_DIRS.has(s)) || isArtifact(rel)) return;
    let st;
    try { st = fs.lstatSync(path.join(wt, rel)); } catch { return; }
    seen += 1;
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(path.join(wt, rel)); } catch { return; }
      for (const n of names) visit(`${rel.replace(/\/$/, "")}/${n}`);
    } else if (st.mtimeMs > since && st.mtimeMs <= before) out.push(rel);
  };
  for (const e of gitOk(wt, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).split("\0").filter(Boolean)) visit(e);
  return out;
}

// Stop a command and everything it started. On Windows killing cmd.exe alone leaves its children running.
function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch { /* already gone */ }
}

// One check: {code, signal, timedOut, error, output}. Output keeps its last 2 MB.
function runOne(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let output = "", timedOut = false, done = false, child;
    const add = (d) => { output += d; if (output.length > 2 * LOG_CAP) output = output.slice(-LOG_CAP); };
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(grace); resolve({ ...r, output }); };
    let grace = null;
    try {
      child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { resolve({ error, output: "" }); return; }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", add);
    child.stderr.setEncoding("utf8").on("data", add);
    child.on("error", (error) => finish({ error }));
    child.on("close", (code, signal) => finish({ code, signal, timedOut }));
    // A process the command left behind can hold the output open; do not wait on it for long.
    child.on("exit", (code, signal) => { killTree(child); grace = setTimeout(() => finish({ code, signal, timedOut }), 3000); });
  });
}

// Run each check in wt, stopping at the first failure, and write the combined output to logFile. The checks fail if
// they change the task's files. Returns {result, failed, before, after, ignoredChanged, durationMs}.
export async function executeChecks(config, wt, logFile) {
  const started = Date.now();
  const timeout = Math.round(config.timeoutMinutes * 60_000);
  clearArtifacts(wt);
  const ignoredChanged = ignoredChanges(wt, started);
  const before = snapshot(wt);
  let log = "";
  let failed = null;
  for (const c of config.checks) {
    log += `== ${c.name}: ${c.run}\n`;
    const t0 = Date.now();
    const r = await runOne(c.run, wt, timeout);
    log += r.output;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let verdict;
    if (r.timedOut) verdict = `failed: timed out after ${config.timeoutMinutes} min`;
    else if (r.error) verdict = `failed: could not run (${r.error.message})`;
    else if (r.code !== 0) verdict = `failed (exit ${r.code ?? r.signal})`;
    else verdict = "passed";
    log += `\n== ${c.name}: ${verdict} in ${secs}s\n`;
    if (verdict !== "passed") { failed = c.name; break; }
  }
  const after = snapshot(wt);
  if (!failed && (after.tree !== before.tree || after.head !== before.head)) {
    const changed = gitOk(wt, ["diff", "--name-only", before.tree, after.tree]).trim().split("\n").filter(Boolean).slice(0, 20);
    failed = "files changed by the checks";
    log += `\n== The checks changed the task's files, so they did not test what would be committed: ${changed.join(", ") || "(the base commit)"}\n`;
  }
  if (log.length > LOG_CAP) log = "(log cut to its last 2 MB)\n" + log.slice(-LOG_CAP);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, log);
  return { result: failed ? "failed" : "passed", failed, before, ignoredChanged, durationMs: Date.now() - started };
}
