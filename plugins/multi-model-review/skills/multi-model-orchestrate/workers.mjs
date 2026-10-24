// Write-mode worker run: one model edits files inside its own worktree and nowhere else.
// Zero dependencies. Flags per tool are the plan's starting point and are verified against the installed CLIs in the
// acceptance task; record any flag change in a comment next to the tool.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  TOOLS, SESSION_TOOLS, readOnlyArgs, MODEL_ID, SESSION_ID, UsageError, CODEX_HOME, safePath, quote as quoteFor, runTool, runGit, binOf, recordOutcome,
  jsonObjects, sumUsage, parseResult, classifyFailure, repoFingerprint,
} from "../multi-model-review/core.mjs";

const fail = (message) => { throw new UsageError(message); };
const TIMEOUT = 30 * 60_000;

// briefPath null = the brief is sent inline below the ask (codex and claude read it from stdin).
const briefLead = (p) => (p ? `Read the task brief at ${p}` : "Read the task brief below the line `--- TASK BRIEF ---`");
export const BRIEF_MARKER = "--- TASK BRIEF ---";
const inlineInput = (ask, brief) => `${ask}

${BRIEF_MARKER}
${fs.readFileSync(brief, "utf8")}`;
export const WORKER_ASK = (briefPath) =>
  `${briefLead(briefPath)} and do exactly what it asks. Edit files only inside the current folder. Do not commit, push or deploy. Do not run commands; if you need one (install a package, run a generator or formatter), do not run it — end your reply with a line \`NEEDS: <command> because <reason>\`. End your reply with a short summary of what you changed.`;

// Patch mode: the worker runs read-only and answers with its change as one unified diff, which we validate and
// apply with git. Live 2026-10-24: Codex write mode is unsafe on Windows and Cursor can only write with --force.
export const PATCH_TOOLS = ["codex", "cursor", "gemini"];
export const defaultMode = (tool, platform = process.platform) => (platform === "win32" && (tool === "codex" || tool === "cursor") ? "patch" : "write");

export const WORKER_PATCH_ASK = (briefPath) =>
  `${briefLead(briefPath)} and do what it asks, but you cannot edit files or run commands. Return your change as COMPLETE FILES, never as a diff: for every file you create or change, write its entire new contents inside a fenced block whose first line is \`\`\`file path=<path relative to the current folder> (for example \`\`\`file path=src/a.ts), with the closing fence alone at the start of a line. Put nothing else in a fenced block: write prose outside fences. If the file itself contains a \`\`\` line, you MUST open and close its block with four backticks (a bare \`\`\` line inside a three-backtick block ends it early and the whole reply is rejected). The file is replaced exactly as you give it, so never abbreviate it or write "rest unchanged". To delete a file, write a line \`DELETE: <path>\` outside any block. If the folder already contains your earlier change, base the file on its current contents. If you need a command run, add a line \`NEEDS: <command> because <reason>\` after the blocks.`;

// The LAST ```diff block of a reply, or null. The closing fence is at column 0: every content line of a diff starts
// with ' ', '+', '-' or '\', so a fence at column 0 can only be the real close.
export function extractPatch(text) {
  const blocks = [...String(text ?? "").matchAll(/```diff[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/g)];
  if (!blocks.length) return null;
  const body = blocks[blocks.length - 1][1].replace(/\r\n/g, "\n");
  return body.trim() ? body + "\n" : null;
}

// Whole-file replies: ```file path=<p> blocks (closing fence at column 0, at least as long as the opening one, so a
// file that contains ``` can be wrapped in ````) plus `DELETE: <p>` lines outside blocks. Returns null when the reply
// has neither. Throws on an unclosed block, a stray bare fence outside every block (a ``` line inside a file that was
// opened with only 3 backticks ends the block early and leaves the real closing fence stranded), or a path given
// twice (compared normalized: leading ./ stripped, case-folded). Content is the exact text between the fences.
const pathKey = (p) => p.replace(/^(\.\/)+/, "").toLowerCase();

function scan(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const files = [], deletes = [], outside = [], seen = new Set();
  const note = (p) => {
    const k = pathKey(p);
    if (seen.has(k)) throw new Error(`path given twice: ${p}`);
    seen.add(k);
  };
  let other = 0; // length of an open non-file fence (```sh, ```diff ...) in prose, 0 if none
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.match(/^(`{3,})[ \t]*$/);
    if (other) {
      outside.push(line);
      if (bare && bare[1].length >= other) other = 0;
      continue;
    }
    const open = line.match(/^(`{3,})file[ \t]+path=[ \t]*(.*?)[ \t]*$/);
    if (open) {
      const p = open[2].replace(/^(["'])(.*)\1$/, "$2");
      const body = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        const c = lines[i].match(/^(`{3,})[ \t]*$/);
        if (c && c[1].length >= open[1].length) { closed = true; break; }
        body.push(lines[i]);
      }
      if (!closed) throw new Error(`the file block for ${p} is never closed`);
      note(p);
      files.push({ path: p, content: body.length ? body.join("\n") + "\n" : "" });
      continue;
    }
    if (bare) throw new Error("a stray ``` line outside any file block: a file that contains ``` must be wrapped in a four-backtick fence");
    const o = line.match(/^(`{3,})\S/);
    if (o) { other = o[1].length; outside.push(line); continue; }
    outside.push(line);
    const del = line.match(/^DELETE: (\S.*?)[ \t]*$/);
    if (del && cleanPath(del[1])) { note(del[1]); deletes.push(del[1]); }
  }
  return { files, deletes, outside: outside.join("\n") };
}

export function extractFiles(text) {
  const { files, deletes } = scan(text);
  return files.length || deletes.length ? { files, deletes } : null;
}

// The reply with every ```file block cut out (file contents must not count as prose, NEEDS lines or diffs).
export function outsideFileBlocks(text) {
  try { return scan(text).outside; } catch { return String(text ?? ""); }
}

// Normalized worktree-relative path, or null when it is not an acceptable file path.
function cleanPath(raw) {
  const p = String(raw).replace(/^(\.\/)+/, "");
  if (!p || /[\x00-\x1f"]/.test(p) || p !== p.trim()) return null;
  if (!validatePatch(`diff --git a/${p} b/${p}\n`).ok) return null;
  if (p.endsWith("/") || p.split("/").some((s) => s === "" || s === ".")) return null;
  return p;
}

const MAX_FILE = 1024 * 1024;

// Why a worktree-relative path must not be read or written, or null. Looks at the disk: a symlink (or junction)
// anywhere along the path, or a parent that resolves outside the worktree. Missing parts are fine (new files).
export function checkPathSafe(worktree, rel) {
  const root = fs.realpathSync(worktree);
  const segs = rel.split("/");
  let cur = worktree;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }
    const here = segs.slice(0, i + 1).join("/");
    if (st.isSymbolicLink()) return `${here} is a symlink`;
    if (i < segs.length - 1) {
      if (!st.isDirectory()) return `${here} is not a folder`;
      const rp = path.relative(root, fs.realpathSync(cur));
      if (rp === ".." || rp.startsWith(".." + path.sep) || path.isAbsolute(rp)) return `${here} resolves outside the worktree`;
    } else if (st.isDirectory()) return `${here} is a folder`;
  }
  return null;
}

// Splits text into lines that keep their own terminator; the last piece may have none.
const pieces = (t) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// Synthesizes an exact git patch that turns the worktree's current files into the worker's whole files: one hunk per
// file, every old line removed and every new line added. Existing files keep their line endings (CRLF if they contain
// any CRLF); new files are written with LF (git normalizes them under core.autocrlf). Throws Error(reason) on any
// refusal, before reading or writing anything it should not.
// New file text in the old file's line endings. Lines the worker left alone (same text at the start or the end of the
// file) keep their original terminator byte for byte; new or changed lines get the file's dominant ending (CRLF only
// if it has more CRLF than bare LF). A file with one ending throughout comes out with that ending.
function withOldEols(old, content) {
  const oldP = pieces(old).map((x) => ({ t: x.replace(/\r?\n$/, ""), raw: x, nl: x.endsWith("\n") }));
  const crlf = (old.match(/\r\n/g) ?? []).length, lf = (old.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > lf ? "\r\n" : "\n";
  const newP = pieces(content.replace(/\r\n/g, "\n")).map((x) => ({ t: x.replace(/\n$/, ""), nl: x.endsWith("\n") }));
  const same = (a, b) => a.t === b.t && a.nl === b.nl;
  let k = 0;
  while (k < oldP.length && k < newP.length && same(oldP[k], newP[k])) k++;
  let e = 0;
  while (e < oldP.length - k && e < newP.length - k && same(oldP[oldP.length - 1 - e], newP[newP.length - 1 - e])) e++;
  return newP.map((n, i) => {
    if (i < k) return oldP[i].raw;
    if (i >= newP.length - e) return oldP[oldP.length - (newP.length - i)].raw;
    return n.t + (n.nl ? eol : "");
  }).join("");
}

export function buildPatch(worktree, files, deletes = []) {
  const out = [];
  const wanted = [...files.map((f) => ({ ...f, del: false })), ...deletes.map((p) => ({ path: p, del: true }))];
  for (const w of wanted) {
    const p = w.path.replace(/^(\.\/)+/, "");
    const badShape = new Error(`bad file path: ${JSON.stringify(w.path)}`);
    if (!p || /[\x00-\x1f"]/.test(p) || p !== p.trim()) throw badShape;
    const v = validatePatch(`diff --git a/${p} b/${p}\n`);
    if (!v.ok) throw new Error(v.reason);
    if (p.endsWith("/") || p.split("/").some((s) => s === "" || s === ".")) throw badShape;
    const unsafe = checkPathSafe(worktree, p);
    if (unsafe) throw new Error(`${p}: ${unsafe}`);
    const abs = path.join(worktree, p);
    let old = null, oldBytes = null, exec = false;
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE) throw new Error(`${p}: larger than 1 MB`);
      oldBytes = fs.readFileSync(abs);
      old = oldBytes.toString("utf8");
      if (!Buffer.from(old, "utf8").equals(oldBytes) || old.includes("\0")) throw new Error(`${p}: not a UTF-8 text file`);
      exec = (st.mode & 0o111) !== 0;
    }
    if (w.del) {
      if (old === null) throw new Error(`${p}: cannot delete, the file does not exist`);
      out.push(...header(p, `deleted file mode ${exec ? "100755" : "100644"}`));
      if (old) hunk(out, `--- a/${p}`, "+++ /dev/null", pieces(old), []);
      continue;
    }
    if (Buffer.byteLength(w.content) > MAX_FILE) throw new Error(`${p}: larger than 1 MB`);
    const next = old !== null && old.includes("\n") ? withOldEols(old, w.content) : w.content.replace(/\r\n/g, "\n");
    if (next === old) continue;
    if (old === null) {
      out.push(...header(p, "new file mode 100644"));
      if (next) hunk(out, "--- /dev/null", `+++ b/${p}`, [], pieces(next));
    } else {
      out.push(...header(p));
      hunk(out, `--- a/${p}`, `+++ b/${p}`, pieces(old), pieces(next));
    }
  }
  return out.join("");
}

const header = (p, mode) => [`diff --git a/${p} b/${p}\n`, ...(mode ? [`${mode}\n`] : [])];
function hunk(out, from, to, oldLines, newLines) {
  const range = (sign, n) => `${sign}${n ? 1 : 0},${n}`;
  out.push(`${from}\n`, `${to}\n`, `@@ ${range("-", oldLines.length)} ${range("+", newLines.length)} @@\n`);
  for (const [sign, ls] of [["-", oldLines], ["+", newLines]]) {
    for (const l of ls) out.push(l.endsWith("\n") ? sign + l : `${sign}${l}\n\\ No newline at end of file\n`);
  }
}

const ALLOWED_MODES = [0o100644, 0o100755];

// Pure check of a patch before git sees it. Paths come from `diff --git`, ---/+++ and rename/copy lines.
export function validatePatch(patch) {
  const files = new Set();
  let headers = 0;
  const badPath = (raw) => {
    const p = raw.replace(/^"|"$/g, "");
    if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return `absolute path: ${p}`;
    if (/[\\\x00-\x1f]/.test(p)) return `path with a backslash or control character: ${p}`;
    const segs = p.toLowerCase().split("/");
    if (segs.includes("..")) return `path leaves the folder: ${p}`;
    if (segs.includes(".git")) return `path inside .git: ${p}`;
    return null;
  };
  const strip = (p) => p.replace(/^"?[ab]\//, "").replace(/"$/, "");
  for (const line of String(patch ?? "").split(/\r?\n/)) {
    let paths = [], m;
    if ((m = line.match(/^diff --git (.+)$/))) {
      headers++;
      const q = m[1].match(/^"?a\/(.+?)"? "?b\/(.+?)"?$/);
      if (!q) return { ok: false, reason: `cannot read file names in: ${line}`, files: [] };
      paths = [`a/${q[1]}`, `b/${q[2]}`];
    } else if ((m = line.match(/^(?:---|\+\+\+) (.+?)(?:\t.*)?$/))) {
      if (m[1] !== "/dev/null") paths = [m[1]];
    } else if ((m = line.match(/^(?:rename|copy) (?:from|to) (.+)$/))) {
      paths = [`a/${m[1]}`];
    } else if ((m = line.match(/^(?:new file|deleted file|old|new) mode (\S*)/) ?? line.match(/^index \S+ (\S+)\s*$/))) {
      // Only regular files: 100644 and 100755. Symlinks (120000 in any spelling), gitlinks (160000) and odd modes are out.
      if (!/^[0-7]+$/.test(m[1]) || !ALLOWED_MODES.includes(parseInt(m[1], 8))) {
        return { ok: false, reason: `file mode ${m[1]} is not allowed (symlinks and submodules are refused)`, files: [] };
      }
    }
    for (const raw of paths) {
      const why = badPath(raw) ?? badPath(strip(raw));
      if (why) return { ok: false, reason: why, files: [] };
      files.add(strip(raw));
    }
  }
  if (!headers) return { ok: false, reason: "the patch has no `diff --git` file headers", files: [] };
  return { ok: true, reason: null, files: [...files] };
}

// Validate, then check and apply inside the worktree. Returns { applied, error }.
// exact: the patch is byte-exact against the files on disk (we built it), so git must not convert line endings
// (core.autocrlf=true would turn an LF file into CRLF on write). Attributes such as text=auto, eol= or ident still
// apply on write; this does not switch them off.
export function applyPatch(worktree, patch, patchFile, { exact = false } = {}) {
  const v = validatePatch(patch);
  if (!v.ok) return { applied: false, error: `patch rejected: ${v.reason}` };
  fs.writeFileSync(patchFile, patch);
  const opts = ["-c", "core.protectNTFS=true", "-c", "core.protectHFS=true", ...(exact ? ["-c", "core.autocrlf=false"] : [])];
  const tail = ["--whitespace=nowarn", patchFile];
  const gitErr = (r) => (r.err || r.spawnError?.message || "").trim();
  const check = runGit(worktree, [...opts, "apply", "--check", ...tail]);
  if (check.code !== 0) return { applied: false, error: `git apply --check failed: ${gitErr(check)}` };
  const summary = runGit(worktree, [...opts, "apply", "--summary", "--numstat", ...tail]);
  if (SUMMARY_LINK.test(summary.out)) return { applied: false, error: "patch rejected: symlink not allowed (git's summary shows a link or submodule mode)" };
  const done = runGit(worktree, [...opts, "apply", ...tail]);
  if (done.code !== 0) return { applied: false, error: `git apply failed: ${gitErr(done)}` };
  // Last line of defense: nothing the patch touched may be a symlink on disk or in the index.
  const link = symlinkAmong(worktree, v.files);
  if (link) {
    runGit(worktree, [...opts, "apply", "-R", ...tail]);
    return { applied: false, error: `symlink not allowed: ${link}` };
  }
  return { applied: true, error: null };
}

const SUMMARY_LINK = /mode (?:change [0-7]+ => )?0*(?:120000|160000)\b/;

// Returns the first of `files` (paths relative to the worktree) that is a symlink on disk or a 120000 entry in the index.
export function symlinkAmong(worktree, files) {
  for (const f of files) {
    try { if (fs.lstatSync(path.join(worktree, f)).isSymbolicLink()) return f; } catch { /* missing or deleted */ }
  }
  const r = runGit(worktree, ["ls-files", "-s", "-z", "--", ...files]);
  for (const e of r.out.split("\0")) {
    const m = e.match(/^(\d+) \S+ \d+\t(.*)$/);
    if (m && parseInt(m[1], 8) === 0o120000) return m[2];
  }
  return null;
}

export const parseNeeds = (text) => outsideFileBlocks(text).split(/\r?\n/).flatMap((l) => {
  const m = l.match(/^\s*NEEDS:\s*(.+?)\s*$/);
  return m ? [m[1]] : [];
});

// Codex has no "all MCP off" switch (live test 2026-10-24: `-c mcp_servers={}` leaves the user's servers running).
// Each server and plugin has to be disabled by name, from the user's own config.toml. Pure: takes the file text.
// Servers come from `[mcp_servers.<name>]` headers (sub-tables such as `[mcp_servers.x.env]` count once), plugins
// from `[plugins."<name>"]` headers. Returns raw values for `-c`; workerArgs does the shell quoting.
const KEY = `(${/"(?:[^"\\\r\n]|\\.)*"|[A-Za-z0-9_-]+/.source})`;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:+\/-]*$/; // nothing cmd.exe or a TOML key would misread
const HEADER = new RegExp(String.raw`^\s*\[\s*(mcp_servers|plugins)\s*\.\s*` + KEY);
export function codexIsolationArgs(configText) { return codexIsolation(configText).args; }
// Same, plus the names skipped because they cannot be passed safely (they stay enabled; work reports them).
export function codexIsolation(configText) {
  const names = { mcp_servers: new Set(), plugins: new Set() };
  const skipped = [];
  for (const line of String(configText ?? "").split(/\r?\n/)) {
    const m = line.match(HEADER);
    if (!m) continue;
    const name = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    if (SAFE_NAME.test(name)) names[m[1]].add(name);
    else if (!skipped.includes(`${m[1]}.${name}`)) skipped.push(`${m[1]}.${name}`);
  }
  const key = (n) => (/^[A-Za-z0-9_-]+$/.test(n) ? n : `"${n}"`);
  const args = [
    ...[...names.mcp_servers].flatMap((n) => ["-c", `mcp_servers.${key(n)}.enabled=false`]),
    ...[...names.plugins].flatMap((n) => ["-c", `plugins.${key(n)}.enabled=false`]),
    "-c", 'web_search="disabled"',
  ];
  return { args, skipped };
}
// A `-c` value holds TOML quotes. Through cmd.exe the C runtime would eat them, so wrap the value and escape them.
export const configArg = (v, platform = process.platform) => (platform === "win32" && v.includes('"') ? `"${v.replace(/"/g, '\\"')}"` : v);
export function readCodexConfig(codexHome = CODEX_HOME) {
  try { return fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"); } catch { return ""; }
}

// worktree and brief are absolute and already safe. sid is the session id chosen up front (claude, gemini).
export function workerArgs(tool, { model, worktree, brief, out, session, resume, chat, sid, isolation = [], mode = "write", platform = process.platform }) {
  const patch = mode === "patch";
  const mk = patch ? WORKER_PATCH_ASK : WORKER_ASK;
  const ask = mk(brief), inlineAsk = mk(null);
  const briefDir = path.dirname(brief);
  const sessionFlags = resume ? ["--resume", resume] : sid ? ["--session-id", sid] : [];
  const cwd = worktree;
  const quote = (p) => quoteFor(p, platform);
  if (tool === "codex") {
    // `codex exec resume` has no -s or -C flag, so the sandbox is set through config on resumed turns and the
    // folder comes from cwd. MCP servers and plugins are switched off one by one (see codexIsolationArgs).
    // Live 2026-10-24: Codex write mode is unsafe on Windows (the elevated sandbox cannot write; in the unelevated
    // one apply_patch wrote outside the worktree), so the menu warns there.
    const iso = isolation.map((v) => (v === "-c" ? v : configArg(v, platform)));
    const common = ["--json", "--skip-git-repo-check", "-m", model, "-o", quote(out)];
    const args = resume
      ? ["exec", "resume", ...common, ...(patch ? readOnlyArgs("codex", { resume: true }) : ["-c", "sandbox_mode=workspace-write"]), ...iso, resume, "-"]
      : ["exec", ...common, ...(patch ? readOnlyArgs("codex") : ["-s", "workspace-write"]), "-C", quote(worktree), ...iso, "-"];
    return { cmd: "codex", args, input: inlineInput(inlineAsk, brief), cwd };
  }
  if (tool === "claude") {
    // No --add-dir, and Edit and Write are NOT in --allowedTools (an allow rule has no path scope). They stay in
    // --tools so the model has them, and --permission-mode acceptEdits auto-approves edits only inside the working
    // folder; a write outside it is refused. No shell, no web.
    // verify live: Claude worker still writes in cwd and is refused outside it
    return { cmd: "claude", cwd, input: inlineInput(inlineAsk, brief), args: ["-p", "--model", model, ...sessionFlags,
      "--output-format", "json", "--tools", "Read,Grep,Glob,Edit,Write", "--strict-mcp-config", "--disable-slash-commands",
      "--setting-sources", "project,local", "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Grep", "Glob",
      "--disallowedTools", "Bash", "PowerShell", "NotebookEdit", "WebFetch", "WebSearch"] };
  }
  if (tool === "gemini") {
    return { cmd: "gemini", cwd, args: ["-p", quote(ask), "-m", model, ...sessionFlags,
      ...(patch ? readOnlyArgs("gemini") : ["--approval-mode", "auto_edit"]), "--skip-trust", "-o", "json", "--include-directories", quote(briefDir)] };
  }
  if (tool === "cursor") {
    // --force auto-approves everything; Cursor's sandbox exists only on macOS and Linux. Patch mode uses ask mode, never --force.
    const guard = patch ? readOnlyArgs("cursor", { platform }) : ["--force", ...(platform === "win32" ? [] : ["--sandbox", "enabled"])];
    return { cmd: binOf("cursor"), cwd, args: ["-p", ...guard,
      "--trust", "--output-format", "json", "--model", model, ...(chat ? ["--resume", chat] : []),
      "--workspace", quote(worktree), "--add-dir", quote(briefDir), quote(ask)] };
  }
  return { cmd: "copilot", cwd, args: ["-p", quote(ask), "--model", model, "--add-dir", quote(briefDir),
    "--allow-tool", "write", "--deny-tool", "shell", "--deny-tool", "url", "--no-color", "-s"] };
}

const flag = (args, name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flags = (args, name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1] ?? fail(`--${name} needs a value`)] : []));
const MAX_CONTEXT = 200 * 1024;

// "## Current <path>" plus the file in a fence longer than any backtick run inside it, CRs stripped. Usage error
// (exit 2) if the path is not a plain file path inside the worktree, is missing, over 200 KB, or not text.
function contextSection(worktree, raw) {
  const p = cleanPath(raw) ?? fail(`--context is not an acceptable file path: ${raw}`);
  const unsafe = checkPathSafe(worktree, p);
  if (unsafe) fail(`--context ${p}: ${unsafe}`);
  const abs = path.join(worktree, p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`--context ${p}: no such file in the worktree`);
  if (fs.statSync(abs).size > MAX_CONTEXT) fail(`--context ${p}: larger than 200 KB`);
  const bytes = fs.readFileSync(abs);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) fail(`--context ${p}: not a UTF-8 text file`);
  const body = text.replace(/\r/g, "");
  const fence = "`".repeat(Math.max(4, ...(body.match(/`+/g) ?? []).map((r) => r.length + 1)));
  return `## Current ${p}\n\n${fence}\n${body}${body.endsWith("\n") || !body ? "" : "\n"}${fence}`;
}
const porcelain = (dir) => runGit(dir, ["status", "--porcelain"]);
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

export function work(args) {
  const tool = flag(args, "tool"), model = flag(args, "model"), session = flag(args, "session");
  if (!TOOLS.includes(tool)) fail(`--tool must be one of ${TOOLS.join(", ")}`);
  if (!model || !MODEL_ID.test(model)) fail(`--model is missing or not a valid model id: ${model}`);
  if (session !== undefined && session !== "new" && !SESSION_ID.test(session)) fail(`--session must be "new" or a session id: ${session}`);
  if (session && !SESSION_TOOLS.includes(tool)) fail(`--session is not supported for ${tool}; use one of ${SESSION_TOOLS.join(", ")}`);
  const brief = safePath(flag(args, "brief") ?? fail("--brief is required"), "brief");
  const worktree = safePath(flag(args, "worktree") ?? fail("--worktree is required"), "worktree");
  const out = safePath(flag(args, "out") ?? fail("--out is required"), "out");
  const repo = safePath(flag(args, "repo") ?? fail("--repo is required"), "repo");
  if (same(path.resolve(repo), path.resolve(worktree))) fail("--repo and --worktree must be different folders");
  if (!fs.existsSync(brief)) fail(`brief not found: ${brief}`);
  if (!fs.existsSync(worktree)) fail(`--worktree does not exist: ${worktree}`);
  if (!fs.existsSync(repo)) fail(`--repo does not exist: ${repo}`);
  // The worktree must be a linked worktree of the user's repo: same repo, but its own top folder.
  const probe = (dir, ...a) => {
    const r = runGit(dir, ["rev-parse", ...a]);
    if (r.code !== 0) fail(`not a git repo: ${dir}${r.err ? ` (${r.err.trim()})` : ""}`);
    return r.out.trim();
  };
  const real = (p) => fs.realpathSync(p);
  if (probe(repo, "--is-inside-work-tree") !== "true") fail(`--repo is not a git work tree: ${repo}`);
  if (probe(worktree, "--is-inside-work-tree") !== "true") fail(`--worktree is not inside a git worktree: ${worktree}`);
  if (real(probe(worktree, "--path-format=absolute", "--git-common-dir")) !== real(probe(repo, "--path-format=absolute", "--git-common-dir"))) {
    fail("--worktree belongs to a different git repo than --repo");
  }
  if (same(real(probe(worktree, "--show-toplevel")), real(probe(repo, "--show-toplevel")))) {
    fail("--worktree must be a separate linked worktree, not the repo itself or a subfolder of it");
  }
  const mode = flag(args, "mode") ?? defaultMode(tool);
  if (mode !== "write" && mode !== "patch") fail(`--mode must be write or patch, not ${mode}`);
  if (mode === "patch" && !PATCH_TOOLS.includes(tool)) fail(`--mode patch is not supported for ${tool}; use one of ${PATCH_TOOLS.join(", ")}, or --mode write`);
  const resume = session && session !== "new" ? session : null;
  let repoBefore;
  try { repoBefore = repoFingerprint(repo); } catch (e) { fail(e.message); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true }); // never read a stale reply from an earlier round
  const patchFile = out.replace(/\.md$/i, "") + ".patch";
  fs.rmSync(patchFile, { force: true });

  let sid = null, chat = resume;
  if (tool === "claude") sid = resume ?? (session === "new" ? crypto.randomUUID() : null);
  else if (tool === "gemini") sid = session === "new" ? crypto.randomUUID() : null;
  else if (tool === "cursor" && session === "new") {
    const c = runTool(binOf("cursor"), ["create-chat"]);
    chat = c.out.trim().split(/\r?\n/).pop()?.trim();
    if (c.code !== 0 || !chat || !SESSION_ID.test(chat)) fail(`could not start a Cursor chat: ${c.err || c.out}`.trim());
  }

  const iso = tool === "codex" ? codexIsolation(readCodexConfig()) : { args: [], skipped: [] };
  // --context <path> (repeatable): the current contents of existing files, appended to the brief. Workers on Windows
  // may not be able to read the folder at all.
  const ctx = flags(args, "context");
  let briefFile = brief;
  if (ctx.length) {
    const parts = ctx.map((c) => contextSection(worktree, c));
    briefFile = out.replace(/\.md$/i, "") + ".brief.md";
    fs.writeFileSync(briefFile, `${fs.readFileSync(brief, "utf8")}\n\n${parts.join("\n\n")}\n`);
  }
  const w = workerArgs(tool, { model, worktree, brief: briefFile, out, session, resume, chat, sid, isolation: iso.args, mode });
  const r = runTool(w.cmd, w.args, { input: w.input, cwd: w.cwd, timeout: TIMEOUT });
  const { text, sessionId, usage } = parseResult(tool, r, { session, resume, sid, chat });
  const outcome = classifyFailure(r, { resume });
  if (tool !== "codex") { const reply = text ?? r.out; if (reply) fs.writeFileSync(out, reply); }
  fs.writeFileSync(out.replace(/\.md$/i, "") + ".log", `exit ${r.code}\nmode ${mode}\n${tool === "codex" ? `isolation skipped (left enabled): ${JSON.stringify(iso.skipped)}\n` : ""}--- stderr ---\n${r.err}\n${text === null && tool !== "codex" ? "" : `--- stdout ---\n${r.out}\n`}`);
  recordOutcome(tool, model, outcome, r);

  const usageFile = path.join(path.dirname(out), "usage.jsonl");
  if (usage) fs.appendFileSync(usageFile, JSON.stringify({ at: new Date().toISOString(), tool, model, sessionId, reply: path.basename(out), ...usage }) + "\n");
  const totals = sumUsage(fs.existsSync(usageFile) ? jsonObjects(fs.readFileSync(usageFile, "utf8")) : []);

  const outsideChanged = repoFingerprint(repo) !== repoBefore;
  const reply = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  // Patch mode: only when the worker run itself succeeded and nothing changed outside the worktree.
  let patchOut = {};
  if (mode === "patch") {
    let error = null;
    if (outsideChanged) error = "not attempted: something changed outside the worktree";
    else if (outcome.exitCode !== 0) error = `not attempted: the worker run failed (exit ${outcome.exitCode})`;
    else {
      let patch = null, exact = false;
      try {
        const ex = extractFiles(reply);
        if (ex && extractPatch(outsideFileBlocks(reply)) !== null) throw new Error("reply has both file blocks and a diff; send whole files only");
        patch = ex ? buildPatch(worktree, ex.files, ex.deletes) : extractPatch(reply);
        exact = Boolean(ex);
        if (ex && !patch) error = "patch rejected: every file in the reply is identical to the current file, so there is nothing to change";
        else if (patch === null) error = "no ```file block (or ```diff block) found in the reply";
      } catch (e) { error = "patch rejected: " + e.message; }
      if (error === null) error = applyPatch(worktree, patch, patchFile, { exact }).error;
    }
    patchOut = { patchApplied: error === null, patchError: error };
    if (error) fs.appendFileSync(out.replace(/\.md$/i, "") + ".log", `patch error: ${error}\n`);
  }
  const changedFiles = porcelain(worktree).out.split(/\r?\n/).filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status: outcome.status, out, sessionId: session ? sessionId : undefined,
    usage, totals, needs: parseNeeds(reply), changedFiles, outsideChanged, mode, ...patchOut, isolationSkipped: iso.skipped }, null, 2));
  process.exit(outsideChanged ? 5 : outcome.exitCode !== 0 ? outcome.exitCode : patchOut.patchError ? 9 : 0);
}
