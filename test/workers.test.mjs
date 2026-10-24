import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workerArgs, WORKER_ASK, WORKER_PATCH_ASK, parseNeeds, codexIsolationArgs, codexIsolation, configArg, defaultMode, validatePatch, symlinkAmong, extractFiles, buildPatch, checkPathSafe } from "../plugins/multi-model-review/skills/multi-model-orchestrate/workers.mjs";
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
    const wr = workerArgs(tool, base).input, pa = workerArgs(tool, { ...base, mode: "patch", code: "QWE123" }).input;
    assert.ok(wr.startsWith(WORKER_ASK(null)) && wr.includes("Do not commit") && wr.includes("NEEDS:"));
    assert.ok(pa.startsWith(WORKER_PATCH_ASK(null, "QWE123")) && pa.includes("<<<FILE path=<relative/path> code=QWE123>>>") && pa.includes("cannot edit files"));
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

test("patch ask names the brief and asks for nonce-delimited whole files, DELETE lines and NEEDS lines, never a diff", () => {
  for (const a of [WORKER_PATCH_ASK("/b/brief.md", "AB12CD"), WORKER_PATCH_ASK(null, "AB12CD")]) {
    assert.ok(a.includes("<<<FILE path=<relative/path> code=AB12CD>>>") && a.includes("<<<END AB12CD>>>") && a.includes("<<<DELETE path=<relative/path> code=AB12CD>>>"));
    assert.ok(a.includes("NEEDS:") && a.includes("never abbreviate") && a.includes("need no escaping"));
    assert.ok(!a.includes("```file") && !a.includes("```diff") && !a.includes("/dev/null"));
  }
  assert.ok(WORKER_PATCH_ASK("/b/brief.md").includes("/b/brief.md"));
  assert.ok(WORKER_PATCH_ASK(null).includes("--- TASK BRIEF ---"));
});
test("every patch ask gets its own random 6-character code", () => {
  const codes = new Set();
  for (let i = 0; i < 20; i++) {
    const m = workerArgs("codex", { ...base, mode: "patch" }).input.match(/<<<END ([A-Z0-9]{6})>>>/);
    assert.ok(m);
    codes.add(m[1]);
  }
  assert.ok(codes.size > 15);
});

const D = (p, body = "+hi\n") => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n${body}`;

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

// A stub that answers with the reply in STUB_REPLY_FILE ({{CODE}} is replaced by the code it reads from the ask on
// stdin or argv, as a real worker would echo it back) and records its argv in STUB_ARGV. It never touches files.
const PATCH_STUB = String.raw`import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "--version") process.exit(0);
if (process.env.STUB_ARGV) fs.appendFileSync(process.env.STUB_ARGV, a.join(" ") + "\n");
const reply = fs.readFileSync(process.env.STUB_REPLY_FILE, "utf8");
if (process.argv[1].includes("cursor")) {
  const m = a.join(" ").match(/<<<END ([A-Z0-9]{6})>>>/);
  if (!m) { console.log(JSON.stringify({ type: "result", result: "I am read-only and saw no file ask." })); process.exit(0); }
  console.log(JSON.stringify({ type: "result", result: reply.replaceAll("{{CODE}}", m[1]), usage: { inputTokens: 5, outputTokens: 2 } }));
} else {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch {}
  const m = input.match(/<<<END ([A-Z0-9]{6})>>>/);
  const sawAsk = m && input.includes("--- TASK BRIEF ---");
  fs.writeFileSync(a[a.indexOf("-o") + 1].replace(/^"|"$/g, ""), sawAsk ? reply.replaceAll("{{CODE}}", m[1]) : "I tried to edit files but I am read-only.\n");
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
const FB = (p, content, code = "{{CODE}}") => `<<<FILE path=${p} code=${code}>>>\n${content}<<<END ${code}>>>\n`;
const DEL = (p, code = "{{CODE}}") => `<<<DELETE path=${p} code=${code}>>>\n`;
const doneLine = (text, code = "{{CODE}}") => `<<<DONE code=${code} files=${(text.match(/^<<<FILE /gm) ?? []).length} deletes=${(text.match(/^<<<DELETE /gm) ?? []).length}>>>\n`;
const wfReply = (...blocks) => { const b = blocks.join("\n"); return "Here is the change.\n" + b + doneLine(b) + "NEEDS: npm i x because y\n"; };

for (const tool of ["codex", "cursor"]) {
  test(`patch mode (${tool}): a valid new file is applied in the worktree`, () => {
    const { wt, outDir, run } = setupPatch();
    const r = run(wfReply(FB("hello.txt", "hi\n")), { tool });
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

test("patch mode: a reply naming ../escape.txt is rejected with exit 9 and writes nothing outside", () => {
  const { root, wt, run } = setupPatch();
  const r = run(wfReply(FB("../escape.txt", "x\n")));
  assert.equal(r.code, 9);
  assert.equal(r.json.patchApplied, false);
  assert.match(r.json.patchError, /leaves the folder/);
  assert.ok(!fs.existsSync(path.join(root, "escape.txt")));
  assert.ok(!fs.existsSync(path.join(path.dirname(wt), "escape.txt")));
});

test("patch mode: an absolute path is rejected with exit 9", () => {
  const { root, run } = setupPatch();
  const target = path.join(root, "abs.txt").replace(/\\/g, "/");
  const r = run(wfReply(FB(target, "x\n")));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /absolute path/);
  assert.ok(!fs.existsSync(path.join(root, "abs.txt")));
});

test("patch mode: a reply with no block exits 9", () => {
  const { run } = setupPatch();
  const r = run("I changed the file, trust me.\n");
  assert.equal(r.code, 9);
  assert.equal(r.json.patchApplied, false);
  assert.match(r.json.patchError, /no <<<FILE or <<<DELETE block/);
});

test("patch mode: a patch to .git/config is rejected", () => {
  const { run } = setupPatch();
  const r = run(wfReply(FB(".git/config", "b\n")));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /\.git/);
  assert.deepEqual(r.json.changedFiles, []);
});

test("patch mode: a change to an existing file applies", () => {
  const { wt, run } = setupPatch();
  const r = run(wfReply(FB("calc.py", "def add(a, b):\n    return a + b\n# done\n")));
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(fs.readFileSync(path.join(wt, "calc.py"), "utf8").replace(/\r\n/g, "\n"), "def add(a, b):\n    return a + b\n# done\n");
});

test("patch mode: cursor is never given --force", () => {
  const { argvFile, run } = setupPatch();
  const r = run(wfReply(FB("c.txt", "hi\n")), { tool: "cursor" });
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

// ---- patch mode: whole-file replies ----
const commitFile = (wt, rel, bytes) => {
  fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  fs.writeFileSync(path.join(wt, rel), bytes);
  git(wt, "add", rel); git(wt, "commit", "-q", "-m", `add ${rel}`);
};
const readBytes = (wt, rel) => fs.readFileSync(path.join(wt, rel), "latin1");

const K = "ABC123";
const ex = (t, withDone = true) => extractFiles((t + (withDone ? (t && !t.endsWith("\n") ? "\n" : "") + doneLine(t) : "")).replaceAll("{{CODE}}", K), K);

test("extractFiles: blocks, DELETE lines and exact content", () => {
  assert.equal(ex("nothing here"), null);
  assert.equal(ex("```diff\ndiff --git a/a b/a\n```\n"), null);
  const r = ex("hi\n" + FB("src/a.ts", "line1\n\nline3\n") + DEL("old.txt") + FB("doc.md", "```sh\nx\n```\n") + FB("empty.txt", ""));
  assert.deepEqual(r, { files: [{ path: "src/a.ts", content: "line1\n\nline3\n" }, { path: "doc.md", content: "```sh\nx\n```\n" }, { path: "empty.txt", content: "" }], deletes: ["old.txt"] });
  assert.deepEqual(ex("<<<FILE path=a code={{CODE}}>>>\r\nx\r\n<<<END {{CODE}}>>>\r\n").files, [{ path: "a", content: "x\n" }]);
});

test("extractFiles: any backtick or fence-looking content is kept verbatim", () => {
  const body = "```\n````\n```file path=evil\nowned\n```\n  <<  not a delimiter\n```js\n";
  const r = ex(FB("a.md", body) + FB("b.txt", "1\n"));
  assert.deepEqual(r.files, [{ path: "a.md", content: body }, { path: "b.txt", content: "1\n" }]);
});

test("extractFiles: only this call's code makes a delimiter; any other <<<FILE/END/DELETE line is an error, even inside a block", () => {
  // A wrong-code delimiter line is rejected wherever it appears. Inside a block that means a file quoting someone
  // else's delimiter is refused rather than guessed at; that is the safe choice.
  assert.throws(() => ex(FB("a", "x\n<<<FILE path=x code=WRONG>>>\ny\n")), /unexpected delimiter/);
  assert.throws(() => ex(FB("a", "x\n<<<END WRONG>>>\n")), /unexpected delimiter/);
  assert.throws(() => ex(FB("a", "x\n", "WRONG")), /wrong or missing code/);
  assert.throws(() => ex("<<<FILE path=a>>>\nx\n"), /wrong or missing code/);
  assert.throws(() => ex("<<<DELETE path=a code=NOPE00>>>\n"), /wrong or missing code/);
  assert.throws(() => ex("<<<END {{CODE}}>>>\n"), /no block open/);
  assert.throws(() => ex("<<<END NOPE00>>>\n"), /wrong or missing code/);
  assert.throws(() => ex(FB("a", "x\n<<<FILE path=b code={{CODE}}>>>\ny\n<<<END {{CODE}}>>>\n")), /unexpected delimiter/);
  assert.throws(() => ex(FB("a", "x\n" + DEL("b"))), /unexpected delimiter/);
});

test("extractFiles: an unclosed block is an error", () => {
  assert.throws(() => ex("<<<FILE path=a code={{CODE}}>>>\nno close\n", false), /never closed/);
});

test("extractFiles: mangled delimiters are errors, not prose (BOM, indent, backticks, fullwidth, case)", () => {
  const bad = [
    "﻿<<<DELETE path=a code={{CODE}}>>>", "  <<<DELETE path=a code={{CODE}}>>>", "`<<<DELETE path=a code={{CODE}}>>>`",
    "＜＜＜DELETE path=a code={{CODE}}＞＞＞", "<<<delete path=a code={{CODE}}>>>", "<<<DELETE path=a code={{CODE}}>>> ",
    "<<< DONE code={{CODE}} files=0 deletes=0>>>", "see code {{CODE}} here",
  ];
  for (const b of bad) {
    assert.throws(() => ex(FB("ok.txt", "1\n") + b + "\n"), /looks like a block delimiter|delimiter-like/, JSON.stringify(b));
    assert.throws(() => ex(FB("ok.txt", "x\n" + b + "\n")), /delimiter-like/, JSON.stringify(b));
  }
  // a BOM at the very start of the reply is dropped, not an error
  assert.deepEqual(extractFiles(("﻿" + FB("a", "1\n") + doneLine(FB("a", "1\n"))).replaceAll("{{CODE}}", K), K).files, [{ path: "a", content: "1\n" }]);
});

test("extractFiles: a wrong-case END is an error, not content", () => {
  assert.throws(() => ex("<<<FILE path=a code={{CODE}}>>>\nx\n<<<end {{CODE}}>>>\n<<<END {{CODE}}>>>\n", false), /delimiter-like/);
});

test("extractFiles: the DONE line is required, last, unique and must match the counts", () => {
  const blocks = FB("a", "1\n") + DEL("b");
  const all = (t) => t.replaceAll("{{CODE}}", K);
  assert.throws(() => extractFiles(all(blocks), K), /no final <<<DONE/);
  assert.throws(() => extractFiles(all(FB("a", "1\n") + "<<<DONE code={{CODE}} files=1 deletes=1>>>\n"), K), /says 1 files and 1 deletes/);
  assert.throws(() => extractFiles(all(blocks + "<<<DONE code={{CODE}} files=1 deletes=0>>>\n"), K), /says 1 files and 0 deletes but the reply has 1 files and 1 deletes/);
  assert.throws(() => extractFiles(all(blocks + doneLine(blocks) + doneLine(blocks)), K), /more than one/);
  assert.throws(() => extractFiles(all(FB("a", "1\n") + doneLine(FB("a", "1\n")) + DEL("b")), K), /after the <<<DONE/);
  assert.throws(() => extractFiles(all(FB("a", "1\n") + "<<<DONE code=WRONG1 files=1 deletes=0>>>\n"), K), /looks like a block delimiter/);
  assert.equal(extractFiles(all("just prose\n" + doneLine("")), K), null);
  assert.equal(extractFiles("just prose", K), null);
  // DONE inside a block is an error
  assert.throws(() => ex(FB("a", "x\n<<<DONE code={{CODE}} files=1 deletes=0>>>\n"), false), /delimiter-like/);
});

test("error texts never contain the code", () => {
  const msgs = [];
  for (const t of ["<<<FILE path=a code={{CODE}}>>>\nx\n<<<FILE path=b code={{CODE}}>>>\n", "<<<END {{CODE}}>>>\n", "<<<FILE path=a code={{CODE}}>>>\nx\n", "oops {{CODE}}\n",
    "<<<FILE path=a code=WRONG1>>>\n", FB("a", "1\n"), FB("a", "1\n") + "<<<DONE code={{CODE}} files=3 deletes=0>>>\n"]) {
    try { extractFiles(t.replaceAll("{{CODE}}", K), K); } catch (e) { msgs.push(e.message); }
  }
  assert.equal(msgs.length, 7);
  for (const m of msgs) assert.ok(!m.includes(K), m);
});

test("extractFiles: a duplicate path is an error", () => {
  assert.throws(() => ex(FB("a", "1\n") + FB("a", "2\n")), /twice: a/);
  assert.throws(() => ex(FB("a", "1\n") + DEL("a")), /twice: a/);
});

test("buildPatch: existing CRLF file keeps CRLF, LF file stays LF, no-newline-at-end handled both ways", () => {
  const wt = tmpDir("bp");
  git(wt, "init", "-q");
  fs.writeFileSync(path.join(wt, "crlf.txt"), "a\r\nb\r\n");
  fs.writeFileSync(path.join(wt, "lf.txt"), "a\nb\n");
  fs.writeFileSync(path.join(wt, "nonl.txt"), "a\nb");
  const p = buildPatch(wt, [{ path: "crlf.txt", content: "a\nB\n" }, { path: "lf.txt", content: "a\r\nB\n" }, { path: "nonl.txt", content: "a\nb\n" }]);
  assert.ok(p.includes("@@ -1,2 +1,2 @@\n-a\r\n-b\r\n+a\r\n+B\r\n"));
  assert.ok(p.includes("@@ -1,2 +1,2 @@\n-a\n-b\n+a\n+B\n"));
  // an existing file keeps its final-newline state: adding or dropping the last newline alone is no change
  assert.ok(!p.includes("nonl.txt"));
  fs.writeFileSync(path.join(wt, "nl.txt"), "a\nb\n");
  assert.equal(buildPatch(wt, [{ path: "nl.txt", content: "a\nb" }]), "");
  const q = buildPatch(wt, [{ path: "nonl.txt", content: "a\nc\n" }]);
  assert.ok(q.endsWith("-a\n-b\n\\ No newline at end of file\n+a\n+c\n\\ No newline at end of file\n"), q);
});

test("buildPatch: unchanged files are skipped, new and deleted files get the right headers", () => {
  const wt = tmpDir("bp2");
  git(wt, "init", "-q");
  fs.writeFileSync(path.join(wt, "same.txt"), "a\r\nb\r\n");
  fs.writeFileSync(path.join(wt, "gone.txt"), "x\ny\n");
  fs.writeFileSync(path.join(wt, "empty.txt"), "");
  assert.equal(buildPatch(wt, [{ path: "same.txt", content: "a\nb\n" }]), "");
  assert.equal(buildPatch(wt, [{ path: "new/n.txt", content: "hi\nthere" }]),
    "diff --git a/new/n.txt b/new/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new/n.txt\n@@ -0,0 +1,2 @@\n+hi\n+there\n\\ No newline at end of file\n");
  assert.equal(buildPatch(wt, [], ["gone.txt"]), "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n");
  assert.equal(buildPatch(wt, [{ path: "empty.txt", content: "z\n" }]), "diff --git a/empty.txt b/empty.txt\n--- a/empty.txt\n+++ b/empty.txt\n@@ -0,0 +1,1 @@\n+z\n");
  assert.throws(() => buildPatch(wt, [], ["missing.txt"]), /does not exist/);
});

test("buildPatch: bad paths and big files are refused before anything is read", () => {
  const wt = tmpDir("bp3");
  git(wt, "init", "-q");
  const bad = (p, re) => assert.throws(() => buildPatch(wt, [{ path: p, content: "x\n" }]), re);
  bad("../x", /leaves the folder/);
  bad("/etc/x", /absolute path/);
  bad("C:/x", /absolute path/);
  bad(".git/config", /\.git/);
  bad("a/.GIT/hooks/x", /\.git/);
  bad("a\\b", /backslash/);
  bad("", /bad file path/);
  bad("a//b", /bad file path/);
  bad("dir/", /bad file path/);
  bad("x\ny", /bad file path/);
  assert.throws(() => buildPatch(wt, [{ path: "big.txt", content: "x".repeat(1024 * 1024 + 1) }]), /larger than 1 MB/);
  fs.writeFileSync(path.join(wt, "huge.txt"), "y".repeat(1024 * 1024 + 1));
  assert.throws(() => buildPatch(wt, [{ path: "huge.txt", content: "z\n" }]), /larger than 1 MB/);
  fs.writeFileSync(path.join(wt, "bin.dat"), Buffer.from([0x61, 0, 0x62]));
  assert.throws(() => buildPatch(wt, [{ path: "bin.dat", content: "z\n" }]), /not a UTF-8/);
});

test("checkPathSafe: plain and missing paths pass; symlinked parents and targets are refused", (t) => {
  const root = tmpDir("cps");
  const wt = path.join(root, "wt"), outside = path.join(root, "outside");
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(wt, "src", "a.txt"), "x");
  assert.equal(checkPathSafe(wt, "src/a.txt"), null);
  assert.equal(checkPathSafe(wt, "new/deeper/b.txt"), null);
  assert.match(checkPathSafe(wt, "src/a.txt/b.txt"), /not a folder/);
  assert.match(checkPathSafe(wt, "src"), /is a folder/);
  try { fs.symlinkSync(outside, path.join(wt, "link"), "junction"); } catch { t.skip("cannot create links here"); return; }
  assert.match(checkPathSafe(wt, "link/x.txt"), /link is a symlink/);
  assert.match(checkPathSafe(wt, "link"), /link is a symlink/);
  assert.throws(() => buildPatch(wt, [{ path: "link/x.txt", content: "x\n" }]), /symlink/);
  assert.throws(() => buildPatch(wt, [], ["link/x.txt"]), /symlink/);
});

test("checkPathSafe: a symlinked file target is refused", (t) => {
  const wt = tmpDir("cps2");
  fs.writeFileSync(path.join(wt, "real.txt"), "x");
  try { fs.symlinkSync(path.join(wt, "real.txt"), path.join(wt, "ln.txt"), "file"); } catch { t.skip("cannot create file symlinks here"); return; }
  assert.match(checkPathSafe(wt, "ln.txt"), /ln.txt is a symlink/);
  assert.throws(() => buildPatch(wt, [{ path: "ln.txt", content: "y\n" }]), /symlink/);
});

test("whole-file patch mode: a CRLF file (autocrlf=true) is edited and keeps CRLF", () => {
  const { repo, wt, outDir, run } = setupPatch();
  git(repo, "config", "core.autocrlf", "true");
  commitFile(wt, "win.txt", "one\r\ntwo\r\nthree\r\n");
  const r = run(wfReply(FB("win.txt", "one\nTWO\nthree\nfour\n")));
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.patchApplied, true);
  assert.equal(readBytes(wt, "win.txt"), "one\r\nTWO\r\nthree\r\nfour\r\n");
  assert.deepEqual(r.json.needs, ["npm i x because y"]);
  assert.ok(fs.readFileSync(path.join(outDir, "r1.patch"), "utf8").startsWith("diff --git a/win.txt b/win.txt\n"));
  assert.match(fs.readFileSync(path.join(outDir, "r1.md"), "utf8"), /<<<FILE path=win.txt code=[A-Z0-9]{6}>>>/);
});

for (const tool of ["codex", "cursor"]) {
  test(`whole-file patch mode (${tool}): LF file stays LF, new and nested files are created, DELETE works`, () => {
    const { repo, wt, run } = setupPatch();
    git(repo, "config", "core.autocrlf", "true"); // git must not turn an LF file into CRLF
    commitFile(wt, "lf.txt", "a\nb\n");
    commitFile(wt, "gone.txt", "bye\n");
    const r = run(wfReply(FB("lf.txt", "a\nB\n"), FB("deep/er/new.txt", "fresh\n"), DEL("gone.txt")), { tool });
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(readBytes(wt, "lf.txt"), "a\nB\n");
    assert.equal(readBytes(wt, "deep/er/new.txt").replace(/\r\n/g, "\n"), "fresh\n");
    assert.ok(!fs.existsSync(path.join(wt, "gone.txt")));
    for (const c of ["lf.txt", "gone.txt"]) assert.ok(r.json.changedFiles.includes(c), c);
  });
}

test("whole-file patch mode: a file that contains ``` lines applies exactly, even with fence-like and delimiter-like text", () => {
  const { wt, run } = setupPatch();
  const doc = "# Title\n\n```sh\nnpm test\n```\n\n````\nnested\n````\n```file path=evil.txt\nowned\n```\nindented << END text\n";
  commitFile(wt, "doc.md", "old\n");
  const r = run(wfReply(FB("doc.md", doc), FB("other.txt", "o\n")));
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(readBytes(wt, "doc.md"), doc);
  assert.ok(!fs.existsSync(path.join(wt, "evil.txt")));
  assert.equal(readBytes(wt, "other.txt").replace(/\r\n/g, "\n"), "o\n");
});

test("whole-file patch mode: a wrong-code delimiter line inside content rejects the whole reply", () => {
  const { wt, run } = setupPatch();
  const r = run(wfReply(FB("a.txt", "x\n<<<FILE path=x code=WRONG>>>\ny\n")));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /unexpected delimiter/);
  assert.ok(!fs.existsSync(path.join(wt, "a.txt")) && !fs.existsSync(path.join(wt, "x")));
  assert.deepEqual(r.json.needs, []);
});

test("whole-file patch mode: unsafe paths exit 9 and write nothing", () => {
  for (const p of ["../x.txt", "/abs/x.txt", ".git/config"]) {
    const { root, wt, run } = setupPatch();
    const r = run(wfReply(FB(p, "x\n")));
    assert.equal(r.code, 9, p);
    assert.equal(r.json.patchApplied, false);
    assert.match(r.json.patchError, /patch rejected/);
    assert.ok(!fs.existsSync(path.join(root, "x.txt")) && !fs.existsSync(path.join(path.dirname(wt), "x.txt")));
    assert.deepEqual(r.json.changedFiles, []);
  }
  const { run } = setupPatch();
  assert.equal(run(wfReply(DEL("../x.txt"))).code, 9);
});

test("whole-file patch mode: a path under a symlinked folder is refused with exit 9", (t) => {
  const { root, wt, run } = setupPatch();
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(wt, "link"), "junction"); } catch { t.skip("cannot create links here"); return; }
  const r = run(wfReply(FB("link/x.txt", "x\n")));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /symlink/);
  assert.ok(!fs.existsSync(path.join(outside, "x.txt")));
});

test("whole-file patch mode: no blocks, duplicates, unclosed and identical files exit 9", () => {
  const { wt, run } = setupPatch();
  let r = run("I changed everything, trust me.\n");
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /no <<<FILE or <<<DELETE block/);
  r = run(wfReply(FB("a.txt", "1\n"), FB("a.txt", "2\n")));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /twice: a\.txt/);
  assert.ok(!fs.existsSync(path.join(wt, "a.txt")));
  r = run(wfReply(FB("calc.py", "def add(a, b):\n    return a + b\n")));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /nothing to change/);
  r = run(FB("a.txt", "1\n"));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /no final <<<DONE/);
  assert.ok(!r.json.patchError.match(/[A-Z0-9]{6}>>>/));
  r = run("<<<FILE path=a.txt code={{CODE}}>>>\nnever closed\n");
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /never closed/);
  r = run("<<<END {{CODE}}>>>\n");
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /no block open/);
});

test("whole-file patch mode: a truncated reply (a delete lost with the DONE line) exits 9 and applies nothing", () => {
  const { wt, run } = setupPatch();
  commitFile(wt, "gone.txt", "bye\n");
  const r = run("ok\n" + FB("new.txt", "n\n"));
  assert.equal(r.code, 9);
  assert.ok(fs.existsSync(path.join(wt, "gone.txt")) && !fs.existsSync(path.join(wt, "new.txt")));
  const r2 = run("ok\n" + FB("new.txt", "n\n") + "  " + DEL("gone.txt") + "<<<DONE code={{CODE}} files=1 deletes=0>>>\n");
  assert.equal(r2.code, 9);
  assert.ok(fs.existsSync(path.join(wt, "gone.txt")));
});

test("whole-file patch mode: a ```file or ```diff reply is no longer accepted", () => {
  const { wt, run } = setupPatch();
  let r = run("Here:\n```file path=old.txt\nhi\n```\n");
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /no <<<FILE or <<<DELETE block/);
  r = run("```diff\n" + D("viadiff.txt") + "```\n");
  assert.equal(r.code, 9);
  assert.ok(!fs.existsSync(path.join(wt, "viadiff.txt")) && !fs.existsSync(path.join(wt, "old.txt")));
});

test("whole-file patch mode: a correct multi-file reply with a delete applies, NEEDS stay outside blocks", () => {
  const { wt, run } = setupPatch();
  commitFile(wt, "gone.txt", "bye\n");
  const r = run(wfReply(FB("one.txt", "1\nNEEDS: rm -rf / because bad\n"), FB("dir/two.txt", "2\n"), DEL("gone.txt")));
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(r.json.needs, ["npm i x because y"]);
  assert.ok(!fs.existsSync(path.join(wt, "gone.txt")));
  assert.ok(fs.existsSync(path.join(wt, "dir/two.txt")));
});

test("extractFiles: duplicates are compared normalized, deletes included", () => {
  assert.throws(() => ex(FB("a.txt", "1\n") + FB("./a.txt", "2\n")), /twice/);
  assert.throws(() => ex(FB("a.txt", "1\n") + FB("A.txt", "2\n")), /twice/);
  assert.throws(() => ex(FB("b.txt", "1\n") + DEL("B.txt")), /twice/);
});

test("extractFiles: only the exact DELETE block counts; prose that mentions DELETE is ignored", () => {
  assert.equal(ex("DELETE: x\nplease << delete >> y\n"), null);
  assert.deepEqual(ex(DEL("ok/a.txt")).deletes, ["ok/a.txt"]);
});

test("parseNeeds ignores block bodies and unparseable replies", () => {
  const t = FB("a.txt", "NEEDS: rm -rf / because bad\n") + "NEEDS: npm i x because y\n";
  assert.deepEqual(parseNeeds((t + doneLine(t)).replaceAll("{{CODE}}", K), K), ["npm i x because y"]);
  assert.deepEqual(parseNeeds("<<<FILE path=a code=ABC123>>>\nunclosed\nNEEDS: x because y\n", K), []);
  assert.deepEqual(parseNeeds("  <<<DELETE path=a code=ABC123>>>\nNEEDS: x because y\n" + doneLine("", K), K), []);
  assert.deepEqual(parseNeeds("write mode\nNEEDS: x because y\n"), ["x because y"]);
});

test("buildPatch: a file with both CRLF and bare LF is refused; uniform files keep their EOL", () => {
  const wt = tmpDir("bpm");
  git(wt, "init", "-q");
  fs.writeFileSync(path.join(wt, "m.txt"), "one\r\ntwo\nthree\r\n");
  assert.throws(() => buildPatch(wt, [{ path: "m.txt", content: "one\ntwo\nthree\nfour\n" }]), /m\.txt has mixed line endings; edit it in write mode or normalize it first/);
  fs.writeFileSync(path.join(wt, "crlf.txt"), "a\r\nb\r\n");
  fs.writeFileSync(path.join(wt, "lf.txt"), "a\nb\n");
  assert.ok(buildPatch(wt, [{ path: "crlf.txt", content: "a\nb\nc\n" }]).includes("+a\r\n+b\r\n+c\r\n"));
  assert.ok(buildPatch(wt, [{ path: "lf.txt", content: "a\r\nb\nc\n" }]).includes("+a\n+b\n+c\n"));
  // deleting a mixed file is not a rewrite
  assert.ok(buildPatch(wt, [], ["m.txt"]).includes("deleted file"));
});

test("whole-file patch mode: a mixed-EOL file exits 9 with the path in the error and is left alone", () => {
  const { wt, run } = setupPatch();
  commitFile(wt, "mixed.txt", "a\r\nb\nc\r\n");
  const r = run(wfReply(FB("mixed.txt", "a\nB\nc\n")));
  assert.equal(r.code, 9);
  assert.match(r.json.patchError, /mixed\.txt has mixed line endings; edit it in write mode or normalize it first/);
  assert.equal(readBytes(wt, "mixed.txt"), "a\r\nb\nc\r\n");
});

test("paths: 8.3 short names, trailing dots and spaces are refused everywhere", () => {
  const wt = tmpDir("bp8");
  git(wt, "init", "-q");
  for (const p of ["GIT~1/config", "a/PROGRA~1/x", "x~12", "x~1.txt", "a./b", "dir/name ", "dir./f", "a/b. /c",
    "con", "src/NUL.txt", "aux.js", "Com1", "lpt9.x", "a/b:stream", "f.txt:ads"]) {
    assert.throws(() => buildPatch(wt, [{ path: p, content: "x\n" }]), /short name|dot or space|bad file path|reserved device|":"/, p);
    assert.throws(() => buildPatch(wt, [], [p]), /short name|dot or space|bad file path|reserved device|":"/, p);
  }
  for (const p of ["console.txt", "a~b.txt", "x~1a", "com10", "auxiliary/x"]) assert.doesNotThrow(() => buildPatch(wt, [{ path: p, content: "x\n" }]), p);
  assert.doesNotThrow(() => buildPatch(wt, [{ path: "a~b/..cache/x.txt", content: "x\n" }]));
});

test("--context refuses short-name and trailing-dot paths (exit 2)", () => {
  const { run } = setupPatch();
  for (const c of ["GIT~1/config", "calc.py.", "calc.py "]) assert.equal(run("x", { extra: ["--context", c] }).code, 2, c);
});

test("checkPathSafe: a differently-cased spelling of an existing file is not an alias on a case-insensitive system", () => {
  const wt = tmpDir("cps4");
  fs.writeFileSync(path.join(wt, "Foo.txt"), "x");
  assert.equal(checkPathSafe(wt, "Foo.txt"), null);
  assert.equal(checkPathSafe(wt, "foo.txt"), null); // missing on POSIX, same file on win32/macOS; never an alias error
});

test("checkPathSafe: a folder named ..cache is not 'outside'", () => {
  const wt = tmpDir("cps3");
  fs.mkdirSync(path.join(wt, "..cache"));
  assert.equal(checkPathSafe(wt, "..cache/a.txt"), null);
});

test("--context: current files are appended to the brief for every tool and mode", () => {
  for (const [tool, mode] of [["codex", "patch"], ["cursor", "patch"]]) {
    const { root, wt, outDir, run } = setupPatch();
    commitFile(wt, "src/a.txt", "line1\r\nwith ``` inside\r\n");
    const r = run(wfReply(FB("n.txt", "x\n")), { tool, extra: ["--context", "src/a.txt", "--context", "calc.py"] });
    assert.equal(r.code, 0, r.err + r.out);
    const b = fs.readFileSync(path.join(outDir, "r1.brief.md"), "utf8");
    assert.ok(b.startsWith("brief"));
    assert.ok(b.includes("## Current src/a.txt\n\n````\nline1\nwith ``` inside\n````"), b);
    assert.ok(b.includes("## Current calc.py\n\n````\ndef add(a, b):\n    return a + b\n````"), b);
  }
});

test("--context: bad paths, missing files, big files and links are usage errors (exit 2)", () => {
  const { wt, run } = setupPatch();
  fs.writeFileSync(path.join(wt, "big.txt"), "x".repeat(200 * 1024 + 1));
  fs.writeFileSync(path.join(wt, "bin.dat"), Buffer.from([0x61, 0, 0x62]));
  fs.mkdirSync(path.join(wt, "d"));
  for (const c of ["../x", "/etc/passwd", ".git/config", "missing.txt", "big.txt", "bin.dat", "d"]) {
    const r = run("x", { extra: ["--context", c] });
    assert.equal(r.code, 2, c);
  }
  fs.writeFileSync(path.join(wt, "ok200.txt"), "x".repeat(200 * 1024));
  assert.equal(run(wfReply(FB("n.txt", "x\n")), { extra: ["--context", "ok200.txt"] }).code, 0);
});

test("--context also reaches write-mode stdin (codex)", () => {
  const { wt, outDir, run } = setupPatch();
  const r = run(wfReply(FB("n.txt", "x\n")), { extra: ["--context", "calc.py"] });
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(fs.existsSync(path.join(outDir, "r1.brief.md")));
});

test("--context errors happen before any side effect (old reply kept, no Cursor chat started)", () => {
  const { outDir, argvFile, run } = setupPatch();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "r1.md"), "previous reply");
  const r = run("x", { tool: "cursor", extra: ["--session", "new", "--context", "../x"] });
  assert.equal(r.code, 2);
  assert.equal(fs.readFileSync(path.join(outDir, "r1.md"), "utf8"), "previous reply");
  assert.ok(!fs.existsSync(argvFile));
});

test("whole-file patch mode: the stub answers with files only when the ask names the file format", () => {
  const { run, argvFile } = setupPatch();
  const r = run(wfReply(FB("seen.txt", "s\n")), { tool: "cursor" });
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(fs.readFileSync(argvFile, "utf8").includes("<<<FILE path=<relative/path> code="));
});
