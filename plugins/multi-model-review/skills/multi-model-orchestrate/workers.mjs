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

export const WORKER_ASK = (briefPath) =>
  `Read the task brief at ${briefPath} and do exactly what it asks. Edit files only inside the current folder. Do not commit, push or deploy. Do not run commands; if you need one (install a package, run a generator or formatter), do not run it — end your reply with a line \`NEEDS: <command> because <reason>\`. End your reply with a short summary of what you changed.`;

// Patch mode: the worker runs read-only and answers with its change as one unified diff, which we validate and
// apply with git. Live 2026-10-24: Codex write mode is unsafe on Windows and Cursor can only write with --force.
export const PATCH_TOOLS = ["codex", "cursor", "gemini"];
export const defaultMode = (tool, platform = process.platform) => (platform === "win32" && (tool === "codex" || tool === "cursor") ? "patch" : "write");

export const WORKER_PATCH_ASK = (briefPath) =>
  `Read the task brief at ${briefPath} and do what it asks, but you cannot edit files or run commands. Produce the complete change as ONE unified diff in git format (\`diff --git a/<path> b/<path>\`, paths relative to the current folder, \`--- /dev/null\` for new files) inside a single \`\`\`diff fenced block at the end of your reply. If the folder already contains your earlier change, diff against the current files. If you need a command run, add a line \`NEEDS: <command> because <reason>\` after the block.`;

// The LAST ```diff block of a reply, or null.
export function extractPatch(text) {
  const blocks = [...String(text ?? "").matchAll(/```diff[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)];
  if (!blocks.length) return null;
  const body = blocks[blocks.length - 1][1].replace(/\r\n/g, "\n");
  return body.trim() ? body + "\n" : null;
}

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
    } else if (/^(?:new file|old|new|deleted file) mode 120000/.test(line)) {
      return { ok: false, reason: "symlinks are not allowed in a patch", files: [] };
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
export function applyPatch(worktree, patch, patchFile) {
  const v = validatePatch(patch);
  if (!v.ok) return { applied: false, error: `patch rejected: ${v.reason}` };
  fs.writeFileSync(patchFile, patch);
  const opts = ["--whitespace=nowarn", patchFile];
  const gitErr = (r) => (r.err || r.spawnError?.message || "").trim();
  const check = runGit(worktree, ["apply", "--check", ...opts]);
  if (check.code !== 0) return { applied: false, error: `git apply --check failed: ${gitErr(check)}` };
  const done = runGit(worktree, ["apply", ...opts]);
  if (done.code !== 0) return { applied: false, error: `git apply failed: ${gitErr(done)}` };
  return { applied: true, error: null };
}

export const parseNeeds = (text) => (text ?? "").split(/\r?\n/).flatMap((l) => {
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
  const ask = patch ? WORKER_PATCH_ASK(brief) : WORKER_ASK(brief);
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
    return { cmd: "codex", args, input: fs.readFileSync(brief, "utf8"), cwd };
  }
  if (tool === "claude") {
    // No --add-dir, and Edit and Write are NOT in --allowedTools (an allow rule has no path scope). They stay in
    // --tools so the model has them, and --permission-mode acceptEdits auto-approves edits only inside the working
    // folder; a write outside it is refused. No shell, no web.
    // verify live: Claude worker still writes in cwd and is refused outside it
    return { cmd: "claude", cwd, input: fs.readFileSync(brief, "utf8"), args: ["-p", "--model", model, ...sessionFlags,
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
  const w = workerArgs(tool, { model, worktree, brief, out, session, resume, chat, sid, isolation: iso.args, mode });
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
    if (outcome.exitCode === 0 && !outsideChanged) {
      const patch = extractPatch(reply);
      if (patch === null) error = "no ```diff block found in the reply";
      else error = applyPatch(worktree, patch, patchFile).error;
    }
    patchOut = { patchApplied: outcome.exitCode === 0 && !outsideChanged && error === null, patchError: error };
    if (error) fs.appendFileSync(out.replace(/\.md$/i, "") + ".log", `patch error: ${error}\n`);
  }
  const changedFiles = porcelain(worktree).out.split(/\r?\n/).filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status: outcome.status, out, sessionId: session ? sessionId : undefined,
    usage, totals, needs: parseNeeds(reply), changedFiles, outsideChanged, mode, ...patchOut, isolationSkipped: iso.skipped }, null, 2));
  process.exit(outsideChanged ? 5 : outcome.exitCode !== 0 ? outcome.exitCode : patchOut.patchError ? 9 : 0);
}
