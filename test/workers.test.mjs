import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workerArgs, WORKER_ASK, parseNeeds, codexIsolationArgs, configArg } from "../plugins/multi-model-review/skills/multi-model-orchestrate/workers.mjs";
import { runTool } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { tmpDir, runCli, git, makeRepo } from "./helpers.mjs";

const briefFile = path.join(tmpDir("brief"), "brief.md");
fs.writeFileSync(briefFile, "do the thing");
const base = { model: "m1", worktree: "/w/t1", brief: briefFile, out: "/runs/out.md", platform: "linux" };
const args = (tool, extra = {}) => workerArgs(tool, { ...base, ...extra }).args;
const has = (a, ...seq) => a.some((_, i) => seq.every((v, j) => a[i + j] === v));
const CLI = path.resolve("plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs");

test("codex writes in its sandbox with the given isolation args", () => {
  const iso = ["-c", "mcp_servers.a.enabled=false"];
  const a = args("codex", { isolation: iso });
  assert.ok(has(a, "-s", "workspace-write"));
  assert.ok(has(a, "-c", "mcp_servers.a.enabled=false"));
  assert.ok(!a.includes("mcp_servers={}"));
  assert.ok(!a.includes("read-only"));
  const r = args("codex", { resume: "abc", isolation: iso });
  assert.ok(has(r, "-c", "sandbox_mode=workspace-write"));
  assert.ok(has(r, "-c", "mcp_servers.a.enabled=false"));
  assert.ok(!r.includes("read-only"));
  assert.equal(r[r.length - 2], "abc");
});

const CONFIG = [
  'model = "gpt-5"',
  '[mcp_servers.docs]', 'command = "x"',
  '[mcp_servers.docs.env]', 'K = "v"',
  '[mcp_servers."a.b"]', 'command = "y"',
  '[plugins."cua@openai-curated"]', 'enabled = true',
  '[plugins."other@mkt"]', 'enabled = true',
  '[plugins."other@mkt".settings]',
  '[projects."C://x"]',
].join("\n");

test("codexIsolationArgs disables each server and plugin once, quoting odd names", () => {
  const a = codexIsolationArgs(CONFIG);
  assert.ok(a.filter((_, i) => i % 2 === 0).every((x) => x === "-c"));
  assert.deepEqual(a.filter((_, i) => i % 2 === 1), [
    "mcp_servers.docs.enabled=false",
    'mcp_servers."a.b".enabled=false',
    'plugins."cua@openai-curated".enabled=false',
    'plugins."other@mkt".enabled=false',
    'web_search="disabled"',
  ]);
});

test("codexIsolationArgs handles a config with no MCP section, a missing file and junk", () => {
  assert.deepEqual(codexIsolationArgs('model = "x"\n[projects."/a"]\n'), ["-c", 'web_search="disabled"']);
  assert.deepEqual(codexIsolationArgs(""), ["-c", 'web_search="disabled"']);
  assert.deepEqual(codexIsolationArgs(undefined), ["-c", 'web_search="disabled"']);
  assert.deepEqual(codexIsolationArgs('[plugins."a&b"]\n[mcp_servers."x y"]'), ["-c", 'web_search="disabled"']);
});

test("config values with quotes are escaped for cmd.exe on Windows only", () => {
  assert.equal(configArg('plugins."x@y".enabled=false', "win32"), '"plugins.\\"x@y\\".enabled=false"');
  assert.equal(configArg("mcp_servers.a.enabled=false", "win32"), "mcp_servers.a.enabled=false");
  assert.equal(configArg('plugins."x@y".enabled=false', "linux"), 'plugins."x@y".enabled=false');
  const w = args("codex", { platform: "win32", isolation: codexIsolationArgs(CONFIG) });
  assert.ok(w.includes('"plugins.\\"cua@openai-curated\\".enabled=false"'));
});

test("the escaped config value reaches a Windows program unchanged", { skip: process.platform !== "win32" }, () => {
  const value = 'plugins."x@y".enabled=false';
  const r = runTool("node", ["-e", "console.log(process.argv[1])", configArg(value, "win32")]);
  assert.equal(r.out.trim(), value);
});

test("claude gets edit tools but no shell or web, and edits are not allowed by path-less rules", () => {
  const a = args("claude");
  assert.ok(has(a, "--tools", "Read,Grep,Glob,Edit,Write"));
  assert.ok(has(a, "--permission-mode", "acceptEdits"));
  const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
  assert.deepEqual(allowed, ["Read", "Grep", "Glob"]);
  assert.ok(has(a, "--disallowedTools", "Bash", "PowerShell", "NotebookEdit", "WebFetch", "WebSearch"));
  assert.ok(!a.includes("--add-dir"));
});

test("copilot may write but not run shell or fetch urls", () => {
  const a = args("copilot");
  assert.ok(has(a, "--allow-tool", "write"));
  assert.ok(has(a, "--deny-tool", "shell"));
  assert.ok(has(a, "--deny-tool", "url"));
});

test("gemini uses auto_edit", () => {
  assert.ok(has(args("gemini"), "--approval-mode", "auto_edit"));
});

test("cursor sandbox only off Windows", () => {
  const lin = args("cursor", { platform: "linux" }), win = args("cursor", { platform: "win32" });
  assert.ok(has(lin, "--sandbox", "enabled"));
  assert.ok(!win.includes("--sandbox"));
  assert.ok(lin.includes("--force") && win.includes("--force"));
});

test("paths are quoted on Windows only", () => {
  const wt = "C:\\Users\\Jane Doe\\wt\\t1";
  assert.ok(args("codex", { worktree: wt, platform: "win32" }).includes(`"${wt}"`));
  assert.ok(args("codex", { worktree: wt, platform: "linux" }).includes(wt));
  assert.ok(!args("gemini", { platform: "darwin" }).some((x) => x.includes('"')));
});

test("session flags follow review: claude, gemini, cursor", () => {
  assert.ok(has(args("claude", { sid: "s-1" }), "--session-id", "s-1"));
  assert.ok(has(args("claude", { resume: "s-1" }), "--resume", "s-1"));
  assert.ok(has(args("gemini", { sid: "s-2" }), "--session-id", "s-2"));
  assert.ok(has(args("cursor", { chat: "c-3" }), "--resume", "c-3"));
});

test("cwd is the worktree and codex and claude get the brief text on stdin", () => {
  for (const tool of ["codex", "claude"]) {
    const w = workerArgs(tool, base);
    assert.equal(w.cwd, "/w/t1");
    assert.equal(w.input, "do the thing");
  }
  assert.equal(workerArgs("copilot", base).input, undefined);
});

test("ask forbids commits and asks for NEEDS lines", () => {
  const a = WORKER_ASK("x");
  assert.ok(a.includes("Do not commit"));
  assert.ok(a.includes("NEEDS:"));
});

test("needs lines are extracted", () => {
  assert.deepEqual(parseNeeds("done\nNEEDS: npm install zod because schema\n"), ["npm install zod because schema"]);
  assert.deepEqual(parseNeeds("nothing here"), []);
});

test("work rejects bad input with exit 2", () => {
  const d = tmpDir("work");
  const ok = ["--brief", path.join(d, "b.md"), "--worktree", d, "--out", path.join(d, "o.md"), "--repo", path.join(d, "repo")];
  const run = (...a) => runCli(CLI, ["work", ...a]).code;
  assert.equal(run("--tool", "nope", "--model", "m1", ...ok), 2);
  assert.equal(run("--tool", "codex", "--model", "bad model!", ...ok), 2);
  assert.equal(run("--tool", "copilot", "--model", "m1", "--session", "new", ...ok), 2);
});

// ---- the success path, with a stub codex first on PATH ----
const STUB = String.raw`import fs from "node:fs";
fs.readFileSync(0, "utf8");
fs.writeFileSync("new.txt", "made by worker\n");
if (process.env.STUB_TOUCH) fs.appendFileSync(process.env.STUB_TOUCH, "stray\n");
const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf("-o") + 1].replace(/^"|"$/g, ""), "done\nNEEDS: npm i x because y\n");
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }));
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
  const env = { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json") };
  const run = (extra = {}, over = {}) => runCli(CLI, ["work", "--tool", "codex", "--model", "m1", "--brief", path.join(root, "b.md"),
    "--worktree", over.wt ?? wt, "--out", path.join(outDir, "r1.md"), "--repo", over.repo ?? repo], { env: { ...env, ...extra } });
  return { repo, wt, outDir, root, run };
}

test("work success path: files, needs, usage", () => {
  const { wt, outDir, run } = setup();
  const r = run();
  assert.equal(r.code, 0, r.err + r.out + (fs.existsSync(path.join(outDir, "r1.log")) ? fs.readFileSync(path.join(outDir, "r1.log"), "utf8") : ""));
  assert.equal(r.json.outsideChanged, false);
  assert.deepEqual(r.json.changedFiles, ["new.txt"]);
  assert.deepEqual(r.json.needs, ["npm i x because y"]);
  assert.ok(fs.existsSync(path.join(wt, "new.txt")));
  assert.equal(fs.readFileSync(path.join(outDir, "usage.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("work exits 5 when the worker writes into the user repo", () => {
  const { repo, run } = setup();
  const r = run({ STUB_TOUCH: path.join(repo, "stray.txt") });
  assert.equal(r.code, 5);
  assert.equal(r.json.outsideChanged, true);
});

test("work exits 5 on a further edit to an already-dirty repo file", () => {
  const { repo, run } = setup();
  fs.appendFileSync(path.join(repo, "calc.py"), "# mine\n");
  const r = run({ STUB_TOUCH: path.join(repo, "calc.py") });
  assert.equal(r.code, 5);
  assert.equal(r.json.outsideChanged, true);
});

test("work rejects a repo that is not a git repo and a worktree that is a subfolder of the repo", () => {
  const { repo, run } = setup();
  assert.equal(run({}, { repo: tmpDir("plain") }).code, 2);
  fs.mkdirSync(path.join(repo, "src"));
  assert.equal(run({}, { wt: path.join(repo, "src") }).code, 2);
});
