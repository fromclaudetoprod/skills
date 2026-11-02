import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { effortArgs, effortsFor, checkEffort, codexEffortLevels, companies, UsageError }
  from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { workerArgs } from "../plugins/multi-model-review/skills/multi-model-orchestrate/workers.mjs";
import { renderLedger } from "../plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs";
import { tmpDir } from "./helpers.mjs";

const has = (a, ...seq) => a.some((_, i) => seq.every((v, j) => a[i + j] === v));

test("effortArgs sets the level on each tool's own flag, and nothing without one", () => {
  assert.deepEqual(effortArgs("codex", "medium"), ["-c", "model_reasoning_effort=medium"]);
  assert.deepEqual(effortArgs("claude", "high"), ["--effort", "high"]);
  assert.deepEqual(effortArgs("copilot", "xhigh"), ["--reasoning-effort", "xhigh"]);
  assert.deepEqual(effortArgs("gemini", "high"), []);
  assert.deepEqual(effortArgs("codex", null), []);
});

test("checkEffort refuses levels a tool cannot take", () => {
  checkEffort("codex", "xhigh");
  checkEffort("copilot", "minimal");
  checkEffort("codex", "ultra", { allowUltra: true });
  assert.throws(() => checkEffort("codex", "ultra"), UsageError);       // workers never get ultra
  assert.throws(() => checkEffort("claude", "ultra", { allowUltra: true }), UsageError);
  assert.throws(() => checkEffort("claude", "minimal"), UsageError);
  assert.throws(() => checkEffort("gemini", "high"), UsageError);
  assert.throws(() => checkEffort("cursor", "high"), UsageError);
  assert.throws(() => checkEffort("codex", "medium; rm"), UsageError);
  assert.throws(() => checkEffort("codex", null), UsageError);          // --effort with no value
});

test("Codex levels come from its model cache, and only for Codex", () => {
  const home = tmpDir("codex");
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6.1-terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
    { slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
  ] }));
  const levels = codexEffortLevels(home);
  assert.deepEqual(effortsFor("codex", "gpt-6.1-terra", levels), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortsFor("codex", "gpt-6-luna", levels), ["low", "medium"]);
  assert.deepEqual(effortsFor("copilot", "gpt-6-luna", levels), ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(effortsFor("gemini", "gemini-4-argon", levels), null);
});

test("companies groups the menu in pages of three, or one page of up to four", () => {
  const row = (n, family) => ({ n, family, model: `m${n}`, source: "Codex CLI", billing: "plan", status: "available", suggested: false, effort: "medium" });
  const out = companies([row(1, "OpenAI"), row(2, "Google"), row(3, "OpenAI"), row(4, "OpenAI"), row(5, "OpenAI"), row(6, "OpenAI"), row(7, "Google")]);
  assert.deepEqual(out.map((c) => [c.family, c.count]), [["OpenAI", 5], ["Google", 2]]);
  assert.deepEqual(out[0].pages.map((p) => p.map((r) => r.n)), [[1, 3, 4], [5, 6]]);
  assert.deepEqual(out[1].pages.map((p) => p.map((r) => r.n)), [[2, 7]]);
  assert.equal(out[0].pages[0][0].via, "Codex CLI");
});

test("workers pass the chosen effort to every tool that takes one", () => {
  const brief = path.join(tmpDir("brief"), "brief.md");
  fs.writeFileSync(brief, "do it");
  const base = { model: "m1", worktree: "/w/t1", brief, out: "/runs/out.md", platform: "linux", effort: "high" };
  assert.ok(has(workerArgs("codex", base).args, "-c", "model_reasoning_effort=high"));
  assert.ok(has(workerArgs("codex", { ...base, resume: "abc" }).args, "-c", "model_reasoning_effort=high"));
  assert.ok(has(workerArgs("claude", base).args, "--effort", "high"));
  assert.ok(has(workerArgs("copilot", base).args, "--reasoning-effort", "high"));
  const keyFile = path.join(tmpDir("key"), "anthropic.key");
  fs.writeFileSync(keyFile, "sk-ant-" + "x".repeat(30));
  const before = process.env.MMR_ANTHROPIC_KEY_FILE;
  process.env.MMR_ANTHROPIC_KEY_FILE = keyFile;
  try {
    assert.equal(JSON.parse(workerArgs("anthropic", { ...base, effort: "medium" }).input).output_config.effort, "medium");
    assert.equal(JSON.parse(workerArgs("anthropic", { ...base, effort: null }).input).output_config.effort, "high");
  } finally {
    if (before === undefined) delete process.env.MMR_ANTHROPIC_KEY_FILE; else process.env.MMR_ANTHROPIC_KEY_FILE = before;
  }
  // No effort: no flag, the tool's own default as before.
  assert.ok(!workerArgs("codex", { ...base, effort: null }).args.some((a) => String(a).startsWith("model_reasoning_effort")));
  assert.ok(!workerArgs("claude", { ...base, effort: null }).args.includes("--effort"));
});

test("the ledger shows the effort next to the worker", () => {
  const md = renderLedger({ topic: "t", runBranch: "r", userBranch: "main", base: "abc", tasks: { a: { worker: "Codex gpt-6.1-terra", effort: "medium" } } });
  assert.match(md, /Codex gpt-6\.1-terra \(medium effort\)/);
});
