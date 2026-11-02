import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { billingOf, hostFrom, UsageError } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { workerMenu } from "../plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs";
import { tmpDir } from "./helpers.mjs";

const codexHome = () => {
  const dir = tmpDir("codexhome");
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  return dir;
};

test("hostFrom defaults to Claude Code and accepts codex", () => {
  assert.equal(hostFrom(["node", "x"], {}), "claude");
  assert.equal(hostFrom(["node", "x", "menu", "--host", "codex"], {}), "codex");
  assert.equal(hostFrom(["node", "x"], { MMR_HOST: "codex" }), "codex");
  assert.throws(() => hostFrom(["node", "x", "--host", "gemini"], {}), UsageError);
});

test("the host's own tool shares the session budget; the default is unchanged", () => {
  const home = codexHome();
  const claudeAsHost = billingOf("claude", { env: {}, codexHome: home });
  assert.equal(claudeAsHost.label, "uses your Claude limits (same budget as this session)");
  assert.equal(claudeAsHost.sameBudgetAsSession, true);
  assert.equal(billingOf("codex", { env: {}, codexHome: home }).sameBudgetAsSession, false);

  const codexAsHost = billingOf("codex", { env: {}, codexHome: home, host: "codex" });
  assert.equal(codexAsHost.label, "uses your ChatGPT plan (same budget as this session)");
  assert.equal(codexAsHost.sameBudgetAsSession, true);
  const claudeUnderCodex = billingOf("claude", { env: {}, codexHome: home, host: "codex" });
  assert.equal(claudeUnderCodex.label, "uses your Claude limits");
  assert.equal(claudeUnderCodex.sameBudgetAsSession, false);
});

test("under a Codex host, OpenAI workers sort after other families", () => {
  process.env.MMR_ACCESS_FILE = path.join(tmpDir("access"), "access.json");
  const m = (id, family) => ({ id, name: null, family, base: id, status: "untested" });
  const fake = () => ({ tools: {
    codex: { installed: true, capped: false, catalog: true, models: [m("gpt-x", "OpenAI")] },
    claude: { installed: true, capped: false, catalog: true, models: [m("claude-x", "Anthropic")] },
  } });
  const order = (host) => workerMenu({ platform: "darwin", detectFn: fake, env: {}, codexHome: codexHome(), host }).map((r) => r.family);
  assert.deepEqual(order("claude"), ["OpenAI", "Anthropic"]);
  assert.deepEqual(order("codex"), ["Anthropic", "OpenAI"]);
});
