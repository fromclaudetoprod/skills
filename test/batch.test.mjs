import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, runCli } from "./helpers.mjs";
import { parseResult, usageRow } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";

const REVIEW = fileURLToPath(new URL("../plugins/multi-model-review/skills/multi-model-review/review.mjs", import.meta.url));

// A stub codex. A brief containing BAD always fails; FLAKY fails the first time only; every run logs start/end times
// to STUB_LOG so the test can see how many overlapped.
const STUB = String.raw`import fs from "node:fs";
const brief = fs.readFileSync(0, "utf8");
const a = process.argv.slice(2);
const out = a[a.indexOf("-o") + 1].replace(/^"|"$/g, "");
fs.appendFileSync(process.env.STUB_LOG, "start " + Date.now() + "\n");
await new Promise((r) => setTimeout(r, 250));
fs.appendFileSync(process.env.STUB_LOG, "end " + Date.now() + "\n");
const seen = out + ".seen";
if (brief.includes("BAD") || (brief.includes("FLAKY") && !fs.existsSync(seen))) {
  fs.writeFileSync(seen, "x");
  console.error("boom: network down");
  process.exit(1);
}
fs.writeFileSync(out, "fine\nVERDICT: AGREE\n");
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 7 } }));
`;

function setup(briefs) {
  const bin = tmpDir("bin");
  fs.writeFileSync(path.join(bin, "stub.mjs"), STUB);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0stub.mjs" %*\r\n');
  else { fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nexec node "$(dirname "$0")/stub.mjs" "$@"\n'); fs.chmodSync(path.join(bin, "codex"), 0o755); }
  const root = tmpDir("batch");
  const outDir = path.join(root, "out");
  fs.mkdirSync(outDir);
  const log = path.join(root, "stub.log");
  const items = briefs.map((text, i) => {
    const brief = path.join(root, `b${i}.md`);
    fs.writeFileSync(brief, text);
    return { brief, tool: "codex", model: "m1", out: path.join(outDir, `r${i}.md`) };
  });
  const manifest = path.join(root, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify(items));
  const env = { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json"), STUB_LOG: log };
  const batch = (...extra) => runCli(REVIEW, ["batch", manifest, ...extra], { env });
  const usage = () => fs.readFileSync(path.join(outDir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const maxOverlap = () => {
    let now = 0, max = 0;
    for (const l of fs.readFileSync(log, "utf8").trim().split("\n")) { now += l.startsWith("start") ? 1 : -1; max = Math.max(max, now); }
    return max;
  };
  return { root, outDir, manifest, batch, usage, maxOverlap };
}

test("batch runs every item, writes one status file and exits 0", () => {
  const { root, outDir, batch } = setup(["one", "two", "three", "four"]);
  const r = batch();
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.ok, 4);
  assert.equal(r.json.failed, 0);
  const file = JSON.parse(fs.readFileSync(path.join(root, "batch-status.json"), "utf8"));
  assert.deepEqual(file, r.json);
  assert.equal(file.items.length, 4);
  for (const [i, it] of file.items.entries()) {
    assert.equal(it.status, "ok");
    assert.equal(it.out, path.join(outDir, `r${i}.md`));
    assert.equal(it.verdict, "AGREE");
    assert.equal(it.attempts, 1);
    assert.equal(typeof it.durationMs, "number");
    assert.equal(it.error, null);
    assert.match(fs.readFileSync(it.out, "utf8"), /VERDICT: AGREE/);
  }
});

test("batch honours the default concurrency of 3 and --concurrency", () => {
  const a = setup(["1", "2", "3", "4", "5", "6"]);
  assert.equal(a.batch().code, 0);
  assert.equal(a.maxOverlap(), 3);
  const b = setup(["1", "2", "3", "4"]);
  assert.equal(b.batch("--concurrency", "1").code, 0);
  assert.equal(b.maxOverlap(), 1);
});

test("batch retries a failed item once and reports the attempts", () => {
  const { batch } = setup(["fine", "FLAKY"]);
  const r = batch();
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(r.json.items.map((i) => [i.status, i.attempts]), [["ok", 1], ["ok", 2]]);
});

test("batch marks an item that fails twice as failed, keeps going, and exits 7", () => {
  const { batch, maxOverlap } = setup(["fine", "BAD", "fine too"]);
  const r = batch("--status", path.join(tmpDir("st"), "s.json"));
  assert.equal(r.code, 7);
  assert.equal(r.json.ok, 2);
  assert.equal(r.json.failed, 1);
  const bad = r.json.items[1];
  assert.equal(bad.status, "failed");
  assert.equal(bad.attempts, 2);
  assert.match(bad.error, /exit 2/);
  assert.equal(r.json.items[2].status, "ok");
  assert.ok(maxOverlap() >= 1);
});

test("batch rejects a bad manifest before running anything", () => {
  const { root, manifest, batch } = setup(["one"]);
  const items = JSON.parse(fs.readFileSync(manifest, "utf8"));
  fs.writeFileSync(manifest, JSON.stringify([...items, { ...items[0] }]));
  let r = batch();
  assert.equal(r.code, 2);
  assert.match(r.err, /same out/);
  fs.writeFileSync(manifest, JSON.stringify([{ ...items[0], tool: "nope" }]));
  r = batch();
  assert.equal(r.code, 2);
  assert.match(r.err, /item 1.*--tool|tool/);
  fs.writeFileSync(manifest, "{ not json");
  assert.equal(batch().code, 2);
  assert.equal(batch("--concurrency", "0").code, 2);
  assert.equal(fs.existsSync(path.join(root, "stub.log")), false);
});

test("every run appends one usage line with timing, exit status and tokens, and never the brief", () => {
  const { batch, usage } = setup(["SECRET-BRIEF-TEXT one", "SECRET-BRIEF-TEXT BAD"]);
  const r = batch("--concurrency", "1");
  assert.equal(r.code, 7);
  const rows = usage();
  // item 1 once, the failing item twice (the retry is a second run)
  assert.equal(rows.length, 3);
  const ok = rows[0];
  assert.equal(ok.tool, "codex");
  assert.equal(ok.model, "m1");
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.status, "available");
  assert.equal(typeof ok.durationMs, "number");
  assert.ok(ok.durationMs >= 200);
  assert.ok(!Number.isNaN(Date.parse(ok.at)));
  assert.equal(ok.inputTokens, 50);
  assert.equal(ok.outputTokens, 7);
  const bad = rows[1];
  assert.equal(bad.exitCode, 2);
  assert.equal(bad.inputTokens, null);
  assert.equal(bad.outputTokens, null);
  assert.equal(bad.costUsd, null);
  assert.ok(!JSON.stringify(rows).includes("SECRET-BRIEF-TEXT"));
});

test("a single run logs usage too, even when the tool reports no tokens", () => {
  const { root, outDir, usage } = setup(["one"]);
  fs.writeFileSync(path.join(root, "b.md"), "BAD");
  const bin = tmpDir("bin2");
  fs.writeFileSync(path.join(bin, "stub.mjs"), STUB);
  fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nexec node "$(dirname "$0")/stub.mjs" "$@"\n'); fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") return;
  const env = { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json"), STUB_LOG: path.join(root, "s.log") };
  const r = runCli(REVIEW, ["run", "--tool", "codex", "--model", "m1", "--brief", path.join(root, "b.md"), "--out", path.join(outDir, "x.md")], { env });
  assert.equal(r.code, 2);
  const rows = usage();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exitCode, 2);
  assert.equal(rows[0].inputTokens, null);
});

test("usageRow: tokens where reported, null where not, and no extra fields", () => {
  const base = { tool: "cursor", model: "m", sessionId: null, reply: "r.md", durationMs: 12, exitCode: 0, status: "available" };
  const none = usageRow(base, null, "2026-10-26T00:00:00.000Z");
  assert.deepEqual(none, { at: "2026-10-26T00:00:00.000Z", ...base, inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null });
  const some = usageRow(base, { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2, costUsd: null }, "t");
  assert.equal(some.inputTokens, 5);
});

test("cursor without usage parses to null; codex 'tokens used' line is picked up; claude json gives usage", () => {
  assert.equal(parseResult("cursor", { out: JSON.stringify({ type: "result", result: "ok" }) }).usage, null);
  const c = parseResult("codex", { out: "review text", err: "tokens used\n12,345\n" });
  assert.deepEqual(c.usage, { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: 12345, costUsd: null });
  const j = parseResult("codex", { out: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } }), err: "tokens used 99" });
  assert.equal(j.usage.inputTokens, 1);
  const cl = parseResult("claude", { out: JSON.stringify({ type: "result", result: "x", usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.02 }) });
  assert.equal(cl.usage.outputTokens, 4);
  assert.equal(cl.usage.costUsd, 0.02);
});
