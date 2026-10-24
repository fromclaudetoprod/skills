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

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCESS_FILE = process.env.MMR_ACCESS_FILE || path.join(os.homedir(), ".claude", "multi-model-review", "access.json");
const MODELS_FILE = path.join(HERE, "models.json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const TOOLS = ["codex", "claude", "cursor", "gemini", "copilot"];
const TOOL_PREFERENCE = { codex: 0, claude: 1, gemini: 2, cursor: 3, copilot: 4 };
// Tools whose CLI can carry one conversation across separate runs.
const SESSION_TOOLS = ["codex", "claude", "cursor", "gemini"];
// The command each tool answers to. Cursor's CLI installs as "cursor-agent" (also "agent"); a fresh install may not
// be on PATH until a new terminal, so fall back to its default Windows install folder.
function binOf(tool) {
  if (tool !== "cursor") return tool;
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "cursor-agent", "cursor-agent.cmd");
  return runTool("cursor-agent", ["--version"]).code === 0 ? "cursor-agent" : (local && fs.existsSync(local) && !UNSAFE_PATH.test(local) ? quote(local) : "cursor-agent");
}
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
// flag, a validated model or session id, or a validated, quoted path, so nothing user-typed reaches the shell raw.
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
  if (/^(gpt|o\d|codex)/.test(m)) return "OpenAI";
  if (m.startsWith("claude")) return "Anthropic";
  if (/^(cursor-)?grok/.test(m)) return "xAI";
  if (m.startsWith("gemini")) return "Google";
  if (m.startsWith("kimi")) return "Moonshot";
  if (m.startsWith("glm")) return "Zhipu";
  if (m.startsWith("muse")) return "Meta";
  if (m.startsWith("composer")) return "Cursor";
  return "Other";
}

// "grok-4.7-high-fast" -> base "grok-4.7", effort "high", fast. Cursor lists every effort level of a model as its
// own id; the menu folds them into one row and picks a sensible default, and any exact id can still be typed.
const EFFORT_ORDER = ["high", "xhigh", "extra-high", "medium", "max", null, "none", "low", "minimal"];
function splitVariant(id) {
  const fast = /-fast$/i.test(id);
  let base = id.replace(/-fast$/i, "");
  let thinking = false;
  base = base.replace(/-thinking(?=-|$)/i, () => { thinking = true; return ""; });
  const m = base.match(/-(none|minimal|low|medium|high|xhigh|extra-high|max)$/i);
  if (m) base = base.slice(0, -m[0].length);
  return { base, effort: m ? m[1].toLowerCase() : null, thinking, fast };
}

// Cursor lists exactly what this account may use, as "id - Name" per line.
function cursorCatalog() {
  const r = runTool(binOf("cursor"), ["models"]);
  if (r.code !== 0) return null;
  const map = new Map();
  for (const m of r.out.matchAll(/^([a-z0-9][\w.\-]*) - (.+)$/gim)) {
    if (m[1] !== "auto") map.set(m[1], m[2].replace(/[​\s]+/g, " ").trim());
  }
  return map.size ? map : null;
}

// Codex keeps the model list it last fetched for this account in ~/.codex/models_cache.json.
function codexCatalog() {
  const j = readJson(path.join(CODEX_HOME, "models_cache.json"), null);
  const list = (j?.models ?? []).filter((m) => m.slug && m.visibility !== "hide");
  return list.length ? new Map(list.map((m) => [m.slug, m.display_name ?? m.slug])) : null;
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
    const catalog = tool === "cursor" ? cursorCatalog() : tool === "codex" ? codexCatalog() : null;
    // With a catalog, offer everything in it (plus models already proven to work); without one, the suggestions
    // and whatever this account has used before.
    const ids = catalog
      ? [...new Set([...catalog.keys(), ...known.filter((k) => access[tool][k]?.status === "available")])]
      : [...new Set([...suggested.map((s) => s.model), ...known])];
    tools[tool] = {
      installed: true, version, catalog: Boolean(catalog),
      capped: access[tool]?.__tool?.status === "capped",
      models: ids.map((id) => {
        const s = suggested.find((x) => x.model === id);
        const blocked = notForReview.find((re) => re.test(id));
        const a = access[tool]?.[id];
        return { id, name: catalog?.get(id) ?? null, family: familyOf(id), ...splitVariant(id),
          status: a?.status ?? "untested", checked: a?.date ?? null,
          suggested: Boolean(s) && !blocked, rank: s ? suggested.indexOf(s) + 1 : null, blocked: Boolean(blocked),
          why: s?.why ?? (blocked ? `not suggested for review (matches "${blocked.source}")` : null) };
      }),
    };
  }
  return { tools, accessFile: ACCESS_FILE, modelsFile: MODELS_FILE };
}

// One numbered row per model per tool. A row's "model" is the id to run; "variants" are the other effort levels.
function menu(all = false) {
  const { tools } = detect();
  const groups = new Map();
  for (const [tool, t] of Object.entries(tools)) {
    if (!t.installed || t.capped) continue;
    for (const m of t.models) {
      if (m.blocked && !all) continue;
      if (m.status === "unavailable" || m.status === "capped") continue;  // capped: until `record ... available`
      const key = `${tool}:${m.base}`;
      if (!groups.has(key)) groups.set(key, { tool, base: m.base, family: m.family, variants: [] });
      groups.get(key).variants.push(m);
    }
  }
  const effortRank = (v) => EFFORT_ORDER.indexOf(v.effort) * 2 + (v.thinking ? 0 : 1) + (v.fast ? 20 : 0);
  const rows = [...groups.values()].map((g) => {
    const pick = g.variants.find((v) => v.suggested) ?? [...g.variants].sort((a, b) => effortRank(a) - effortRank(b))[0];
    return { tool: g.tool, family: g.family, model: pick.id, name: pick.name, base: g.base, status: pick.status,
      suggested: pick.suggested, rank: pick.rank, why: pick.why, variants: g.variants.map((v) => v.id).filter((id) => id !== pick.id) };
  });
  rows.sort((a, b) =>
    (b.suggested - a.suggested)
    || (a.suggested && b.suggested ? (a.rank - b.rank) || (TOOL_PREFERENCE[a.tool] - TOOL_PREFERENCE[b.tool]) : 0)
    || ((b.status === "available") - (a.status === "available"))
    || a.family.localeCompare(b.family)
    || b.base.localeCompare(a.base, undefined, { numeric: true })
    || (TOOL_PREFERENCE[a.tool] - TOOL_PREFERENCE[b.tool]));
  return rows.map((r, i) => ({ n: i + 1, ...r }));
}

function plan(rounds) {
  const all = menu();
  const usable = all.filter((o) => o.suggested);
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
  return { rounds, plan: picked.map((o, i) => ({ round: i + 1, n: o.n, tool: o.tool, model: o.model, family: o.family, status: o.status, why: o.why })),
    shortBy: Math.max(0, rounds - picked.length), menuSize: all.length };
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

// The tools print JSON (one object, an array of events, or JSON lines). Return every object found.
function jsonObjects(text) {
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : [j]; } catch { /* not one document */ }
  return text.split(/\r?\n/).flatMap((line) => { try { const j = JSON.parse(line); return j && typeof j === "object" ? [j] : []; } catch { return []; } });
}

function sumUsage(list) {
  const t = { turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, turnsWithoutCost: 0 };
  for (const u of list) {
    t.turns++;
    t.inputTokens += u.inputTokens ?? 0; t.cachedInputTokens += u.cachedInputTokens ?? 0; t.outputTokens += u.outputTokens ?? 0;
    if (typeof u.costUsd === "number") t.costUsd += u.costUsd; else t.turnsWithoutCost++;
  }
  t.costUsd = Math.round(t.costUsd * 10000) / 10000;
  return t;
}

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
  const treeBefore = repo ? runTool("git", ["-C", quote(repo), "status", "--porcelain"]).out : null;
  const ask = `Read the review brief at ${brief} and do exactly what it asks. You are read-only: do not create, change or delete any file and do not run commands. Your answer is the full review, ending with the VERDICT line the brief asks for.`;

  let r, text = null, sessionId = resume, usage = null;
  if (tool === "codex") {
    // `codex exec resume` has no -s flag, so the read-only sandbox is set through config on resumed turns.
    const common = ["--json", "--skip-git-repo-check", "-m", model, "-o", quote(out)];
    const args = resume
      ? ["exec", "resume", ...common, "-c", "sandbox_mode=read-only", resume, "-"]
      : ["exec", ...common, "-s", "read-only", "-C", quote(workdir), "-"];
    r = runTool("codex", args, { input: fs.readFileSync(brief, "utf8"), cwd: workdir, timeout: 900_000 });
    for (const e of jsonObjects(r.out)) {
      if (e.type === "thread.started" && e.thread_id) sessionId = e.thread_id;
      if (e.type === "turn.completed" && e.usage) usage = { inputTokens: e.usage.input_tokens, cachedInputTokens: e.usage.cached_input_tokens, outputTokens: e.usage.output_tokens, costUsd: null };
    }
  } else if (tool === "claude") {
    // Only the three read tools exist for the reviewer (--tools), and no MCP servers, skills or user settings are
    // loaded. Besides keeping it read-only, this cuts a turn from ~120k input tokens (the user's whole Claude Code
    // setup) to ~12k. Project CLAUDE.md still loads, which helps code reviews.
    const sid = resume ?? (session === "new" ? crypto.randomUUID() : null);
    r = runTool("claude", ["-p", "--model", model, ...(resume ? ["--resume", resume] : sid ? ["--session-id", sid] : []),
      "--add-dir", quote(path.dirname(brief)), "--output-format", "json",
      "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "project,local",
      "--allowedTools", "Read", "Grep", "Glob",
      "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash", "PowerShell", "WebFetch", "WebSearch"],
      { input: ask, cwd: workdir, timeout: 900_000 });
    const res = jsonObjects(r.out).filter((e) => e.type === "result").pop();
    if (res) {
      text = res.result ?? ""; sessionId = res.session_id ?? sid;
      const u = res.usage ?? {};
      usage = { inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        cachedInputTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, costUsd: res.total_cost_usd ?? null };
    }
  } else if (tool === "gemini") {
    // Gemini CLI: plan mode is its read-only mode; --skip-trust lets it run headless. Signing in with a personal
    // Google account no longer works for scripted use, so it needs GEMINI_API_KEY (environment or ~/.gemini/.env).
    // Its sessions are kept per project folder, so every turn of one conversation runs from the same workdir.
    const sid = session === "new" ? crypto.randomUUID() : null;
    r = runTool("gemini", ["-p", quote(ask), "-m", model, ...(resume ? ["--resume", resume] : sid ? ["--session-id", sid] : []),
      "--approval-mode", "plan", "--skip-trust", "-o", "json", "--include-directories", quote(path.dirname(brief))],
      { cwd: workdir, timeout: 900_000 });
    const res = jsonObjects(r.out).find((e) => "response" in e);
    if (res) {
      text = res.response ?? ""; sessionId = res.session_id ?? res.sessionId ?? sid ?? resume;
      const t = { prompt: 0, cached: 0, candidates: 0, thoughts: 0 };
      for (const m of Object.values(res.stats?.models ?? {})) for (const k of Object.keys(t)) t[k] += m.tokens?.[k] ?? 0;
      usage = { inputTokens: t.prompt, cachedInputTokens: t.cached, outputTokens: t.candidates + t.thoughts, costUsd: null };
    }
  } else if (tool === "cursor") {
    // Cursor's print mode can write and run commands by default. Ask mode is its read-only mode, the sandbox stays
    // on, and --force is never passed, so nothing is auto-approved. These flags go on every turn, resumed or not.
    // Cursor's sandbox exists only on macOS and Linux; on Windows, ask mode + no --force + Cursor's own command
    // allowlist + our working-tree check are the guard.
    let chat = resume;
    if (session === "new") {
      const c = runTool(binOf("cursor"), ["create-chat"]);
      chat = c.out.trim().split(/\r?\n/).pop()?.trim();
      if (c.code !== 0 || !chat || !SESSION_ID.test(chat)) fail(`could not start a Cursor chat: ${c.err || c.out}`.trim());
    }
    const sandbox = process.platform === "win32" ? [] : ["--sandbox", "enabled"];
    r = runTool(binOf("cursor"), ["-p", "--mode", "ask", ...sandbox, "--trust", "--output-format", "json",
      "--model", model, ...(chat ? ["--resume", chat] : []),
      "--workspace", quote(workdir), "--add-dir", quote(path.dirname(brief)), quote(ask)],
      { cwd: workdir, timeout: 900_000 });
    const res = jsonObjects(r.out).filter((e) => e.type === "result" || "result" in e).pop();
    if (res) {
      text = res.result ?? ""; sessionId = res.session_id ?? res.chatId ?? chat;
      const u = res.usage ?? {};
      if (Object.keys(u).length) usage = { inputTokens: (u.inputTokens ?? u.input_tokens ?? 0) + (u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0) + (u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? 0),
        cachedInputTokens: u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0, outputTokens: u.outputTokens ?? u.output_tokens ?? 0, costUsd: null };
    } else sessionId = chat;
  } else {
    r = runTool("copilot", ["-p", quote(ask), "--model", model, "--add-dir", quote(path.dirname(brief)),
      "--deny-tool", "write", "--deny-tool", "shell", "--deny-tool", "url", "--no-color", "-s"],
      { cwd: workdir, timeout: 900_000 });
    text = r.out;
  }

  let status = "available", exitCode = 0, note;
  if (r.code !== 0 || r.spawnError) {
    // On failure stdout carries the tool's error (JSON output modes put it there), not a review.
    const errText = `${r.err}\n${r.spawnError?.message ?? ""}\n${r.out}`;
    if (resume && /(session|chat|thread|conversation)[^\n]{0,60}(not found|no such|does not exist|invalid|unknown)|no (saved )?(session|chat|conversation|thread)s? (found|with)/i.test(errText)) { status = null; exitCode = 6; }
    // Only messages about the MODEL count as "unavailable"; a sandbox or network error is not about the model.
    else if (/\bmodel\b[^\n]{0,80}\b(not (available|found|supported|enabled)|unavailable|does not exist)|unknown model|invalid model|not available (on|for) your (plan|account)/i.test(errText)) { status = "unavailable"; exitCode = 3; }
    else if (/spend cap|usage limit|quota|rate.?limit|credits? (exhausted|exceeded)/i.test(errText)) { status = "capped"; exitCode = 4; note = errText.match(/.*(cap|limit|quota|credit).*/i)?.[0]?.trim(); }
    else { status = null; exitCode = 2; }
  }
  // JSON output that could not be parsed is still the reply: keep it rather than lose the review.
  if (tool !== "codex") { const reply = text ?? r.out; if (reply) fs.writeFileSync(out, reply); }
  fs.writeFileSync(out.replace(/\.md$/i, "") + ".log", `exit ${r.code}\n--- stderr ---\n${r.err}\n${text === null && tool !== "codex" ? "" : `--- stdout ---\n${r.out}\n`}`);
  if (status) record(tool, model, status, note);
  // A cap that says to switch models (Cursor's per-model usage limits) blocks only this model; any other cap
  // (for example a Codex account spend cap) blocks the whole tool until it is cleared.
  if (status === "capped" && !/(different|another|other) model/i.test(r.err + r.out)) record(tool, "__tool", "capped", note);

  const usageFile = path.join(path.dirname(out), "usage.jsonl");
  if (usage) fs.appendFileSync(usageFile, JSON.stringify({ at: new Date().toISOString(), tool, model, sessionId, reply: path.basename(out), ...usage }) + "\n");
  const totals = sumUsage(fs.existsSync(usageFile) ? jsonObjects(fs.readFileSync(usageFile, "utf8")) : []);

  const treeChanged = repo ? runTool("git", ["-C", quote(repo), "status", "--porcelain"]).out !== treeBefore : false;
  const reply = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const verdict = reply.match(/VERDICT:\s*(AGREE|REVISE)/i)?.[1]?.toUpperCase() ?? null;
  console.log(JSON.stringify({ tool, model, exitCode: r.code, status, verdict, out, treeChanged, replyBytes: Buffer.byteLength(reply),
    sessionId: session ? sessionId : undefined, usage, totals }, null, 2));
  process.exit(treeChanged ? 5 : exitCode);
}

const command = process.argv[2];
const all = process.argv.includes("--all");
if (command === "detect") console.log(JSON.stringify(detect(), null, 2));
else if (command === "menu" || command === "options") console.log(JSON.stringify(menu(all), null, 2));
else if (command === "plan") console.log(JSON.stringify(plan(Math.max(1, Number(process.argv[3] ?? 3) || 3)), null, 2));
else if (command === "record") { record(process.argv[3], process.argv[4], process.argv[5], process.argv[6]); console.log('{"ok":true}'); }
else if (command === "run") run();
else fail("usage: node review.mjs detect | menu [--all] | plan <rounds> | record <tool> <model> <status> [note] | run --tool .. --model .. --brief .. --out .. [--repo ..] [--session new|<id>]", 1);
