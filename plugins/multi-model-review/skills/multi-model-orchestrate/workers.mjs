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
// Patch mode: the worker runs read-only and answers with the complete new contents of each changed file, which we
// turn into an exact git patch and apply through the safety pipeline. Live 2026-10-24: Codex write mode is unsafe on
// Windows and Cursor can only write with --force.
export const PATCH_TOOLS = ["codex", "cursor", "gemini"];
export const defaultMode = (tool, platform = process.platform) => (platform === "win32" && (tool === "codex" || tool === "cursor") ? "patch" : "write");

// A fresh random delimiter code per `work` call: 6 uppercase letters and digits. A file's own text cannot know it.
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");

export const WORKER_PATCH_ASK = (briefPath, code = newCode()) =>
  `${briefLead(briefPath)} and do what it asks, but you cannot edit files or run commands. Return your change as COMPLETE FILES, never as a diff. Use only the code given in this message. For every file you create or change, write a line \`<<<FILE path=<relative/path> code=${code}>>>\` on its own (for example \`<<<FILE path=src/a.ts code=${code}>>>\`), then the file's exact, complete new contents, then a line \`<<<END ${code}>>>\` on its own. The path is relative to the current folder. Backticks and any other characters inside the contents need no escaping; just never write a line that starts with <<<FILE, <<<END or <<<DELETE inside a file. The file is replaced exactly as you give it, so never abbreviate it or write "rest unchanged". To delete a file, write a line \`<<<DELETE path=<relative/path> code=${code}>>>\` outside any block. Write all other prose outside the blocks. After the last block write a final line \`<<<DONE code=${code} files=<number of FILE blocks> deletes=<number of DELETE lines>>>>\`; a reply without it is rejected as cut off. Never write a line containing <<< followed by FILE, END, DELETE or DONE except these delimiters. If the folder already contains your earlier change, base the file on its current contents. If you need a command run, add a line \`NEEDS: <command> because <reason>\` after the blocks.`;

// Whole-file replies. Only lines that exactly match this call's start, end, delete or done pattern are delimiters;
// content is everything between a start line and its end line, verbatim (CRs stripped, a leading BOM dropped).
// Throws on: any line, inside or outside a block, that looks like a delimiter after stripping BOM, whitespace and
// backticks and NFKC-normalizing (<<< then FILE, END, DELETE or DONE, any case) but is not exactly a delimiter for THIS
// call (this is the safe choice: a file that quotes delimiters, or a mangled delimiter, rejects the reply rather than
// being guessed at; so a file with such a line cannot be written in patch mode); a non-delimiter line that contains the
// code; an unclosed block; a start line inside a block; an END without a start; a path given twice (normalized:
// leading ./ stripped, case-folded); a missing, repeated, early or miscounted <<<DONE code=C files=N deletes=M>>> line
// (it must follow every block; it catches a reply cut off before its last blocks). Error texts never contain the code.
// Returns { files, deletes, outside } where outside is the prose with every block cut out.
const pathKey = (p) => p.replace(/^(\.\/)+/, "").toLowerCase();
const LOOKS_LIKE_DELIM = /<<<\s*(?:FILE|END|DELETE|DONE)/i;

function scan(text, code) {
  const start = new RegExp(`^<<<FILE path=(.+?) code=${code}>>>$`);
  const del = new RegExp(`^<<<DELETE path=(.+?) code=${code}>>>$`);
  const done = new RegExp(`^<<<DONE code=${code} files=(\\d+) deletes=(\\d+)>>>$`);
  const end = `<<<END ${code}>>>`;
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const files = [], deletes = [], outside = [], seen = new Set();
  let counts = null;
  const note = (p) => {
    const k = pathKey(p);
    if (seen.has(k)) throw new Error(`path given twice: ${p}`);
    seen.add(k);
  };
  const suspicious = (line) => LOOKS_LIKE_DELIM.test(line.normalize("NFKC").replace(/[\uFEFF`]/g, "")) || line.includes(code);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const s = line.match(start);
    if (s) {
      if (counts) throw new Error(`a file block (line ${i + 1}) after the <<<DONE line`);
      const body = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (lines[i] === end) { closed = true; break; }
        if (suspicious(lines[i])) throw new Error(`unexpected delimiter-like line ${i + 1} inside the block for ${s[1]}`);
        body.push(lines[i]);
      }
      if (!closed) throw new Error(`the block for ${s[1]} is never closed`);
      note(s[1]);
      files.push({ path: s[1], content: body.length ? body.join("\n") + "\n" : "" });
      continue;
    }
    const d = line.match(del);
    if (d) {
      if (counts) throw new Error(`a delete line (${i + 1}) after the <<<DONE line`);
      note(d[1]); deletes.push(d[1]); continue;
    }
    const dn = line.match(done);
    if (dn) {
      if (counts) throw new Error("more than one <<<DONE line");
      counts = [Number(dn[1]), Number(dn[2])];
      continue;
    }
    if (line === end) throw new Error("a <<<END line with no block open");
    if (suspicious(line)) throw new Error(`line ${i + 1} looks like a block delimiter but is not an exact one for this reply (wrong or missing code, wrong case, indentation, backticks or other characters)`);
    outside.push(line);
  }
  if (files.length || deletes.length || counts) {
    if (!counts) throw new Error("the reply has no final <<<DONE line, so it may be cut off");
    if (counts[0] !== files.length || counts[1] !== deletes.length) {
      throw new Error(`the <<<DONE line says ${counts[0]} files and ${counts[1]} deletes but the reply has ${files.length} files and ${deletes.length} deletes`);
    }
  }
  return { files, deletes, outside: outside.join("\n") };
}

// null when the reply has no blocks at all.
export function extractFiles(text, code) {
  const { files, deletes } = scan(text, code);
  return files.length || deletes.length ? { files, deletes } : null;
}

// The reply with every block cut out (file contents must not count as prose or NEEDS lines).
export function outsideFileBlocks(text, code) { return scan(text, code).outside; }

// Why a worktree-relative path is not acceptable, or null. Pure text checks; checkPathSafe looks at the disk.
function pathProblem(raw) {
  const p = String(raw).replace(/^(\.\/)+/, "");
  const bad = `bad file path: ${JSON.stringify(raw)}`;
  if (!p || /[\x00-\x1f"]/.test(p) || p !== p.trim()) return bad;
  const v = validatePatch(`diff --git a/${p} b/${p}\n`);
  if (!v.ok) return v.reason;
  const segs = p.split("/");
  if (p.endsWith("/") || segs.some((s) => s === "" || s === ".")) return bad;
  if (segs.some((s) => /[. ]$/.test(s))) return `${p}: a name ending in a dot or space is not allowed (Windows treats it as another name)`;
  if (segs.some((s) => /~\d+(\.|$)/.test(s))) return `${p}: a name with ~<digits> at its end or before an extension is not allowed (Windows 8.3 short names are aliases)`;
  if (segs.some((s) => s.includes(":"))) return `${p}: a name containing ":" is not allowed (Windows alternate data streams and drive letters)`;
  if (segs.some((s) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s.split(".")[0]))) return `${p}: a Windows reserved device name (con, prn, aux, nul, com1-9, lpt1-9) is not allowed`;
  return null;
}
// Normalized worktree-relative path, or null when it is not an acceptable file path.
const cleanPath = (raw) => (pathProblem(raw) ? null : String(raw).replace(/^(\.\/)+/, ""));

const MAX_FILE = 1024 * 1024;

// Why a worktree-relative path must not be read or written, or null. Looks at the disk: a symlink (or junction)
// anywhere along the path, or a parent that resolves outside the worktree. Missing parts are fine (new files).
export function checkPathSafe(worktree, rel) {
  const root = fs.realpathSync.native(worktree);
  const segs = rel.split("/");
  let cur = worktree;
  // The real path of what exists must be the worktree's real path plus the lexical segments: this catches 8.3 short
  // names, mount aliases and any other spelling the file system resolves to a different name.
  const aliased = (upTo) => {
    const want = path.join(root, ...segs.slice(0, upTo));
    let got;
    try { got = fs.realpathSync.native(path.join(worktree, ...segs.slice(0, upTo))); } catch { return null; }
    const norm = (x) => (process.platform === "win32" ? x.toLowerCase() : x);
    return norm(got) === norm(want) ? null : `${segs.slice(0, upTo).join("/")} resolves to a different path (${got}); it is an alias`;
  };
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { return aliased(i); }
    const here = segs.slice(0, i + 1).join("/");
    if (st.isSymbolicLink()) return `${here} is a symlink`;
    if (i < segs.length - 1) {
      if (!st.isDirectory()) return `${here} is not a folder`;
      const rp = path.relative(root, fs.realpathSync.native(cur));
      if (rp === ".." || rp.startsWith(".." + path.sep) || path.isAbsolute(rp)) return `${here} resolves outside the worktree`;
    } else if (st.isDirectory()) return `${here} is a folder`;
  }
  return aliased(segs.length);
}

// Splits text into lines that keep their own terminator; the last piece may have none.
const pieces = (t) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// Synthesizes an exact git patch that turns the worktree's current files into the worker's whole files: one hunk per
// file, every old line removed and every new line added. Existing files keep their line endings (all CRLF or all LF; a
// file with both is refused); new files are written with LF (git normalizes them under core.autocrlf). Throws
// Error(reason) on any refusal, before reading or writing anything it should not.
function withOldEols(old, content) {
  const lf = content.replace(/\r\n/g, "\n");
  return /\r\n/.test(old) ? lf.replace(/\n/g, "\r\n") : lf;
}
const hasMixedEols = (t) => { const crlf = (t.match(/\r\n/g) ?? []).length; return crlf > 0 && (t.match(/\n/g) ?? []).length > crlf; };

export function buildPatch(worktree, files, deletes = []) {
  const out = [];
  const wanted = [...files.map((f) => ({ ...f, del: false })), ...deletes.map((p) => ({ path: p, del: true }))];
  for (const w of wanted) {
    const why = pathProblem(w.path);
    if (why) throw new Error(why);
    const p = w.path.replace(/^(\.\/)+/, "");
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
    if (old !== null && hasMixedEols(old)) throw new Error(`${p} has mixed line endings; edit it in write mode or normalize it first`);
    // An existing file keeps its final-newline state: models drop or add the last newline by accident.
    let body = w.content;
    if (old) {
      if (!old.endsWith("\n") && body.endsWith("\n")) body = body.replace(/\r?\n$/, "");
      else if (old.endsWith("\n") && body && !body.endsWith("\n")) body += "\n";
    }
    const next = old !== null && old.includes("\n") ? withOldEols(old, body) : body.replace(/\r\n/g, "\n");
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

// code given: only prose outside this call's blocks counts (a reply that does not parse yields no NEEDS).
export const parseNeeds = (text, code) => {
  let t = String(text ?? "");
  if (code) { try { t = outsideFileBlocks(t, code); } catch { return []; } }
  return t.split(/\r?\n/).flatMap((l) => {
    const m = l.match(/^\s*NEEDS:\s*(.+?)\s*$/);
    return m ? [m[1]] : [];
  });
};

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
export function workerArgs(tool, { model, worktree, brief, out, session, resume, chat, sid, isolation = [], mode = "write", platform = process.platform, code = newCode() }) {
  const patch = mode === "patch";
  const mk = patch ? (b) => WORKER_PATCH_ASK(b, code) : WORKER_ASK;
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
  // --context <path> (repeatable): the current contents of existing files, appended to the brief. Workers on Windows
  // may not be able to read the folder at all. Validated here, with the other arguments, before any side effect.
  const ctxParts = flags(args, "context").map((c) => contextSection(worktree, c));
  const code = newCode();
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
  let briefFile = brief;
  if (ctxParts.length) {
    briefFile = out.replace(/\.md$/i, "") + ".brief.md";
    fs.writeFileSync(briefFile, `${fs.readFileSync(brief, "utf8")}\n\n${ctxParts.join("\n\n")}\n`);
  }
  const w = workerArgs(tool, { model, worktree, brief: briefFile, out, session, resume, chat, sid, isolation: iso.args, mode, code });
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
      let patch = null;
      try {
        const ex = extractFiles(reply, code);
        if (!ex) error = `patch rejected: no <<<FILE or <<<DELETE block found in the reply`;
        else {
          patch = buildPatch(worktree, ex.files, ex.deletes);
          if (!patch) error = "patch rejected: every file in the reply is identical to the current file, so there is nothing to change";
        }
      } catch (e) { error = "patch rejected: " + e.message; }
      if (error === null) error = applyPatch(worktree, patch, patchFile, { exact: true }).error;
    }
    patchOut = { patchApplied: error === null, patchError: error };
    if (error) fs.appendFileSync(out.replace(/\.md$/i, "") + ".log", `patch error: ${error}\n`);
  }
  const changedFiles = porcelain(worktree).out.split(/\r?\n/).filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status: outcome.status, out, sessionId: session ? sessionId : undefined,
    usage, totals, needs: parseNeeds(reply, mode === "patch" ? code : undefined), changedFiles, outsideChanged, mode, ...patchOut, isolationSkipped: iso.skipped }, null, 2));
  process.exit(outsideChanged ? 5 : outcome.exitCode !== 0 ? outcome.exitCode : patchOut.patchError ? 9 : 0);
}
