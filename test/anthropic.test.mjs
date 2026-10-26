import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { anthropicEnv, billingOf, parseResult, TOOLS, UsageError } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { tmpDir } from "./helpers.mjs";

test("anthropic is a tool and is billed as API", () => {
  assert.ok(TOOLS.includes("anthropic"));
  const b = billingOf("anthropic", { env: {} });
  assert.equal(b.paidBy, "api");
  assert.equal(b.source, "Anthropic API (ant)");
  assert.match(b.label, /^⚠ API costs will apply/);
  assert.equal(b.sameBudgetAsSession, false);
  assert.equal(b.needsConfirm, true);
});

test("anthropic reply: text blocks joined, thinking skipped, usage summed", () => {
  const msg = { type: "message", stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "" }, { type: "text", text: "Looks good." }, { type: "text", text: "VERDICT: AGREE" }],
    usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } };
  const { text, usage } = parseResult("anthropic", { out: JSON.stringify(msg) });
  assert.equal(text, "Looks good.\nVERDICT: AGREE");
  assert.deepEqual(usage, { inputTokens: 150, cachedInputTokens: 30, outputTokens: 40, costUsd: null });
});

test("anthropic refusal and cut-off replies are marked", () => {
  const refused = parseResult("anthropic", { out: JSON.stringify({ type: "message", stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber" }, content: [], usage: {} }) });
  assert.match(refused.text, /declined this request: cyber/);
  const cut = parseResult("anthropic", { out: JSON.stringify({ type: "message", stop_reason: "max_tokens",
    content: [{ type: "text", text: "partial" }], usage: {} }) });
  assert.match(cut.text, /^partial\n\n\(reply cut off/);
});

test("the API key comes from its own file and only into the child env", () => {
  const dir = tmpDir("antkey");
  const file = path.join(dir, "anthropic.key");
  const before = process.env.MMR_ANTHROPIC_KEY_FILE;
  process.env.MMR_ANTHROPIC_KEY_FILE = file;
  try {
    assert.throws(() => anthropicEnv(), UsageError);
    fs.writeFileSync(file, "not-a-key\n");
    assert.throws(() => anthropicEnv(), UsageError);
    fs.writeFileSync(file, "sk-ant-api03-" + "x".repeat(40) + "\n");
    const env = anthropicEnv();
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-api03-" + "x".repeat(40));
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.notEqual(process.env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
  } finally {
    if (before === undefined) delete process.env.MMR_ANTHROPIC_KEY_FILE; else process.env.MMR_ANTHROPIC_KEY_FILE = before;
  }
});

test("anthropic workers run only in patch mode and get the key in their own env", async () => {
  const { defaultMode, workerArgs, PATCH_TOOLS } = await import("../plugins/multi-model-review/skills/multi-model-orchestrate/workers.mjs");
  assert.equal(defaultMode("anthropic", "linux"), "patch");
  assert.equal(defaultMode("anthropic", "win32"), "patch");
  assert.ok(PATCH_TOOLS.includes("anthropic"));
  const dir = tmpDir("antworker");
  const brief = path.join(dir, "task.md"); fs.writeFileSync(brief, "Add a README line.\n");
  const keyFile = path.join(dir, "anthropic.key"); fs.writeFileSync(keyFile, "sk-ant-api03-" + "y".repeat(40));
  const before = process.env.MMR_ANTHROPIC_KEY_FILE;
  process.env.MMR_ANTHROPIC_KEY_FILE = keyFile;
  try {
    const w = workerArgs("anthropic", { model: "claude-sonnet-5-5", worktree: dir, brief, out: path.join(dir, "out.md"), mode: "patch", code: "ABC123" });
    assert.deepEqual(w.args, ["messages", "create", "--format", "json"]);
    const body = JSON.parse(w.input);
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.tools, undefined);
    assert.match(body.messages[0].content, /code=ABC123/);
    assert.match(body.messages[0].content, /Add a README line\./);
    assert.equal(w.env.ANTHROPIC_API_KEY, "sk-ant-api03-" + "y".repeat(40));
    assert.notEqual(process.env.ANTHROPIC_API_KEY, w.env.ANTHROPIC_API_KEY);
  } finally {
    if (before === undefined) delete process.env.MMR_ANTHROPIC_KEY_FILE; else process.env.MMR_ANTHROPIC_KEY_FILE = before;
  }
});
