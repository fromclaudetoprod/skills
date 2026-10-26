#!/usr/bin/env node
// multi-model-review helper (From Claude to Prod). Prints JSON on stdout.
//
//   node review.mjs detect                     installed reviewer tools and every model each can offer
//   node review.mjs menu [--all]               numbered list of usable models, one row per model (effort levels
//                                              folded into the row), best first. --all also shows small/fast models
//   node review.mjs options [--all]            same as menu (kept for older instructions)
//   node review.mjs plan <rounds>              a default pick per round, a different model family each round
//   node review.mjs run --tool <codex|cursor|gemini|claude|copilot|anthropic> --model <id> --brief <file> --out <file>
//                       [--repo <dir>] [--session new|<id>]
//                                              one review round, read-only, reply written to --out.
//                                              --session new starts a conversation the reviewer keeps; pass the
//                                              printed sessionId back as --session <id> to continue it.
//   node review.mjs batch <manifest.json> [--concurrency N] [--status <file>]
//                                              many reviews in ONE job. The manifest is a JSON array of
//                                              {brief, tool, model, out[, repo]}. Runs N at a time (default 3), retries a
//                                              failed item once, writes one status JSON (default batch-status.json next
//                                              to the manifest, also printed) and exits once: 0 all ok, 7 some failed.
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
// - Every run appends one line to usage.jsonl next to --out (time, tool, model, duration, exit status, tokens where the
//   tool reports them, else null; never brief text, keys or env values) and prints the running total for that folder.
// - batch runs each item as its own `run` child, so an item behaves exactly like a single run; the parent waits on one job.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicEnv, readOnlyArgs, TOOLS, SESSION_TOOLS, MODEL_ID, SESSION_ID, UsageError, safePath, quote, runTool, binOf, detect, menu, plan, record,
  jsonObjects, sumUsage, usageRow, parseResult, classifyFailure, recordOutcome, repoFingerprint } from "./core.mjs";

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
  const startedAt = Date.now();
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
  } else if (tool === "anthropic") {
    // The Messages API through Anthropic's CLI, billed to the user's API key (promotional credit first, if any). The
    // brief goes in as the message, so the reviewer has no tools at all and cannot touch the repo; adaptive thinking
    // at high effort. The key reaches only this child process (see anthropicEnv).
    const body = { model, max_tokens: 32000, thinking: { type: "adaptive" }, output_config: { effort: "high" },
      system: "You are a careful reviewer. You have no tools. Answer with the full review the brief asks for, ending with its VERDICT line.",
      messages: [{ role: "user", content: fs.readFileSync(brief, "utf8") }] };
    r = runTool(binOf("anthropic"), ["messages", "create", "--format", "json"],
      { input: JSON.stringify(body), cwd: workdir, timeout: 900_000, env: anthropicEnv() });
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
  const treeChanged = repo ? repoFingerprint(repo) !== treeBefore : false;
  const finalExit = treeChanged ? 5 : exitCode;
  fs.appendFileSync(usageFile, JSON.stringify(usageRow({ tool, model, sessionId, reply: path.basename(out), durationMs: Date.now() - startedAt,
    exitCode: finalExit, status }, usage)) + "\n");
  const totals = sumUsage(fs.existsSync(usageFile) ? jsonObjects(fs.readFileSync(usageFile, "utf8")) : []);

  const reply = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const verdict = reply.match(/VERDICT:\s*(AGREE|REVISE)/i)?.[1]?.toUpperCase() ?? null;
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status, verdict, out, treeChanged, replyBytes: Buffer.byteLength(reply),
    sessionId: session ? sessionId : undefined, usage, totals }, null, 2));
  process.exit(finalExit);
}

// Many reviews as one job. Each item is its own `run` child; exits 2 (anything else) are retried once. A capped or
// unavailable model (3, 4), a changed tree (5) and a lost session (6) are not: a second go would not change them.
async function batch() {
  const file = safePath(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : fail("batch needs a manifest file"), "manifest");
  const cap = flag("concurrency") === undefined ? 3 : Number(flag("concurrency"));
  if (!Number.isInteger(cap) || cap < 1 || cap > 16) fail("--concurrency must be a whole number from 1 to 16");
  const statusFile = safePath(flag("status") ?? path.join(path.dirname(file), "batch-status.json"), "status");
  let list;
  try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(`could not read the manifest ${file}: ${e.message}`); }
  if (!Array.isArray(list) || !list.length) fail("the manifest must be a non-empty JSON array of {brief, tool, model, out}");
  const seen = new Set();
  const items = list.map((e, i) => {
    const at = `item ${i + 1}`;
    if (!e || typeof e !== "object") fail(`${at} is not an object`);
    if (!TOOLS.includes(e.tool)) fail(`${at}: tool must be one of ${TOOLS.join(", ")}`);
    if (!e.model || !MODEL_ID.test(e.model)) fail(`${at}: model is missing or not a valid model id`);
    const item = { brief: safePath(e.brief ?? fail(`${at}: brief is required`), "brief"), tool: e.tool, model: e.model,
      out: safePath(e.out ?? fail(`${at}: out is required`), "out"), repo: e.repo ? safePath(e.repo, "repo") : null };
    if (seen.has(item.out)) fail(`${at}: another item has the same out file ${item.out}`);
    seen.add(item.out);
    return item;
  });
  const self = fileURLToPath(import.meta.url);
  const once = (it) => new Promise((resolve) => {
    const args = [self, "run", "--tool", it.tool, "--model", it.model, "--brief", it.brief, "--out", it.out, ...(it.repo ? ["--repo", it.repo] : [])];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ code: null, out, err: e.message }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  const results = new Array(items.length);
  const work = async (i) => {
    const it = items[i], started = Date.now();
    let r, attempts = 0;
    do { attempts++; r = await once(it); } while (r.code !== 0 && r.code !== 3 && r.code !== 4 && r.code !== 5 && r.code !== 6 && attempts < 2);
    let json = null; try { json = JSON.parse(r.out); } catch { /* a usage error prints no JSON */ }
    results[i] = { index: i + 1, tool: it.tool, model: it.model, out: it.out, status: r.code === 0 ? "ok" : "failed", exitCode: r.code, verdict: json?.verdict ?? null,
      attempts, durationMs: Date.now() - started,
      error: r.code === 0 ? null : (r.err.trim().split(/\r?\n/).pop() || `exit ${r.code}; see ${it.out.replace(/\.md$/i, "")}.log`).slice(0, 300) };
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, async () => { while (next < items.length) await work(next++); }));
  const failed = results.filter((x) => x.status === "failed").length;
  const summary = { manifest: file, concurrency: cap, ok: results.length - failed, failed, items: results };
  fs.writeFileSync(statusFile, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failed ? 7 : 0);
}


function main() {
  const command = process.argv[2];
  const all = process.argv.includes("--all");
  if (command === "detect") console.log(JSON.stringify(detect(), null, 2));
  else if (command === "menu" || command === "options") console.log(JSON.stringify(menu(all), null, 2));
  else if (command === "plan") console.log(JSON.stringify(plan(Math.max(1, Number(process.argv[3] ?? 3) || 3)), null, 2));
  else if (command === "record") { record(process.argv[3], process.argv[4], process.argv[5], process.argv[6]); console.log('{"ok":true}'); }
  else if (command === "run") run();
  else if (command === "batch") return batch();
  else { console.error("usage: node review.mjs detect | menu [--all] | plan <rounds> | record <tool> <model> <status> [note] | run --tool .. --model .. --brief .. --out .. [--repo ..] [--session new|<id>] | batch <manifest.json> [--concurrency N] [--status <file>]"); process.exit(1); }
}
const usageExit = (e) => { if (e instanceof UsageError) { console.error(e.message); process.exit(2); } throw e; };
// Run the CLI only when this file is executed directly.
try { Promise.resolve(main()).catch(usageExit); } catch (e) { usageExit(e); }
