import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { workerMenu, recordWrite } from "../plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs";
import { menu } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { tmpDir, runCli } from "./helpers.mjs";

const model = (id, family) => ({ id, name: null, family, base: id, status: "untested" });
const fake = () => ({ tools: {
  claude: { installed: true, capped: false, catalog: true, models: [model("claude-haiku-5-5", "Anthropic"), model("claude-opus-5-5", "Anthropic")] },
  cursor: { installed: true, capped: false, catalog: true, models: [model("grok-4.7-high", "xAI")] },
  gemini: { installed: false },
} });
const fresh = () => { process.env.MMR_ACCESS_FILE = path.join(tmpDir("access"), "access.json"); };
const rows = (platform = "darwin") => workerMenu({ platform, detectFn: fake, env: {} });

test("haiku is offered and tagged light", () => {
  fresh();
  const r = rows().find((x) => x.model === "claude-haiku-5-5");
  assert.ok(r);
  assert.deepEqual(r.tiers, ["light"]);
});

test("cursor warns only on Windows", () => {
  fresh();
  assert.ok(rows("win32").find((x) => x.tool === "cursor").warnings.includes("⚠ force, no sandbox"));
  assert.ok(!rows("darwin").find((x) => x.tool === "cursor").warnings.includes("⚠ force, no sandbox"));
});

test("failed write test marks experimental", () => {
  fresh();
  recordWrite("cursor", "failed");
  const r = rows().find((x) => x.tool === "cursor");
  assert.equal(r.writeStatus, "failed");
  assert.ok(r.warnings.includes("experimental: may not write on this machine"));
  recordWrite("cursor", "ok");
  assert.equal(rows().find((x) => x.tool === "cursor").writeStatus, "ok");
});

test("rows carry billing", () => {
  fresh();
  const c = rows().filter((x) => x.tool === "claude");
  assert.equal(c.length, 2);
  for (const r of c) {
    assert.equal(r.billing, "uses your Claude limits (same budget as this session)");
    assert.equal(r.sameBudgetAsSession, true);
    assert.equal(r.needsConfirm, false);
  }
});

test("rows are numbered, tiered first (heavy first), non-Anthropic before Anthropic", () => {
  fresh();
  const r = rows();
  assert.deepEqual(r.map((x) => x.n), [1, 2, 3]);
  assert.deepEqual(r.map((x) => x.model), ["grok-4.7-high", "claude-opus-5-5", "claude-haiku-5-5"]);
  assert.equal(r.find((x) => x.tool === "cursor").writeStatus, "untested");
});

test("a tool with no catalog also lists its worker-tier ids", () => {
  fresh();
  const d = () => ({ tools: { claude: { installed: true, capped: false, catalog: false, models: [model("claude-opus-5-5", "Anthropic")] } } });
  const r = workerMenu({ platform: "darwin", detectFn: d, env: {} });
  assert.deepEqual(r.map((x) => x.model), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
});

test("a recorded __write is not a model row in review menu", () => {
  fresh();
  recordWrite("claude", "ok");
  assert.ok(!menu().some((m) => String(m.model).startsWith("__") || m.base === "__write"));
});

test("CLI: record-write prints ok and rejects bad input with exit 2", () => {
  fresh();
  const script = path.resolve("plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs");
  const env = { MMR_ACCESS_FILE: process.env.MMR_ACCESS_FILE };
  assert.deepEqual(runCli(script, ["record-write", "cursor", "ok", "wrote a file"], { env }).json, { ok: true });
  assert.equal(runCli(script, ["record-write", "cursor", "maybe"], { env }).code, 2);
  assert.equal(runCli(script, ["record-write", "nope", "ok"], { env }).code, 2);
});
