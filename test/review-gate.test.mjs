import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, runCli, makeRepo } from "./helpers.mjs";

const REVIEW = fileURLToPath(new URL("../plugins/multi-model-review/skills/multi-model-review/review.mjs", import.meta.url));

// A stub codex that writes its reply and, if STUB_TOUCH names a file, appends to it (a reviewer that wrote).
const STUB = String.raw`import fs from "node:fs";
fs.readFileSync(0, "utf8");
if (process.env.STUB_TOUCH) fs.appendFileSync(process.env.STUB_TOUCH, "stray\n");
const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf("-o") + 1].replace(/^"|"$/g, ""), "looks fine\nVERDICT: AGREE\n");
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }));
`;

function setup() {
  const bin = tmpDir("bin");
  fs.writeFileSync(path.join(bin, "stub.mjs"), STUB);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0stub.mjs" %*\r\n');
  else { fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nexec node "$(dirname "$0")/stub.mjs" "$@"\n'); fs.chmodSync(path.join(bin, "codex"), 0o755); }
  const root = tmpDir("rev");
  const repo = makeRepo(path.join(root, "repo"));
  fs.writeFileSync(path.join(root, "b.md"), "brief");
  const env = { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json") };
  const run = (extra = {}) => runCli(REVIEW, ["run", "--tool", "codex", "--model", "m1", "--brief", path.join(root, "b.md"),
    "--out", path.join(root, "out", "r1.md"), "--repo", repo], { env: { ...env, ...extra } });
  fs.mkdirSync(path.join(root, "out"));
  return { repo, run };
}

test("review on a clean repo reports an unchanged tree", () => {
  const { run } = setup();
  const r = run();
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.treeChanged, false);
  assert.equal(r.json.verdict, "AGREE");
});

test("review exits 5 when the reviewer writes a new file", () => {
  const { repo, run } = setup();
  const r = run({ STUB_TOUCH: path.join(repo, "stray.txt") });
  assert.equal(r.code, 5);
  assert.equal(r.json.treeChanged, true);
});

test("review exits 5 on a re-edit of an already-modified file (a dirty worktree)", () => {
  const { repo, run } = setup();
  fs.appendFileSync(path.join(repo, "calc.py"), "# task work\n");
  const quiet = run();
  assert.equal(quiet.code, 0, quiet.err + quiet.out);
  assert.equal(quiet.json.treeChanged, false);
  const r = run({ STUB_TOUCH: path.join(repo, "calc.py") });
  assert.equal(r.code, 5);
  assert.equal(r.json.treeChanged, true);
});
