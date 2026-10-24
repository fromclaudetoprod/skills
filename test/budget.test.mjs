import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir, runCli, git, makeRepo } from "./helpers.mjs";

const CLI = path.resolve("plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs");

const STUB = String.raw`import fs from "node:fs";
fs.readFileSync(0, "utf8");
const a = process.argv.slice(2);
const out = a[a.indexOf("-o") + 1].replace(/^"|"$/g, "");
fs.writeFileSync(out, "done\n");
if (process.env.STUB_MARKER) fs.appendFileSync(process.env.STUB_MARKER, "called\n");
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } }));
`;

function setup() {
  const bin = tmpDir("bin");
  fs.writeFileSync(path.join(bin, "stub.mjs"), STUB);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0stub.mjs" %*\r\n');
  else { fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nexec node "$(dirname "$0")/stub.mjs" "$@"\n'); fs.chmodSync(path.join(bin, "codex"), 0o755); }
  const root = tmpDir("run");
  const repo = makeRepo(path.join(root, "repo"));
  const wt = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "task", wt);
  const outDir = path.join(root, "out");
  fs.writeFileSync(path.join(root, "b.md"), "brief");
  const marker = path.join(root, "marker.txt");
  fs.writeFileSync(marker, "");
  const env = { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json"), STUB_MARKER: marker };
  const run = (extra = []) => runCli(CLI, ["work", "--tool", "codex", "--model", "m1", "--mode", "write", "--brief", path.join(root, "b.md"),
    "--worktree", wt, "--out", path.join(outDir, "r1.md"), "--repo", repo, ...extra], { env });
  return { outDir, marker, run };
}

function seed(outDir, rows) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "usage.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("records the task on usage rows", () => {
  const { outDir, run } = setup();
  const r = run(["--task", "t1"]);
  assert.equal(r.code, 0, r.err + r.out);
  const rows = fs.readFileSync(path.join(outDir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).task, "t1");
});

test("reports spend and budget left", () => {
  const { run } = setup();
  const r = run(["--task", "t1", "--budget", "1000"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.taskSpent, 120);
  assert.equal(r.json.budgetLeft, 880);
  assert.equal(r.json.overBudget, false);
});

test("stops before running once the budget is spent", () => {
  const { outDir, marker, run } = setup();
  seed(outDir, [{ task: "t1", inputTokens: 100, outputTokens: 20 }]);
  const r = run(["--task", "t1", "--budget", "100"]);
  assert.equal(r.code, 10, r.err + r.out);
  assert.equal(r.json.overBudget, true);
  assert.equal(r.json.taskSpent, 120);
  assert.equal(r.json.exitCode, null);
  assert.equal(fs.readFileSync(marker, "utf8"), "");
});

test("budget needs a task", () => {
  const { run } = setup();
  assert.equal(run(["--budget", "100"]).code, 2);
});

test("other tasks don't count", () => {
  const { outDir, run } = setup();
  seed(outDir, [{ task: "t2", inputTokens: 900, outputTokens: 100 }]);
  const r = run(["--task", "t1", "--budget", "200"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.taskSpent, 120);
  assert.equal(r.json.budgetLeft, 80);
  assert.equal(r.json.overBudget, false);
});
