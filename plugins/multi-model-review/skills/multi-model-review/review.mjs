#!/usr/bin/env node
// multi-model-review helper (From Claude to Prod). Prints JSON on stdout.
//
//   node review.mjs detect                     installed reviewer tools and every model each can offer
//   node review.mjs menu [--all]               numbered list of usable models, one row per model (effort levels
//                                              folded into the row), best first. --all also shows small/fast models
//   node review.mjs options [--all]            same as menu (kept for older instructions)
//   node review.mjs plan <rounds>              a default pick per round, a different model family each round
//   node review.mjs run --tool <codex|cursor|gemini|claude|copilot> --model <id> --brief <file> --out <file>
//                       [--repo <dir>] [--session new|<id>]
//                                              one review round, read-only, reply written to --out.
//                                              --session new starts a conversation the reviewer keeps; pass the
//                                              printed sessionId back as --session <id> to continue it.
//   node review.mjs record <tool> <model> <available|unavailable|capped> [note]
//
// Design rules:
// - Reviewers only READ. The brief carries the diff, so no reviewer needs a shell: Copilot and Claude get no
//   shell tool at all, Codex runs in its read-only sandbox. The read-only flags are passed again on every resumed
//   turn. If --repo is given and its working tree changes during a round, the round fails with exit 5.
// - What a tool can do for YOUR account is learned per user, in ~/.claude/multi-model-review/access.json
//   (MMR_ACCESS_FILE overrides). The plugin itself never stores anyone's account state.
// - A round is judged unavailable/capped only when the tool FAILED, and only from its error output, never from
//   the review text (a review about rate limiting must not look like a rate limit).
// - Token use is appended to usage.jsonl next to --out, and every run prints the running total for that folder.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readOnlyArgs, TOOLS, SESSION_TOOLS, MODEL_ID, SESSION_ID, UsageError, safePath, quote, runTool, binOf, detect, menu, plan, record,
  jsonObjects, sumUsage, parseResult, classifyFailure, recordOutcome, repoFingerprint } from "./core.mjs";

const fail = (message) => { throw new UsageError(message); };

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

function run() {
  const tool = flag("tool"), model = flag("model"), session = flag("session");
  if (!TOOLS.includes(tool)) fail(`--tool must be one of ${TOOLS.join(", ")}`);
  if (!model || !MODEL_ID.test(model)) fail(`--model is missing or not a valid model id: ${model}`);
  if (session !== undefined && session !== "new" && !SESSION_ID.test(session)) fail(`--session must be "new" or a session id: ${session}`);
  if (session && !SESSION_TOOLS.includes(tool)) fail(`--session (dialogue mode) is not supported for ${tool}; use one of ${SESSION_TOOLS.join(", ")}`);
  const brief = safePath(flag("brief") ?? fail("--brief is required"), "brief");
  const out = safePath(flag("out") ?? fail("--out is required"), "out");
  const repo = flag("repo") ? safePath(flag("repo"), "repo") : null;
  const workdir = repo ?? path.dirname(brief);
  const resume = session && session !== "new" ? session : null;
  // The fingerprint (status, full diff, untracked file contents) catches a further edit to a file that was already
  // modified, which a worktree at the review gate always has.
  let treeBefore = null;
  if (repo) { try { treeBefore = repoFingerprint(repo); } catch (e) { fail(e.message); } }
  const ask = `Read the review brief at ${brief} and do exactly what it asks. You are read-only: do not create, change or delete any file and do not run commands. Your answer is the full review, ending with the VERDICT line the brief asks for.`;

  let r, sid = null, chat = resume;
  if (tool === "codex") {
    // `codex exec resume` has no -s flag, so the read-only sandbox is set through config on resumed turns.
    const common = ["--json", "--skip-git-repo-check", "-m", model, "-o", quote(out)];
    const args = resume
      ? ["exec", "resume", ...common, ...readOnlyArgs("codex", { resume: true }), resume, "-"]
      : ["exec", ...common, ...readOnlyArgs("codex"), "-C", quote(workdir), "-"];
    r = runTool("codex", args, { input: fs.readFileSync(brief, "utf8"), cwd: workdir, timeout: 900_000 });
  } else if (tool === "claude") {
    // Only the three read tools exist for the reviewer (--tools), and no MCP servers, skills or user settings are
    // loaded. Besides keeping it read-only, this cuts a turn from ~120k input tokens (the user's whole Claude Code
    // setup) to ~12k. Project CLAUDE.md still loads, which helps code reviews.
    sid = resume ?? (session === "new" ? crypto.randomUUID() : null);
    r = runTool("claude", ["-p", "--model", model, ...(resume ? ["--resume", resume] : sid ? ["--session-id", sid] : []),
      "--add-dir", quote(path.dirname(brief)), "--output-format", "json",
      "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "project,local",
      "--allowedTools", "Read", "Grep", "Glob",
      "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash", "PowerShell", "WebFetch", "WebSearch"],
      { input: ask, cwd: workdir, timeout: 900_000 });
  } else if (tool === "gemini") {
    // Gemini CLI: plan mode is its read-only mode; --skip-trust lets it run headless. Signing in with a personal
    // Google account no longer works for scripted use, so it needs GEMINI_API_KEY (environment or ~/.gemini/.env).
    // Its sessions are kept per project folder, so every turn of one conversation runs from the same workdir.
    sid = session === "new" ? crypto.randomUUID() : null;
    r = runTool("gemini", ["-p", quote(ask), "-m", model, ...(resume ? ["--resume", resume] : sid ? ["--session-id", sid] : []),
      ...readOnlyArgs("gemini"), "--skip-trust", "-o", "json", "--include-directories", quote(path.dirname(brief))],
      { cwd: workdir, timeout: 900_000 });
  } else if (tool === "cursor") {
    // Cursor's print mode can write and run commands by default. Ask mode is its read-only mode, the sandbox stays
    // on, and --force is never passed, so nothing is auto-approved. These flags go on every turn, resumed or not.
    // Cursor's sandbox exists only on macOS and Linux; on Windows, ask mode + no --force + Cursor's own command
    // allowlist + our working-tree check are the guard.
    if (session === "new") {
      const c = runTool(binOf("cursor"), ["create-chat"]);
      chat = c.out.trim().split(/\r?\n/).pop()?.trim();
      if (c.code !== 0 || !chat || !SESSION_ID.test(chat)) fail(`could not start a Cursor chat: ${c.err || c.out}`.trim());
    }
    r = runTool(binOf("cursor"), ["-p", ...readOnlyArgs("cursor"), "--trust", "--output-format", "json",
      "--model", model, ...(chat ? ["--resume", chat] : []),
      "--workspace", quote(workdir), "--add-dir", quote(path.dirname(brief)), quote(ask)],
      { cwd: workdir, timeout: 900_000 });
  } else {
    r = runTool("copilot", ["-p", quote(ask), "--model", model, "--add-dir", quote(path.dirname(brief)),
      "--deny-tool", "write", "--deny-tool", "shell", "--deny-tool", "url", "--no-color", "-s"],
      { cwd: workdir, timeout: 900_000 });
  }

  const { text, sessionId, usage } = parseResult(tool, r, { session, resume, sid, chat });
  const { status, exitCode, note } = classifyFailure(r, { resume });
  // JSON output that could not be parsed is still the reply: keep it rather than lose the review.
  if (tool !== "codex") { const reply = text ?? r.out; if (reply) fs.writeFileSync(out, reply); }
  fs.writeFileSync(out.replace(/\.md$/i, "") + ".log", `exit ${r.code}\n--- stderr ---\n${r.err}\n${text === null && tool !== "codex" ? "" : `--- stdout ---\n${r.out}\n`}`);
  recordOutcome(tool, model, { status, note }, r);

  const usageFile = path.join(path.dirname(out), "usage.jsonl");
  if (usage) fs.appendFileSync(usageFile, JSON.stringify({ at: new Date().toISOString(), tool, model, sessionId, reply: path.basename(out), ...usage }) + "\n");
  const totals = sumUsage(fs.existsSync(usageFile) ? jsonObjects(fs.readFileSync(usageFile, "utf8")) : []);

  const treeChanged = repo ? repoFingerprint(repo) !== treeBefore : false;
  const reply = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const verdict = reply.match(/VERDICT:\s*(AGREE|REVISE)/i)?.[1]?.toUpperCase() ?? null;
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status, verdict, out, treeChanged, replyBytes: Buffer.byteLength(reply),
    sessionId: session ? sessionId : undefined, usage, totals }, null, 2));
  process.exit(treeChanged ? 5 : exitCode);
}


function main() {
  const command = process.argv[2];
  const all = process.argv.includes("--all");
  if (command === "detect") console.log(JSON.stringify(detect(), null, 2));
  else if (command === "menu" || command === "options") console.log(JSON.stringify(menu(all), null, 2));
  else if (command === "plan") console.log(JSON.stringify(plan(Math.max(1, Number(process.argv[3] ?? 3) || 3)), null, 2));
  else if (command === "record") { record(process.argv[3], process.argv[4], process.argv[5], process.argv[6]); console.log('{"ok":true}'); }
  else if (command === "run") run();
  else { console.error("usage: node review.mjs detect | menu [--all] | plan <rounds> | record <tool> <model> <status> [note] | run --tool .. --model .. --brief .. --out .. [--repo ..] [--session new|<id>]"); process.exit(1); }
}
// Run the CLI only when this file is executed directly.
try { main(); } catch (e) { if (e instanceof UsageError) { console.error(e.message); process.exit(2); } throw e; }
