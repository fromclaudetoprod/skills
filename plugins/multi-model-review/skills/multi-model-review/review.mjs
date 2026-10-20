#!/usr/bin/env node
// multi-model-review helper (From Claude to Prod). Prints JSON on stdout.
//
//   node review.mjs detect                     installed reviewer tools and the models each can offer
//   node review.mjs options                    usable models, best first (one entry per model)
//   node review.mjs plan <rounds>              a default pick per round, a different model family each round
//   node review.mjs run --tool <codex|claude|copilot> --model <id> --brief <file> --out <file> [--repo <dir>]
//                                              one review round, read-only, reply written to --out
//   node review.mjs record <tool> <model> <available|unavailable|capped> [note]
//
// Design rules:
// - Reviewers only READ. The brief carries the diff, so no reviewer needs a shell: Copilot and Claude get no
//   shell tool at all, Codex runs in its read-only sandbox. If --repo is given and its working tree changes
//   during a round, the round fails with exit 5.
// - What a tool can do for YOUR account is learned per user, in ~/.claude/multi-model-review/access.json
//   (MMR_ACCESS_FILE overrides). The plugin itself never stores anyone's account state.
// - A round is judged unavailable/capped only when the tool FAILED, and only from its error output, never from
//   the review text (a review about rate limiting must not look like a rate limit).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCESS_FILE = process.env.MMR_ACCESS_FILE || path.join(os.homedir(), ".claude", "multi-model-review", "access.json");
const MODELS_FILE = path.join(HERE, "models.json");
const TOOLS = ["codex", "claude", "cursor", "copilot"];
// The command each tool answers to. Cursor's CLI installs as "cursor-agent" (also "agent"); a fresh install may not
// be on PATH until a new terminal, so fall back to its default Windows install folder.
function binOf(tool) {
  if (tool !== "cursor") return tool;
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "cursor-agent", "cursor-agent.cmd");
  return runTool("cursor-agent", ["--version"]).code === 0 ? "cursor-agent" : (local && fs.existsSync(local) && !UNSAFE_PATH.test(local) ? quote(local) : "cursor-agent");
}
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;
// Characters cmd.exe treats specially. Paths containing them are refused rather than escaped.
const UNSAFE_PATH = /["%^&|<>!`\r\n]/;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
const fail = (message, code = 2) => { console.error(message); process.exit(code); };

function safePath(p, label) {
  const abs = path.resolve(p);
  if (UNSAFE_PATH.test(abs)) fail(`${label} path contains a character that is not allowed here: ${abs}`);
  return abs;
}
const quote = (p) => `"${p}"`;

// npm-installed CLIs are .cmd shims on Windows, which need a shell. Every argument we pass is either a fixed
// flag, a validated model id, or a validated, quoted path, so nothing user-typed reaches the shell raw.
function runTool(cmd, args, { input, cwd, timeout = 60_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", input, cwd, timeout, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", spawnError: r.error ?? null };
}

function versionOf(tool) {
  const r = runTool(binOf(tool), ["--version"]);
  return r.code === 0 ? (r.out || r.err).trim().split(/\r?\n/)[0] : null;
}

function familyOf(id) {
  const m = id.toLowerCase();
  if (/^(gpt|o\d)/.test(m)) return "OpenAI";
  if (m.startsWith("claude")) return "Anthropic";
  if (m.startsWith("grok")) return "xAI";
  if (m.startsWith("gemini")) return "Google";
  if (m.startsWith("kimi")) return "Moonshot";
  if (m.startsWith("glm")) return "Zhipu";
  if (/^(cursor-grok)/.test(m)) return "xAI";
  if (m.startsWith("composer")) return "Cursor";
  return "Other";
}

function cursorCatalog() {
  const r = runTool(binOf("cursor"), ["models"]);
  if (r.code !== 0) return new Set();
  return new Set([...r.out.matchAll(/^([a-z0-9][\w.\-]*) - /gim)].map((m) => m[1]));
}

function detect() {
  const access = readJson(ACCESS_FILE, {});
  const models = readJson(MODELS_FILE, { suggested: {}, notForReview: [] });
  const notForReview = (models.notForReview ?? []).map((p) => new RegExp(p, "i"));
  const tools = {};
  for (const tool of TOOLS) {
    const version = versionOf(tool);
    if (!version) { tools[tool] = { installed: false }; continue; }
    const suggested = models.suggested?.[tool] ?? [];
    const known = Object.keys(access[tool] ?? {}).filter((k) => !k.startsWith("__"));
    // Cursor can list exactly what this account may use ("id - Name" per line); trust that over guesses.
    const catalog = tool === "cursor" ? cursorCatalog() : null;
    const ids = [...new Set([...suggested.map((s) => s.model), ...known])].filter((id) => !catalog || catalog.has(id));
    tools[tool] = {
      installed: true, version,
      capped: access[tool]?.__tool?.status === "capped",
      models: ids.map((id) => {
        const s = suggested.find((x) => x.model === id);
        const blocked = notForReview.find((re) => re.test(id));
        const a = access[tool]?.[id];
        return { id, family: familyOf(id), status: a?.status ?? "untested", checked: a?.date ?? null,
          suggested: Boolean(s) && !blocked, rank: s ? suggested.indexOf(s) + 1 : null,
          why: s?.why ?? (blocked ? `not suggested for review (matches "${blocked.source}")` : null) };
      }),
    };
  }
  return { tools, accessFile: ACCESS_FILE, modelsFile: MODELS_FILE };
}

// One entry per model, on the best tool that has it: your own Codex or Claude subscription before Copilot.
function options() {
  const { tools } = detect();
  const preference = { codex: 0, claude: 1, cursor: 2, copilot: 3 };
  const best = new Map();
  for (const [tool, t] of Object.entries(tools)) {
    if (!t.installed || t.capped) continue;
    for (const m of t.models) {
      if (m.status === "unavailable") continue;
      const cur = best.get(m.id);
      if (!cur || preference[tool] < preference[cur.tool]) best.set(m.id, { tool, ...m });
    }
  }
  const score = (o) => (o.suggested ? 0 : 100) + (o.rank ?? 50) + (o.status === "available" ? 0 : 10);
  return [...best.values()].sort((a, b) => score(a) - score(b));
}

function plan(rounds) {
  const usable = options().filter((o) => o.suggested);
  // The author is Claude, so a non-Anthropic model reads first: the point is a read not anchored on Claude's.
  const ordered = [...usable].sort((a, b) => (a.family === "Anthropic") - (b.family === "Anthropic"));
  const picked = [];
  for (let i = 0; i < rounds; i++) {
    const families = new Set(picked.map((p) => p.family));
    const next = ordered.find((o) => !picked.includes(o) && !families.has(o.family)) ?? ordered.find((o) => !picked.includes(o));
    if (!next) break;
    picked.push(next);
  }
  // Whatever the mix, Claude-family reviewers go last: the outside reads come first.
  picked.sort((a, b) => (a.family === "Anthropic") - (b.family === "Anthropic"));
  return { rounds, plan: picked.map((o, i) => ({ round: i + 1, tool: o.tool, model: o.id, family: o.family, status: o.status, why: o.why })),
    shortBy: Math.max(0, rounds - picked.length), alternatives: options().slice(0, 12) };
}

function record(tool, model, status, note) {
  if (!TOOLS.includes(tool)) fail(`unknown tool ${tool}`);
  if (model !== "__tool" && !MODEL_ID.test(model)) fail(`not a valid model id: ${model}`);
  const access = readJson(ACCESS_FILE, {});
  access[tool] ??= {};
  access[tool][model] = { status, date: new Date().toISOString().slice(0, 10), ...(note ? { note: note.slice(0, 200) } : {}) };
  writeJson(ACCESS_FILE, access);
}

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

function run() {
  const tool = flag("tool"), model = flag("model");
  if (!TOOLS.includes(tool)) fail(`--tool must be one of ${TOOLS.join(", ")}`);
  if (!model || !MODEL_ID.test(model)) fail(`--model is missing or not a valid model id: ${model}`);
  const brief = safePath(flag("brief") ?? fail("--brief is required"), "brief");
  const out = safePath(flag("out") ?? fail("--out is required"), "out");
  const repo = flag("repo") ? safePath(flag("repo"), "repo") : null;
  const workdir = repo ?? path.dirname(brief);
  const treeBefore = repo ? runTool("git", ["-C", quote(repo), "status", "--porcelain"]).out : null;
  const ask = `Read the review brief at ${brief} and do exactly what it asks. You are read-only: do not create, change or delete any file and do not run commands. Your answer is the full review, ending with the VERDICT line the brief asks for.`;

  let r;
  if (tool === "codex") {
    r = runTool("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "-C", quote(workdir), "-m", model, "-o", quote(out), "-"],
      { input: fs.readFileSync(brief, "utf8"), timeout: 900_000 });
  } else if (tool === "claude") {
    r = runTool("claude", ["-p", "--model", model, "--add-dir", quote(path.dirname(brief)), "--output-format", "text",
      "--allowedTools", "Read", "Grep", "Glob",
      "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash", "PowerShell", "WebFetch", "WebSearch"],
      { input: ask, cwd: workdir, timeout: 900_000 });
  } else if (tool === "cursor") {
    // Cursor's print mode can write and run commands by default. Ask mode is its read-only mode, the sandbox stays
    // on, and --force is never passed, so nothing is auto-approved.
    // Cursor's sandbox exists only on macOS and Linux; on Windows, ask mode + no --force + Cursor's own command
    // allowlist + our working-tree check are the guard.
    const sandbox = process.platform === "win32" ? [] : ["--sandbox", "enabled"];
    r = runTool(binOf("cursor"), ["-p", "--mode", "ask", ...sandbox, "--trust", "--output-format", "text",
      "--model", model, "--workspace", quote(workdir), "--add-dir", quote(path.dirname(brief)), quote(ask)],
      { cwd: workdir, timeout: 900_000 });
  } else {
    r = runTool("copilot", ["-p", quote(ask), "--model", model, "--add-dir", quote(path.dirname(brief)),
      "--deny-tool", "write", "--deny-tool", "shell", "--deny-tool", "url", "--no-color", "-s"],
      { cwd: workdir, timeout: 900_000 });
  }

  let status = "available", exitCode = 0, note;
  if (r.code !== 0 || r.spawnError) {
    const errText = `${r.err}\n${r.spawnError?.message ?? ""}`;
    // Only messages about the MODEL count as "unavailable"; a sandbox or network error is not about the model.
    if (/\bmodel\b[^\n]{0,80}\b(not (available|found|supported|enabled)|unavailable|does not exist)|unknown model|invalid model|not available (on|for) your (plan|account)/i.test(errText)) { status = "unavailable"; exitCode = 3; }
    else if (/spend cap|usage limit|quota|rate.?limit|credits? (exhausted|exceeded)/i.test(errText)) { status = "capped"; exitCode = 4; note = errText.match(/.*(cap|limit|quota|credit).*/i)?.[0]?.trim(); }
    else { status = null; exitCode = 2; }
  }
  if (tool !== "codex" && r.out) fs.writeFileSync(out, r.out);
  fs.writeFileSync(out.replace(/\.md$/i, "") + ".log", `exit ${r.code}\n--- stderr ---\n${r.err}\n`);
  if (status) record(tool, model, status, note);
  if (status === "capped") record(tool, "__tool", "capped", note);

  const treeChanged = repo ? runTool("git", ["-C", quote(repo), "status", "--porcelain"]).out !== treeBefore : false;
  const reply = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const verdict = reply.match(/VERDICT:\s*(AGREE|REVISE)/i)?.[1]?.toUpperCase() ?? null;
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status, verdict, out, treeChanged, replyBytes: Buffer.byteLength(reply) }, null, 2));
  process.exit(treeChanged ? 5 : exitCode);
}

const command = process.argv[2];
if (command === "detect") console.log(JSON.stringify(detect(), null, 2));
else if (command === "options") console.log(JSON.stringify(options(), null, 2));
else if (command === "plan") console.log(JSON.stringify(plan(Math.max(1, Number(process.argv[3] ?? 3) || 3)), null, 2));
else if (command === "record") { record(process.argv[3], process.argv[4], process.argv[5], process.argv[6]); console.log('{"ok":true}'); }
else if (command === "run") run();
else fail("usage: node review.mjs detect | options | plan <rounds> | record <tool> <model> <status> [note] | run --tool .. --model .. --brief .. --out .. [--repo ..]", 1);
