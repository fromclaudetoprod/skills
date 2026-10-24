import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, makeRepo, git, runCli } from "./helpers.mjs";
import { jsonObjects, sumUsage, splitVariant, familyOf, parseResult, classifyFailure, safePath, UsageError, record, accessFile }
  from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";

const REVIEW = fileURLToPath(new URL("../plugins/multi-model-review/skills/multi-model-review/review.mjs", import.meta.url));

test("jsonObjects parses one doc, an array, and JSON lines", () => {
  assert.deepEqual(jsonObjects('{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(jsonObjects('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(jsonObjects('{"a":1}\nnoise\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
});

test("sumUsage totals tokens and counts turns without cost", () => {
  assert.deepEqual(
    sumUsage([{ inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, { inputTokens: 3, outputTokens: 1 }]),
    { turns: 2, inputTokens: 13, outputTokens: 6, costUsd: 0.01, turnsWithoutCost: 1, cachedInputTokens: 0 });
});

test("splitVariant folds effort and fast", () => {
  assert.deepEqual(splitVariant("grok-4.7-high-fast"), { base: "grok-4.7", effort: "high", fast: true, thinking: false });
});

test("familyOf", () => {
  assert.equal(familyOf("gpt-6.1-sol"), "OpenAI");
  assert.equal(familyOf("claude-haiku-5-5"), "Anthropic");
  assert.equal(familyOf("grok-4.7"), "xAI");
  assert.equal(familyOf("gemini-4-argon"), "Google");
});

test("parseResult claude reads result, session and usage", () => {
  const out = JSON.stringify({ type: "result", result: "hi", session_id: "s1",
    usage: { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.02 });
  const p = parseResult("claude", { out }, {});
  assert.equal(p.text, "hi");
  assert.equal(p.sessionId, "s1");
  assert.equal(p.usage.inputTokens, 7);
  assert.equal(p.usage.cachedInputTokens, 2);
  assert.equal(p.usage.outputTokens, 3);
  assert.equal(p.usage.costUsd, 0.02);
});

test("parseResult codex reads thread id and turn usage", () => {
  const out = [{ type: "thread.started", thread_id: "t9" },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } }].map((e) => JSON.stringify(e)).join("\n");
  const p = parseResult("codex", { out }, {});
  assert.equal(p.sessionId, "t9");
  assert.equal(p.usage.inputTokens, 100);
  assert.equal(p.usage.cachedInputTokens, 40);
});

test("classifyFailure", () => {
  assert.deepEqual(classifyFailure({ code: 1, err: "Error: model gpt-x not available on your plan" }), { status: "unavailable", exitCode: 3, note: undefined });
  const capped = classifyFailure({ code: 1, err: "usage limit reached" });
  assert.equal(capped.exitCode, 4);
  assert.equal(capped.status, "capped");
  assert.equal(classifyFailure({ code: 1, err: "session abc not found" }, { resume: "abc" }).exitCode, 6);
  const other = classifyFailure({ code: 1, err: "sandbox denied" });
  assert.equal(other.exitCode, 2);
  assert.equal(other.status, null);
});

test("classifyFailure tolerates missing output fields and passes success through", () => {
  assert.equal(classifyFailure({ code: 1 }).exitCode, 2);
  assert.equal(classifyFailure({ code: null, spawnError: new Error("spawn ENOENT") }).exitCode, 2);
  assert.deepEqual(classifyFailure({ code: 0 }), { status: "available", exitCode: 0, note: undefined });
});

test("safePath throws UsageError on a quote", () => {
  assert.throws(() => safePath('C:\\a"b', "x"), UsageError);
});

test("accessFile reads MMR_ACCESS_FILE at call time and record writes there", () => {
  const file = path.join(tmpDir("access"), "access.json");
  const saved = process.env.MMR_ACCESS_FILE;
  process.env.MMR_ACCESS_FILE = file;
  try {
    assert.equal(accessFile(), file);
    record("codex", "gpt-x", "available", "ok");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).codex["gpt-x"].status, "available");
  } finally { if (saved === undefined) delete process.env.MMR_ACCESS_FILE; else process.env.MMR_ACCESS_FILE = saved; }
});

test("review.mjs runs as a CLI: usage errors exit 2 with a message, record writes the access file", () => {
  const dir = tmpDir("cli");
  const env = { MMR_ACCESS_FILE: path.join(dir, "access.json") };
  const bad = runCli(REVIEW, ["record", "bogus", "m", "available"], { env });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown tool bogus/);
  const ok = runCli(REVIEW, ["record", "codex", "gpt-x", "available"], { env });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.json, { ok: true });
});

test("makeRepo builds a repo on main whose path has a space", () => {
  const dir = makeRepo(path.join(tmpDir("repo"), "r"));
  assert.match(dir, / /);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
  assert.equal(git(dir, "ls-files").trim(), "calc.py");
});
