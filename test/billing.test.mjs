import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { billingOf } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { tmpDir } from "./helpers.mjs";

const codexHomeWith = (auth) => {
  const dir = tmpDir("codexhome");
  if (auth !== undefined) fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(auth));
  return dir;
};

test("claude on a login is plan and same budget", () => {
  const b = billingOf("claude", { env: {} });
  assert.equal(b.paidBy, "plan");
  assert.equal(b.source, "Claude CLI");
  assert.equal(b.label, "uses your Claude limits (same budget as this session)");
  assert.equal(b.sameBudgetAsSession, true);
  assert.equal(b.needsConfirm, false);
});

test("claude with ANTHROPIC_API_KEY is api", () => {
  const b = billingOf("claude", { env: { ANTHROPIC_API_KEY: "sk-x" } });
  assert.equal(b.paidBy, "api");
  assert.equal(b.label, "⚠ API costs will apply");
  assert.equal(b.sameBudgetAsSession, false);
  assert.equal(b.needsConfirm, true);
});

test("claude on Bedrock or Vertex is api", () => {
  assert.equal(billingOf("claude", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }).paidBy, "api");
  assert.equal(billingOf("claude", { env: { CLAUDE_CODE_USE_VERTEX: "1" } }).paidBy, "api");
});

test("codex chatgpt login is plan", () => {
  const codexHome = codexHomeWith({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {} });
  const b = billingOf("codex", { env: {}, codexHome });
  assert.equal(b.source, "Codex CLI");
  assert.equal(b.paidBy, "plan");
  assert.equal(b.label, "uses your ChatGPT plan");
  assert.equal(b.needsConfirm, false);
});

test("codex api key is api", () => {
  const b = billingOf("codex", { env: {}, codexHome: codexHomeWith({ auth_mode: "apikey", OPENAI_API_KEY: "sk-y" }) });
  assert.equal(b.paidBy, "api");
  assert.equal(b.label, "⚠ API costs will apply");
  assert.equal(b.needsConfirm, true);
});

test("codex without auth.json is unknown", () => {
  const b = billingOf("codex", { env: {}, codexHome: codexHomeWith() });
  assert.equal(b.paidBy, "unknown");
  assert.equal(b.label, "may be billed by API key; check");
  assert.equal(b.needsConfirm, true);
});

test("gemini is always api", () => {
  const b = billingOf("gemini", { env: {} });
  assert.equal(b.source, "Gemini CLI");
  assert.equal(b.label, "⚠ API costs will apply");
  assert.equal(b.needsConfirm, true);
});

test("copilot and cursor are plan", () => {
  const co = billingOf("copilot", { env: {} });
  const cu = billingOf("cursor", { env: {} });
  assert.equal(co.label, "uses Copilot credits");
  assert.equal(co.source, "GitHub Copilot CLI");
  assert.equal(cu.label, "uses your Cursor plan");
  assert.equal(cu.source, "Cursor CLI");
  assert.equal(co.needsConfirm || cu.needsConfirm, false);
});
