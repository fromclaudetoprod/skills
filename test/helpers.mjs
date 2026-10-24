// Shared test helpers. Zero dependencies; run with: node --test "test/*.test.mjs"
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made = [];
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// A fresh temp folder whose name contains a space, so quoting bugs show up. Removed when the process exits.
export function tmpDir(prefix = "mmr") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix} test-`));
  made.push(dir);
  return dir;
}

// Run git in cwd; returns stdout and throws on a non-zero exit.
export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

// A repo on branch main with one commit that contains calc.py.
export function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "calc.py"), "def add(a, b):\n    return a + b\n");
  git(dir, "add", "calc.py");
  git(dir, "commit", "-q", "-m", "Add calc.py");
  return dir;
}

// Run a CLI script with node. json is the parsed stdout, or null when stdout is not one JSON document.
export function runCli(script, args = [], { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", json };
}
