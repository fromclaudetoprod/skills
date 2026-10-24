// Write-mode worker run: one model edits files inside its own worktree and nowhere else.
// Zero dependencies. Flags per tool are the plan's starting point and are verified against the installed CLIs in the
// acceptance task; record any flag change in a comment next to the tool.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  TOOLS, SESSION_TOOLS, MODEL_ID, SESSION_ID, UsageError, safePath, quote, runTool, binOf, recordOutcome,
  jsonObjects, sumUsage, parseResult, classifyFailure,
} from "../multi-model-review/core.mjs";

const fail = (message) => { throw new UsageError(message); };
const TIMEOUT = 30 * 60_000;

export const WORKER_ASK = (briefPath) =>
  `Read the task brief at ${briefPath} and do exactly what it asks. Edit files only inside the current folder. Do not commit, push or deploy. Do not run commands; if you need one (install a package, run a generator or formatter), do not run it — end your reply with a line \`NEEDS: <command> because <reason>\`. End your reply with a short summary of what you changed.`;

export const parseNeeds = (text) => (text ?? "").split(/\r?\n/).flatMap((l) => {
  const m = l.match(/^\s*NEEDS:\s*(.+?)\s*$/);
  return m ? [m[1]] : [];
});

// worktree and brief are absolute and already safe. sid is the session id chosen up front (claude, gemini).
export function workerArgs(tool, { model, worktree, brief, out, session, resume, chat, sid, platform = process.platform }) {
  const ask = WORKER_ASK(brief);
  const briefDir = path.dirname(brief);
  const sessionFlags = resume ? ["--resume", resume] : sid ? ["--session-id", sid] : [];
  const cwd = worktree;
  if (tool === "codex") {
    // `codex exec resume` has no -s or -C flag, so the sandbox is set through config on resumed turns and the
    // folder comes from cwd. mcp_servers={} is the plan's starting point for switching MCP off; verify it live
    // in the acceptance task.
    const common = ["--json", "--skip-git-repo-check", "-m", model, "-o", quote(out)];
    const args = resume
      ? ["exec", "resume", ...common, "-c", "sandbox_mode=workspace-write", "-c", "mcp_servers={}", resume, "-"]
      : ["exec", ...common, "-s", "workspace-write", "-C", quote(worktree), "-c", "mcp_servers={}", "-"];
    return { cmd: "codex", args, input: fs.readFileSync(brief, "utf8"), cwd };
  }
  if (tool === "claude") {
    // No --add-dir, so the worker can write only under cwd. Edit and Write are allowed; no shell, no web.
    return { cmd: "claude", cwd, input: fs.readFileSync(brief, "utf8"), args: ["-p", "--model", model, ...sessionFlags,
      "--output-format", "json", "--tools", "Read,Grep,Glob,Edit,Write", "--strict-mcp-config", "--disable-slash-commands",
      "--setting-sources", "project,local", "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Grep", "Glob", "Edit", "Write",
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
const porcelain = (dir) => runTool("git", ["-C", quote(dir), "status", "--porcelain"]);
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
  if (!fs.existsSync(worktree) || runTool("git", ["-C", quote(worktree), "rev-parse", "--is-inside-work-tree"]).out.trim() !== "true") {
    fail(`--worktree is not inside a git worktree: ${worktree}`);
  }
  const resume = session && session !== "new" ? session : null;
  const repoBefore = porcelain(repo).out;
  fs.mkdirSync(path.dirname(out), { recursive: true });

  let sid = null, chat = resume;
  if (tool === "claude") sid = resume ?? (session === "new" ? crypto.randomUUID() : null);
  else if (tool === "gemini") sid = session === "new" ? crypto.randomUUID() : null;
  else if (tool === "cursor" && session === "new") {
    const c = runTool(binOf("cursor"), ["create-chat"]);
    chat = c.out.trim().split(/\r?\n/).pop()?.trim();
    if (c.code !== 0 || !chat || !SESSION_ID.test(chat)) fail(`could not start a Cursor chat: ${c.err || c.out}`.trim());
  }

  const w = workerArgs(tool, { model, worktree, brief, out, session, resume, chat, sid });
  const r = runTool(w.cmd, w.args, { input: w.input, cwd: w.cwd, timeout: TIMEOUT });
  const { text, sessionId, usage } = parseResult(tool, r, { session, resume, sid, chat });
  const outcome = classifyFailure(r, { resume });
  if (tool !== "codex") { const reply = text ?? r.out; if (reply) fs.writeFileSync(out, reply); }
  fs.writeFileSync(out.replace(/\.md$/i, "") + ".log", `exit ${r.code}\n--- stderr ---\n${r.err}\n${text === null && tool !== "codex" ? "" : `--- stdout ---\n${r.out}\n`}`);
  recordOutcome(tool, model, outcome, r);

  const usageFile = path.join(path.dirname(out), "usage.jsonl");
  if (usage) fs.appendFileSync(usageFile, JSON.stringify({ at: new Date().toISOString(), tool, model, sessionId, reply: path.basename(out), ...usage }) + "\n");
  const totals = sumUsage(fs.existsSync(usageFile) ? jsonObjects(fs.readFileSync(usageFile, "utf8")) : []);

  const outsideChanged = porcelain(repo).out !== repoBefore;
  const reply = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const changedFiles = porcelain(worktree).out.split(/\r?\n/).filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status: outcome.status, out, sessionId: session ? sessionId : undefined,
    usage, totals, needs: parseNeeds(reply), changedFiles, outsideChanged }, null, 2));
  process.exit(outsideChanged ? 5 : outcome.exitCode);
}
