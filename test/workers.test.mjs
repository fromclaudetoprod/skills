import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workerArgs, WORKER_ASK, WORKER_PATCH_ASK, parseNeeds, codexIsolationArgs, codexIsolation, configArg, defaultMode, extractPatch, validatePatch, symlinkAmong } from "../plugins/multi-model-review/skills/multi-model-orchestrate/workers.mjs";
import { runTool } from "../plugins/multi-model-review/skills/multi-model-review/core.mjs";
import { spawnSync } from "node:child_process";
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
    assert.ok(w.input.endsWith("--- TASK BRIEF ---\ndo the thing"));
  }
  assert.equal(workerArgs("copilot", base).input, undefined);
});

test("codex and claude get the ask, then the brief, on stdin in both modes", () => {
  for (const tool of ["codex", "claude"]) {
    const wr = workerArgs(tool, base).input, pa = workerArgs(tool, { ...base, mode: "patch" }).input;
    assert.ok(wr.startsWith(WORKER_ASK(null)) && wr.includes("Do not commit") && wr.includes("NEEDS:"));
    assert.ok(pa.startsWith(WORKER_PATCH_ASK(null)) && pa.includes("```diff") && pa.includes("cannot edit files"));
    for (const t of [wr, pa]) assert.ok(t.includes("\n\n--- TASK BRIEF ---\ndo the thing") && !t.includes(briefFile));
  }
  assert.ok(WORKER_ASK("/b.md").includes("/b.md"));
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
  const run = (extra = {}, over = {}) => runCli(CLI, ["work", "--tool", "codex", "--model", "m1", "--mode", "write", "--brief", path.join(root, "b.md"),
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

// ---- patch mode ----
test("defaultMode: patch for codex and cursor on Windows only", () => {
  assert.equal(defaultMode("codex", "win32"), "patch");
  assert.equal(defaultMode("cursor", "win32"), "patch");
  assert.equal(defaultMode("gemini", "win32"), "write");
  assert.equal(defaultMode("claude", "win32"), "write");
  assert.equal(defaultMode("codex", "linux"), "write");
  assert.equal(defaultMode("cursor", "darwin"), "write");
});

test("patch-mode args are read-only: no --force, workspace-write or auto_edit", () => {
  for (const platform of ["linux", "win32"]) {
    for (const tool of ["codex", "cursor", "gemini"]) {
      for (const resume of [undefined, "abc"]) {
        const flat = args(tool, { mode: "patch", platform, resume, chat: resume, isolation: ["-c", "x=1"] }).join(" ");
        assert.ok(!/--force|workspace-write|auto_edit/.test(flat), `${tool} ${platform}: ${flat}`);
      }
    }
  }
  assert.ok(has(args("codex", { mode: "patch" }), "-s", "read-only"));
  assert.ok(has(args("codex", { mode: "patch", resume: "abc" }), "-c", "sandbox_mode=read-only"));
  assert.ok(has(args("cursor", { mode: "patch" }), "--mode", "ask"));
  assert.ok(has(args("cursor", { mode: "patch", platform: "linux" }), "--sandbox", "enabled"));
  assert.ok(!args("cursor", { mode: "patch", platform: "win32" }).includes("--sandbox"));
  assert.ok(has(args("gemini", { mode: "patch" }), "--approval-mode", "plan"));
  assert.ok(has(args("codex", { mode: "patch", isolation: ["-c", "mcp_servers.a.enabled=false"] }), "-c", "mcp_servers.a.enabled=false"));
});

test("patch ask names the brief and asks for one diff block and NEEDS lines", () => {
  const a = WORKER_PATCH_ASK("/b/brief.md");
  assert.ok(a.includes("/b/brief.md") && a.includes("```diff") && a.includes("NEEDS:") && a.includes("/dev/null"));
});

const D = (p, body = "+hi\n") => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n${body}`;

test("extractPatch returns the last diff block", () => {
  assert.equal(extractPatch("no diff here"), null);
  const t = "first\n```diff\n" + D("a.txt") + "```\nmore\n```diff\r\n" + D("b.txt") + "```\nNEEDS: x because y\n";
  assert.equal(extractPatch(t), D("b.txt"));
  assert.equal(extractPatch("```diff\n```"), null);
});

test("extractPatch keeps fence-like lines inside the diff and applies the whole patch", () => {
  const body = "diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n@@ -1,3 +1,3 @@\n ```sh\n-````\n+````\n ```\n";
  assert.equal(extractPatch("x\n```diff\n" + body + "```\nNEEDS: a because b\n"), body);
  assert.equal(extractPatch("```diff\r\n" + body.replace(/\n/g, "\r\n") + "```"), body);
});

test("validatePatch accepts a plain patch and lists its files", () => {
  assert.deepEqual(validatePatch(D("src/a.txt")), { ok: true, reason: null, files: ["src/a.txt"] });
  assert.deepEqual(validatePatch("diff --git a/x.py b/y.py\nsimilarity index 90%\nrename from x.py\nrename to y.py\n").files.sort(), ["x.py", "y.py"]);
});

test("validatePatch rejects absolute paths, .., .git, symlinks and patches with no headers", () => {
  const bad = (p) => validatePatch(p).ok === false;
  assert.ok(bad(D("../escape.txt")));
  assert.ok(bad(D("a/../../escape.txt")));
  assert.ok(bad(D("/etc/passwd")));
  assert.ok(bad(D("C:/x.txt")));
  assert.ok(bad(D("\\\\server\\share\\x.txt")));
  assert.ok(bad(D(".git/config")));
  assert.ok(bad(D("sub/.git/hooks/pre-commit")));
  assert.ok(bad(D(".GIT/config")));
  assert.ok(bad("diff --git a/x b/x\nrename from x\nrename to ../x\n"));
  assert.ok(bad("diff --git a/x b/x\ncopy from ../x\ncopy to x\n"));
  assert.ok(bad("diff --git a/ln b/ln\nnew file mode 120000\n--- /dev/null\n+++ b/ln\n@@ -0,0 +1 @@\n+/etc\n"));
  assert.ok(bad("diff --git a/ln b/ln\nindex 1234567..89abcde 120000\n--- a/ln\n+++ b/ln\n@@ -1 +1 @@\n-a\n+b\n"));
  assert.ok(bad("diff --git a/ln b/ln\nnew file mode 0120000\n--- /dev/null\n+++ b/ln\n@@ -0,0 +1 @@\n+/etc\n"));
  assert.ok(bad("diff --git a/ln b/ln\nindex 1234567..89abcde 0120000\n--- a/ln\n+++ b/ln\n@@ -1 +1 @@\n-a\n+b\n"));
  assert.ok(bad("diff --git a/sm b/sm\nnew file mode 160000\n--- /dev/null\n+++ b/sm\n@@ -0,0 +1 @@\n+Subproject commit 1\n"));
  assert.ok(bad("diff --git a/x b/x\nold mode 100644\nnew mode 0o10\n"));
  assert.ok(!bad("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n"));
  assert.ok(!bad("diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"));
  assert.ok(!bad("diff --git a/x b/x\nindex 1234567..89abcde\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"));
  assert.ok(bad("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"));
  assert.ok(bad(""));
  assert.ok(/no `diff --git`/.test(validatePatch("hello").reason));
});

test("codexIsolation reports the names it skipped", () => {
  const cfg = '[plugins."a&b"]\n[mcp_servers."x y"]\n[mcp_servers.ok]\n';
  const r = codexIsolation(cfg);
  assert.deepEqual(r.skipped, ["plugins.a&b", "mcp_servers.x y"]);
  assert.deepEqual(r.args, codexIsolationArgs(cfg));
  assert.ok(r.args.includes("mcp_servers.ok.enabled=false"));
});

// A stub that answers with the reply in STUB_REPLY_FILE and records its argv in STUB_ARGV. It never touches files.
const PATCH_STUB = String.raw`import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "--version") process.exit(0);
if (process.env.STUB_ARGV) fs.appendFileSync(process.env.STUB_ARGV, a.join(" ") + "\n");
const reply = fs.readFileSync(process.env.STUB_REPLY_FILE, "utf8");
if (process.argv[1].includes("cursor")) {
  console.log(JSON.stringify({ type: "result", result: reply, usage: { inputTokens: 5, outputTokens: 2 } }));
} else {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch {}
  const sawAsk = input.includes("cannot edit files") && input.includes("--- TASK BRIEF ---");
  fs.writeFileSync(a[a.indexOf("-o") + 1].replace(/^"|"$/g, ""), sawAsk ? reply : "I tried to edit files but I am read-only.\n");
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }));
}
`;

function setupPatch() {
  const bin = tmpDir("pbin");
  for (const name of ["codex", "cursor-agent"]) {
    fs.writeFileSync(path.join(bin, `${name}-stub.mjs`), PATCH_STUB);
    if (process.platform === "win32") fs.writeFileSync(path.join(bin, `${name}.cmd`), `@node "%~dp0${name}-stub.mjs" %*\r\n`);
    else { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec node "$(dirname "$0")/${name}-stub.mjs" "$@"\n`); fs.chmodSync(path.join(bin, name), 0o755); }
  }
  const root = tmpDir("prun");
  const repo = makeRepo(path.join(root, "repo"));
  const wt = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "task", wt);
  const outDir = path.join(root, "out");
  fs.writeFileSync(path.join(root, "b.md"), "brief");
  const replyFile = path.join(root, "reply.txt");
  const argvFile = path.join(root, "argv.txt");
  const env = { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json"), STUB_REPLY_FILE: replyFile, STUB_ARGV: argvFile };
  const run = (reply, { tool = "codex", extra = [] } = {}) => {
    fs.writeFileSync(replyFile, reply);
    return runCli(CLI, ["work", ...extra, "--tool", tool, "--model", "m1", "--mode", "patch", "--brief", path.join(root, "b.md"),
      "--worktree", wt, "--out", path.join(outDir, "r1.md"), "--repo", repo], { env });
  };
  return { root, repo, wt, outDir, argvFile, run };
}
const fence = (p) => "Here is the change.\n```diff\n" + p + "```\nNEEDS: npm i x because y\n";

for (const tool of ["codex", "cursor"]) {
  test(`patch mode (${tool}): a valid new-file diff is applied in the worktree`, () => {
    const { wt, outDir, run } = setupPatch();
    const r = run(fence(D("hello.txt")), { tool });
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(r.json.mode, "patch");
    assert.equal(r.json.patchApplied, true);
    assert.equal(r.json.patchError, null);
    assert.deepEqual(r.json.isolationSkipped, []);
    assert.deepEqual(r.json.needs, ["npm i x because y"]);
    assert.equal(fs.readFileSync(path.join(wt, "hello.txt"), "utf8").replace(/\r\n/g, "\n"), "hi\n");
    assert.deepEqual(r.json.changedFiles, ["hello.txt"]);
    assert.ok(fs.existsSync(path.join(outDir, "r1.patch")));
  });
}

test("patch mode: a diff touching ../escape.txt is rejected with exit 9 and writes nothing outside", () => {
  const { root, wt, run } = setupPatch();
  const r = run(fence(D("../escape.txt")));
  assert.equal(r.code, 9);
  assert.equal(r.json.patchApplied, false);
  assert.match(r.json.patchError, /leaves the folder/);
  assert.ok(!fs.existsSync(path.join(root, "escape.txt")));
  assert.ok(!fs.existsSync(path.join(path.dirname(wt), "escape.txt")));
});

test("patch mode: an absolute path is rejected with exit 9", () => {
  const { root, run } = setupPatch();
  const target = path.join(root, "abs.txt").replace(/\\/g, "/");
  const r = run(fence(D(target)));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /absolute path|cannot read file names/);
  assert.ok(!fs.existsSync(path.join(root, "abs.txt")));
});

test("patch mode: a reply with no diff block exits 9", () => {
  const { run } = setupPatch();
  const r = run("I changed the file, trust me.\n");
  assert.equal(r.code, 9);
  assert.equal(r.json.patchApplied, false);
  assert.match(r.json.patchError, /no ```diff block/);
});

test("patch mode: a diff that does not apply exits 9 with git's error", () => {
  const { wt, run } = setupPatch();
  const p = "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def sub(a, b):\n-    return a - b\n+    return a - b - 1\n";
  const r = run(fence(p));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /git apply --check failed: .*\S/);
  assert.equal(fs.readFileSync(path.join(wt, "calc.py"), "utf8").replace(/\r\n/g, "\n"), "def add(a, b):\n    return a + b\n");
});

test("patch mode: a patch modifying .git/config is rejected", () => {
  const { run } = setupPatch();
  const p = "diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n";
  const r = run(fence(p));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /\.git/);
  assert.deepEqual(r.json.changedFiles, []);
});

test("patch mode: a change to an existing file applies", () => {
  const { wt, run } = setupPatch();
  const p = "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,3 @@\n def add(a, b):\n     return a + b\n+# done\n";
  const r = run(fence(p));
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(fs.readFileSync(path.join(wt, "calc.py"), "utf8").replace(/\r\n/g, "\n"), "def add(a, b):\n    return a + b\n# done\n");
});

test("patch mode: cursor is never given --force", () => {
  const { argvFile, run } = setupPatch();
  const r = run(fence(D("c.txt")), { tool: "cursor" });
  assert.equal(r.code, 0, r.err + r.out);
  const recorded = fs.readFileSync(argvFile, "utf8");
  assert.ok(recorded.includes("--mode ask"));
  assert.ok(!recorded.includes("--force"));
});

test("--mode patch is refused for claude and copilot, and a bad mode is refused (exit 2)", () => {
  const { run } = setupPatch();
  assert.equal(run("x", { tool: "claude" }).code, 2);
  assert.equal(run("x", { tool: "copilot" }).code, 2);
  assert.equal(run("x", { extra: ["--mode", "bogus"] }).code, 2);
});

test("patch mode: fence-like lines inside the diff apply completely", () => {
  const { wt, run } = setupPatch();
  const doc = "```sh\nold\n```\n";
  fs.writeFileSync(path.join(wt, "doc.md"), doc);
  git(wt, "add", "doc.md"); git(wt, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "doc");
  const p = "diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n@@ -1,3 +1,4 @@\n ```sh\n-old\n+new\n+````\n ```\n";
  const r = run(fence(p));
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(fs.readFileSync(path.join(wt, "doc.md"), "utf8").replace(/\r\n/g, "\n"), "```sh\nnew\n````\n```\n");
});

test("patch mode: exit 5 beats 9, and the patch is not attempted", () => {
  const { repo, root, run } = setupPatch();
  // the stub cannot touch the repo, so fake the stray write by making the reply path inside the repo impossible:
  // instead run with a repo change made by a wrapper stub
  const stray = path.join(repo, "stray.txt");
  const bin = tmpDir("sbin");
  const stub = `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(stray)}, "x"); fs.writeFileSync(process.argv[process.argv.indexOf("-o") + 1].replace(/^"|"$/g, ""), "no diff"); try { fs.readFileSync(0); } catch {}`;
  fs.writeFileSync(path.join(bin, "s.mjs"), stub);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0s.mjs" %*\r\n');
  else { fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nexec node "$(dirname "$0")/s.mjs" "$@"\n'); fs.chmodSync(path.join(bin, "codex"), 0o755); }
  const r = runCli(CLI, ["work", "--tool", "codex", "--model", "m1", "--mode", "patch", "--brief", path.join(root, "b.md"),
    "--worktree", path.join(root, "wt"), "--out", path.join(root, "out", "r2.md"), "--repo", repo],
  { env: { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json") } });
  assert.equal(r.code, 5);
  assert.equal(r.json.patchApplied, false);
  assert.match(r.json.patchError, /^not attempted/);
  assert.ok(run);
});

test("patch mode: a failed worker run skips the patch (not attempted)", () => {
  const { root, repo, wt } = setupPatch();
  const bin = tmpDir("fbin");
  fs.writeFileSync(path.join(bin, "s.mjs"), 'console.error("boom"); process.exit(1);');
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0s.mjs" %*\r\n');
  else { fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\nexec node "$(dirname "$0")/s.mjs" "$@"\n'); fs.chmodSync(path.join(bin, "codex"), 0o755); }
  const r = runCli(CLI, ["work", "--tool", "codex", "--model", "m1", "--mode", "patch", "--brief", path.join(root, "b.md"),
    "--worktree", wt, "--out", path.join(root, "out", "r3.md"), "--repo", repo],
  { env: { PATH: bin + path.delimiter + process.env.PATH, MMR_ACCESS_FILE: path.join(root, "access.json") } });
  assert.equal(r.code, 2);
  assert.equal(r.json.patchApplied, false);
  assert.match(r.json.patchError, /^not attempted: the worker run failed/);
});

test("symlinkAmong finds a symlink among the changed paths (skips where symlinks cannot be made)", (t) => {
  const { wt } = setupPatch();
  fs.writeFileSync(path.join(wt, "real.txt"), "x");
  assert.equal(symlinkAmong(wt, ["real.txt", "missing.txt"]), null);
  try { fs.symlinkSync("real.txt", path.join(wt, "ln.txt")); } catch { t.skip("cannot create symlinks here"); return; }
  assert.equal(symlinkAmong(wt, ["real.txt", "ln.txt"]), "ln.txt");
});

test("symlinkAmong sees a 120000 entry in the index", () => {
  const { wt } = setupPatch();
  const sha = spawnSync("git", ["-C", wt, "hash-object", "-w", "--stdin"], { input: "target", encoding: "utf8" }).stdout.trim();
  git(wt, "update-index", "--add", "--cacheinfo", `120000,${sha},idx-link`);
  assert.equal(symlinkAmong(wt, ["idx-link", "calc.py"]), "idx-link");
});

test("patch mode: a symlink patch is refused with exit 9 and nothing is created", () => {
  const { wt, run } = setupPatch();
  const r = run(fence("diff --git a/ln b/ln\nnew file mode 0120000\n--- /dev/null\n+++ b/ln\n@@ -0,0 +1 @@\n+/etc\n\\ No newline at end of file\n"));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /not allowed/);
  assert.ok(!fs.existsSync(path.join(wt, "ln")));
});
