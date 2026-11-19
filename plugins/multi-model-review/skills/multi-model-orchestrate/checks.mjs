// The check gate: the commands a task must pass before anyone reviews it, run in the task's worktree.
// Zero dependencies. The commands come from the user's own repo folder (never the worktree, so a worker cannot rewrite
// its own gate) and run through the shell, because they are the user's own command lines.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
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
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 240) bad("\"timeoutMinutes\" must be a number from 0 to 240");
  return value;
}

// Commands passed with --cmd when the repo has no checks file. Same rules as the file.
export function checksFromCmds(cmds) {
  const bad = (why) => { throw new UsageError(`--cmd: ${why}`); };
  return { checks: cleanChecks(cmds.map((run, i) => ({ name: cmds.length === 1 ? "tests" : `check ${i + 1}`, run })), bad), timeoutMinutes: DEFAULT_TIMEOUT_MINUTES };
}

// Files tests leave behind. The manager deletes them before commit, so they never count as a change to the task.
const ARTIFACT_DIRS = new Set(["__pycache__", ".pytest_cache", "coverage"]);
export function isArtifact(p) {
  const parts = p.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  return parts.some((s) => ARTIFACT_DIRS.has(s)) || parts[parts.length - 1] === ".coverage" || p.endsWith(".pyc");
}

// A hash of the task's files as they stand: tracked changes plus untracked files, test artifacts left out.
export function worktreeFingerprint(wt) {
  const git = (...a) => {
    const r = runGit(wt, a);
    if (r.code !== 0 || r.spawnError) throw new Error(`git ${a[0]} failed in ${wt}: ${(r.err || r.spawnError?.message || "").trim()}`);
    return r.out;
  };
  const h = crypto.createHash("sha256");
  h.update(git("diff", "HEAD", "--binary", "--no-ext-diff"));
  for (const f of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort()) {
    if (isArtifact(f)) continue;
    h.update("\0" + f + "\0");
    try { h.update(fs.readFileSync(path.join(wt, f))); } catch { h.update("unreadable"); }
  }
  return h.digest("hex");
}

// Run each check in wt, stopping at the first failure. Writes the combined output to logFile.
// Returns {result: "passed"|"failed", failed: name|null, durationMs}.
export function executeChecks(config, wt, logFile, { spawn = spawnSync } = {}) {
  const started = Date.now();
  const timeout = Math.round(config.timeoutMinutes * 60_000);
  let log = "";
  let failed = null;
  for (const c of config.checks) {
    log += `== ${c.name}: ${c.run}\n`;
    const t0 = Date.now();
    const r = spawn(c.run, { cwd: wt, shell: true, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    log += (r.stdout ?? "") + (r.stderr ?? "");
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let verdict;
    if (r.error && r.error.code === "ETIMEDOUT") verdict = `failed: timed out after ${config.timeoutMinutes} min`;
    else if (r.error) verdict = `failed: could not run (${r.error.message})`;
    else if (r.status !== 0) verdict = `failed (exit ${r.status ?? r.signal})`;
    else verdict = "passed";
    log += `\n== ${c.name}: ${verdict} in ${secs}s\n`;
    if (verdict !== "passed") { failed = c.name; break; }
  }
  if (Buffer.byteLength(log) > LOG_CAP) log = Buffer.from(log).subarray(Buffer.byteLength(log) - LOG_CAP).toString("utf8") + "\n(log cut to its last 2 MB)\n";
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, log);
  return { result: failed ? "failed" : "passed", failed, durationMs: Date.now() - started };
}
