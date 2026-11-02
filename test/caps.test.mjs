import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { capActive, recordOutcome, hiddenTools, readJson, CAP_HOURS }
  from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { tmpDir } from "./helpers.mjs";

const day = (offsetDays) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

test("a cap is trusted for a day, then lapses", () => {
  assert.equal(CAP_HOURS, 24);
  assert.equal(capActive({ status: "capped", date: day(0) }), true);
  assert.equal(capActive({ status: "capped", date: day(-2) }), false);   // the 2026-10-28 cap seen on 11-02
  assert.equal(capActive({ status: "available", date: day(0) }), false);
  assert.equal(capActive(undefined), false);
});

test("a run that works lifts a tool-wide cap", () => {
  const file = path.join(tmpDir("access"), "access.json");
  fs.writeFileSync(file, JSON.stringify({ codex: { __tool: { status: "capped", date: day(0), note: "spend cap" } } }));
  const before = process.env.MMR_ACCESS_FILE;
  process.env.MMR_ACCESS_FILE = file;
  try {
    recordOutcome("codex", "gpt-6.1-terra", { status: "available" }, { out: "", err: "" });
    const a = readJson(file, {});
    assert.equal(a.codex["gpt-6.1-terra"].status, "available");
    assert.equal(a.codex.__tool.status, "available");
    // A cap that says to switch models blocks only that model.
    recordOutcome("codex", "gpt-6-sol", { status: "capped", note: "x" }, { out: "", err: "try a different model" });
    assert.equal(readJson(file, {}).codex.__tool.status, "available");
  } finally {
    if (before === undefined) delete process.env.MMR_ACCESS_FILE; else process.env.MMR_ACCESS_FILE = before;
  }
});

test("hiddenTools names installed tools left out of the menu, and why", () => {
  const out = hiddenTools({
    codex: { installed: true, capped: true, cap: { since: "2026-11-02", note: "spend cap", active: true } },
    copilot: { installed: true, capped: false, note: "Copilot offers only Auto on this account" },
    gemini: { installed: false },
    claude: { installed: true, capped: false },
  });
  assert.deepEqual(out.map((h) => h.tool), ["codex", "copilot"]);
  assert.match(out[0].reason, /2026-11-02.*record codex __tool available/);
});
