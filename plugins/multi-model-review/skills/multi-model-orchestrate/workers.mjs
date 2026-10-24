// Write-mode worker run: one model edits files inside its own worktree and nowhere else.
// Zero dependencies. Flags per tool are the plan's starting point and are verified against the installed CLIs in the
// acceptance task; record any flag change in a comment next to the tool.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  TOOLS, SESSION_TOOLS, MODEL_ID, SESSION_ID, UsageError, CODEX_HOME, safePath, quote as quoteFor, runTool, runGit, binOf, recordOutcome,
  jsonObjects, sumUsage, parseResult, classifyFailure, repoFingerprint,
} from "../multi-model-review/core.mjs";

const fail = (message) => { throw new UsageError(message); };
const TIMEOUT = 30 * 60_000;

export const WORKER_ASK = (briefPath) =>
  `Read the task brief at ${briefPath} and do exactly what it asks. Edit files only inside the current folder. Do not commit, push or deploy. Do not run commands; if you need one (install a package, run a generator or formatter), do not run it — end your reply with a line \`NEEDS: <command> because <reason>\`. End your reply with a short summary of what you changed.`;

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
export function codexIsolationArgs(configText) {
  const names = { mcp_servers: new Set(), plugins: new Set() };
  for (const line of String(configText ?? "").split(/\r?\n/)) {
    const m = line.match(HEADER);
    if (!m) continue;
    const name = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    if (SAFE_NAME.test(name)) names[m[1]].add(name);
  }
  const key = (n) => (/^[A-Za-z0-9_-]+$/.test(n) ? n : `"${n}"`);
  return [
    ...[...names.mcp_servers].flatMap((n) => ["-c", `mcp_servers.${key(n)}.enabled=false`]),
    ...[...names.plugins].flatMap((n) => ["-c", `plugins.${key(n)}.enabled=false`]),
    "-c", 'web_search="disabled"',
  ];
}
// A `-c` value holds TOML quotes. Through cmd.exe the C runtime would eat them, so wrap the value and escape them.
export const configArg = (v, platform = process.platform) => (platform === "win32" && v.includes('"') ? `"${v.replace(/"/g, '\\"')}"` : v);
export function readCodexConfig(codexHome = CODEX_HOME) {
  try { return fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"); } catch { return ""; }
}

// worktree and brief are absolute and already safe. sid is the session id chosen up front (claude, gemini).
export function workerArgs(tool, { model, worktree, brief, out, session, resume, chat, sid, isolation = [], platform = process.platform }) {
  const ask = WORKER_ASK(brief);
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
      ? ["exec", "resume", ...common, "-c", "sandbox_mode=workspace-write", ...iso, resume, "-"]
      : ["exec", ...common, "-s", "workspace-write", "-C", quote(worktree), ...iso, "-"];
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
      "--approval-mode", "auto_edit", "--skip-trust", "-o", "json", "--include-directories", quote(briefDir)] };
  }
  if (tool === "cursor") {
    // --force auto-approves everything; Cursor's sandbox exists only on macOS and Linux.
    return { cmd: binOf("cursor"), cwd, args: ["-p", "--force", ...(platform === "win32" ? [] : ["--sandbox", "enabled"]),
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
  const resume = session && session !== "new" ? session : null;
  let repoBefore;
  try { repoBefore = repoFingerprint(repo); } catch (e) { fail(e.message); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true }); // never read a stale reply from an earlier round

  let sid = null, chat = resume;
  if (tool === "claude") sid = resume ?? (session === "new" ? crypto.randomUUID() : null);
  else if (tool === "gemini") sid = session === "new" ? crypto.randomUUID() : null;
  else if (tool === "cursor" && session === "new") {
    const c = runTool(binOf("cursor"), ["create-chat"]);
    chat = c.out.trim().split(/\r?\n/).pop()?.trim();
    if (c.code !== 0 || !chat || !SESSION_ID.test(chat)) fail(`could not start a Cursor chat: ${c.err || c.out}`.trim());
  }

  const isolation = tool === "codex" ? codexIsolationArgs(readCodexConfig()) : [];
  const w = workerArgs(tool, { model, worktree, brief, out, session, resume, chat, sid, isolation });
  const r = runTool(w.cmd, w.args, { input: w.input, cwd: w.cwd, timeout: TIMEOUT });
  const { text, sessionId, usage } = parseResult(tool, r, { session, resume, sid, chat });
  const outcome = classifyFailure(r, { resume });
  if (tool !== "codex") { const reply = text ?? r.out; if (reply) fs.writeFileSync(out, reply); }
  fs.writeFileSync(out.replace(/\.md$/i, "") + ".log", `exit ${r.code}\n--- stderr ---\n${r.err}\n${text === null && tool !== "codex" ? "" : `--- stdout ---\n${r.out}\n`}`);
  recordOutcome(tool, model, outcome, r);

  const usageFile = path.join(path.dirname(out), "usage.jsonl");
  if (usage) fs.appendFileSync(usageFile, JSON.stringify({ at: new Date().toISOString(), tool, model, sessionId, reply: path.basename(out), ...usage }) + "\n");
  const totals = sumUsage(fs.existsSync(usageFile) ? jsonObjects(fs.readFileSync(usageFile, "utf8")) : []);

  const outsideChanged = repoFingerprint(repo) !== repoBefore;
  const reply = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const changedFiles = porcelain(worktree).out.split(/\r?\n/).filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status: outcome.status, out, sessionId: session ? sessionId : undefined,
    usage, totals, needs: parseNeeds(reply), changedFiles, outsideChanged }, null, 2));
  process.exit(outsideChanged ? 5 : outcome.exitCode);
}
