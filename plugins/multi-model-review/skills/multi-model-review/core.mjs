// Shared helpers for multi-model-review (and multi-model-orchestrate, which imports this file).
// No side effects on import: no CLI dispatch, no process exit. CLIs catch UsageError and exit 2 with its message.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const accessFile = () => process.env.MMR_ACCESS_FILE || path.join(os.homedir(), ".claude", "multi-model-review", "access.json");
export const MODELS_FILE = path.join(HERE, "models.json");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const TOOLS = ["codex", "claude", "cursor", "gemini", "copilot", "anthropic"];
export const TOOL_PREFERENCE = { codex: 0, claude: 1, gemini: 2, cursor: 3, copilot: 4, anthropic: 5 };
// Tools whose CLI can carry one conversation across separate runs.
export const SESSION_TOOLS = ["codex", "claude", "cursor", "gemini"];
// The command each tool answers to. Cursor's CLI installs as "cursor-agent" (also "agent"); a fresh install may not
// be on PATH until a new terminal, so fall back to its default Windows install folder.
export function binOf(tool) {
  if (tool === "anthropic") {
    // Anthropic's own CLI ("ant"). A release download is often put in ~/bin, which Git Bash has on PATH but
    // Windows itself may not, so fall back to that file (MMR_ANT_BIN overrides).
    if (process.env.MMR_ANT_BIN && !UNSAFE_PATH.test(process.env.MMR_ANT_BIN)) return quote(process.env.MMR_ANT_BIN);
    if (runTool("ant", ["--version"]).code === 0) return "ant";
    const home = path.join(os.homedir(), "bin", process.platform === "win32" ? "ant.exe" : "ant");
    return fs.existsSync(home) && !UNSAFE_PATH.test(home) ? quote(home) : "ant";
  }
  if (tool !== "cursor") return tool;
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "cursor-agent", "cursor-agent.cmd");
  return runTool("cursor-agent", ["--version"]).code === 0 ? "cursor-agent" : (local && fs.existsSync(local) && !UNSAFE_PATH.test(local) ? quote(local) : "cursor-agent");
}
// The Anthropic API key for the "anthropic" reviewer: read from its own file and handed only to the `ant` child
// process. It is never put in this process's environment, because Claude Code itself would switch from the user's
// plan to that key if ANTHROPIC_API_KEY were set where it runs.
export const anthropicKeyFile = () => process.env.MMR_ANTHROPIC_KEY_FILE || path.join(os.homedir(), ".config", "multi-model-review", "anthropic.key");
export function anthropicEnv() {
  let key = "";
  try { key = fs.readFileSync(anthropicKeyFile(), "utf8").trim(); } catch { /* missing: reported below */ }
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new UsageError(`no Anthropic API key found in ${anthropicKeyFile()} (create a key in the Claude Console and save it there, one line)`);
  const env = { ...process.env, ANTHROPIC_API_KEY: key };
  delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_PROFILE;  // the key must win
  return env;
}
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Characters cmd.exe treats specially. Paths containing them are refused rather than escaped.
export const UNSAFE_PATH = /["%^&|<>!`\r\n]/;

export const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
export const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
export class UsageError extends Error {}
const fail = (message) => { throw new UsageError(message); };

export function safePath(p, label) {
  const abs = path.resolve(p);
  if (UNSAFE_PATH.test(abs)) fail(`${label} path contains a character that is not allowed here: ${abs}`);
  return abs;
}
// Only Windows runs tools through a shell (the .cmd shims), so only there do paths and prompts need quotes. Elsewhere
// the argument goes straight to the program and quote characters would arrive as literal text.
export const quote = (p, platform = process.platform) => (platform === "win32" ? `"${p}"` : String(p));

// npm-installed CLIs are .cmd shims on Windows, which need a shell. Every argument we pass is either a fixed
// flag, a validated model or session id, or a validated, quoted path, so nothing user-typed reaches the shell raw.
export function runTool(cmd, args, { input, cwd, timeout = 60_000, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", input, cwd, timeout, maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env } : {}) });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", spawnError: r.error ?? null };
}

// git without a shell: raw arguments are safe here (no quote()). Only for git, which is a real executable on every OS;
// the other CLIs are .cmd shims and stay on runTool. Returns {code, out, err, spawnError}.
// Read-only flags per tool, shared by review rounds and patch-mode workers. `resume` is for a resumed Codex turn,
// which has no -s flag. Cursor's sandbox exists only on macOS and Linux; ask mode and no --force are the guard.
export function readOnlyArgs(tool, { resume = false, platform = process.platform } = {}) {
  if (tool === "codex") return resume ? ["-c", "sandbox_mode=read-only"] : ["-s", "read-only"];
  if (tool === "gemini") return ["--approval-mode", "plan"];
  if (tool === "cursor") return ["--mode", "ask", ...(platform === "win32" ? [] : ["--sandbox", "enabled"])];
  throw new Error(`no read-only flags for ${tool}`);
}

export function runGit(dir, args, { input, timeout = 120_000 } = {}) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", shell: false, input, timeout, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", spawnError: r.error ?? null };
}

function versionOf(tool) {
  const r = runTool(binOf(tool), ["--version"]);
  return r.code === 0 ? (r.out || r.err).trim().split(/\r?\n/)[0] : null;
}

export function familyOf(id) {
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
export function splitVariant(id) {
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

export function detect() {
  const access = readJson(accessFile(), {});
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
  return { tools, accessFile: accessFile(), modelsFile: MODELS_FILE };
}

const SOURCE = { claude: "Claude CLI", codex: "Codex CLI", cursor: "Cursor CLI", gemini: "Gemini CLI", copilot: "GitHub Copilot CLI", anthropic: "Anthropic API (ant)" };
const PLAN_LABEL = {
  claude: "uses your Claude limits (same budget as this session)",
  codex: "uses your ChatGPT plan",
  cursor: "uses your Cursor plan",
  copilot: "uses Copilot credits",
};
const API_LABEL = "⚠ API costs will apply";
const UNKNOWN_LABEL = "may be billed by API key; check";

// Where a tool's cost lands. Reads only the env and codexHome it is given, so callers can inject both.
export function billingOf(tool, { env = process.env, codexHome = CODEX_HOME } = {}) {
  let paidBy;
  if (tool === "claude") {
    paidBy = env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX ? "api" : "plan";
  } else if (tool === "codex") {
    const auth = readJson(path.join(codexHome, "auth.json"), null);
    if (!auth || typeof auth !== "object") paidBy = "unknown";
    else if (auth.auth_mode === "chatgpt" || (auth.tokens && typeof auth.tokens === "object")) paidBy = "plan";
    else if (auth.auth_mode === "apikey" || auth.OPENAI_API_KEY != null) paidBy = "api";
    else paidBy = "unknown";
  } else if (tool === "gemini" || tool === "anthropic") {
    paidBy = "api";
  } else {
    paidBy = "plan";
  }
  const label = tool === "anthropic" ? `${API_LABEL} (your Anthropic API key; promotional credit first if your org has any)`
    : paidBy === "plan" ? PLAN_LABEL[tool] : paidBy === "api" ? API_LABEL : UNKNOWN_LABEL;
  return { source: SOURCE[tool] ?? tool, paidBy, label,
    sameBudgetAsSession: tool === "claude" && paidBy === "plan", needsConfirm: paidBy !== "plan" };
}

// One numbered row per model per tool. A row's "model" is the id to run; "variants" are the other effort levels.
export function menu(all = false, { env, codexHome } = {}) {
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
    const b = billingOf(g.tool, { env, codexHome });
    const pick = g.variants.find((v) => v.suggested) ?? [...g.variants].sort((a, b) => effortRank(a) - effortRank(b))[0];
    return { tool: g.tool, source: b.source, paidBy: b.paidBy, billing: b.label, sameBudgetAsSession: b.sameBudgetAsSession,
      needsConfirm: b.needsConfirm, family: g.family, model: pick.id, name: pick.name, base: g.base, status: pick.status,
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

export function plan(rounds) {
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

export function record(tool, model, status, note) {
  if (!TOOLS.includes(tool)) fail(`unknown tool ${tool}`);
  if (model !== "__tool" && !MODEL_ID.test(model)) fail(`not a valid model id: ${model}`);
  const access = readJson(accessFile(), {});
  access[tool] ??= {};
  access[tool][model] = { status, date: new Date().toISOString().slice(0, 10), ...(note ? { note: note.slice(0, 200) } : {}) };
  writeJson(accessFile(), access);
}

// Record a finished run's availability. A cap that says to switch models (Cursor's per-model usage limits) blocks only
// this model; any other cap (for example a Codex account spend cap) blocks the whole tool until it is cleared.
export function recordOutcome(tool, model, { status, note }, r) {
  if (!status) return;
  record(tool, model, status, note);
  if (status === "capped" && !/(different|another|other) model/i.test(r.err + r.out)) record(tool, "__tool", "capped", note);
}

// The tools print JSON (one object, an array of events, or JSON lines). Return every object found.
export function jsonObjects(text) {
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : [j]; } catch { /* not one document */ }
  return text.split(/\r?\n/).flatMap((line) => { try { const j = JSON.parse(line); return j && typeof j === "object" ? [j] : []; } catch { return []; } });
}

export function sumUsage(list) {
  const t = { turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, turnsWithoutCost: 0 };
  for (const u of list) {
    t.turns++;
    t.inputTokens += u.inputTokens ?? 0; t.cachedInputTokens += u.cachedInputTokens ?? 0; t.outputTokens += u.outputTokens ?? 0;
    if (typeof u.costUsd === "number") t.costUsd += u.costUsd; else t.turnsWithoutCost++;
  }
  t.costUsd = Math.round(t.costUsd * 10000) / 10000;
  return t;
}

// One usage.jsonl line for a finished run: when, which tool and model, how long, how it ended, and the tokens where the
// tool reported them (null where it did not). Never the brief, the reply, or anything from the environment.
export function usageRow({ tool, model, sessionId, reply, durationMs, exitCode, status }, usage, at = new Date().toISOString()) {
  return { at, tool, model, sessionId, reply, durationMs, exitCode, status,
    ...(usage ?? { inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null }) };
}

// Per-tool reply, session and usage parsing. r is runTool's result. sid is the session id this run chose up front
// (claude, gemini); chat is the Cursor chat id; resume is the id being continued. Moved as is from run().
export function parseResult(tool, r, { session, resume, sid, chat } = {}) {
  let text = null, sessionId = resume ?? null, usage = null;
  const out = r.out ?? "";
  if (tool === "codex") {
    for (const e of jsonObjects(out)) {
      if (e.type === "thread.started" && e.thread_id) sessionId = e.thread_id;
      if (e.type === "turn.completed" && e.usage) usage = { inputTokens: e.usage.input_tokens, cachedInputTokens: e.usage.cached_input_tokens, outputTokens: e.usage.output_tokens, costUsd: null };
    }
    // Without --json events Codex only prints a "tokens used" total.
    const total = usage ? null : `${out}\n${r.err ?? ""}`.match(/tokens used\D{0,20}([\d,]+)/i)?.[1];
    if (total) usage = { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: Number(total.replace(/,/g, "")), costUsd: null };
  } else if (tool === "claude") {
    const res = jsonObjects(out).filter((e) => e.type === "result").pop();
    if (res) {
      text = res.result ?? ""; sessionId = res.session_id ?? sid;
      const u = res.usage ?? {};
      usage = { inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        cachedInputTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, costUsd: res.total_cost_usd ?? null };
    }
  } else if (tool === "gemini") {
    const res = jsonObjects(out).find((e) => "response" in e);
    if (res) {
      text = res.response ?? ""; sessionId = res.session_id ?? res.sessionId ?? sid ?? resume ?? null;
      const t = { prompt: 0, cached: 0, candidates: 0, thoughts: 0 };
      for (const m of Object.values(res.stats?.models ?? {})) for (const k of Object.keys(t)) t[k] += m.tokens?.[k] ?? 0;
      usage = { inputTokens: t.prompt, cachedInputTokens: t.cached, outputTokens: t.candidates + t.thoughts, costUsd: null };
    }
  } else if (tool === "anthropic") {
    // A Messages API response from `ant messages create --format json`.
    const res = jsonObjects(out).filter((e) => e.type === "message").pop();
    if (res) {
      text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (res.stop_reason === "refusal") text = `(the model declined this request: ${res.stop_details?.category ?? "no category"})\n` + text;
      if (res.stop_reason === "max_tokens") text += "\n\n(reply cut off at the output limit)";
      const u = res.usage ?? {};
      usage = { inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        cachedInputTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, costUsd: null };
    }
  } else if (tool === "cursor") {
    const res = jsonObjects(out).filter((e) => e.type === "result" || "result" in e).pop();
    if (res) {
      text = res.result ?? ""; sessionId = res.session_id ?? res.chatId ?? chat;
      const u = res.usage ?? {};
      if (Object.keys(u).length) usage = { inputTokens: (u.inputTokens ?? u.input_tokens ?? 0) + (u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0) + (u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? 0),
        cachedInputTokens: u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0, outputTokens: u.outputTokens ?? u.output_tokens ?? 0, costUsd: null };
    } else sessionId = chat;
  } else {
    text = out;
  }
  return { text, sessionId, usage };
}

// Judge a finished tool run from its error output only. Success is {status:"available", exitCode:0}.
export function classifyFailure(r, { resume } = {}) {
  let status = "available", exitCode = 0, note;
  if (r.code !== 0 || r.spawnError) {
    // On failure stdout carries the tool's error (JSON output modes put it there), not a review.
    const errText = `${r.err ?? ""}\n${r.spawnError?.message ?? ""}\n${r.out ?? ""}`;
    if (resume && /(session|chat|thread|conversation)[^\n]{0,60}(not found|no such|does not exist|invalid|unknown)|no (saved )?(session|chat|conversation|thread)s? (found|with)/i.test(errText)) { status = null; exitCode = 6; }
    // Only messages about the MODEL count as "unavailable"; a sandbox or network error is not about the model.
    else if (/\bmodel\b[^\n]{0,80}\b(not (available|found|supported|enabled)|unavailable|does not exist)|unknown model|invalid model|not available (on|for) your (plan|account)/i.test(errText)) { status = "unavailable"; exitCode = 3; }
    else if (/spend cap|usage limit|quota|rate.?limit|credits? (exhausted|exceeded)|credit balance is too low/i.test(errText)) { status = "capped"; exitCode = 4; note = errText.match(/.*(cap|limit|quota|credit).*/i)?.[0]?.trim(); }
    else { status = null; exitCode = 2; }
  }
  return { status, exitCode, note };
}

// A fingerprint of everything in a git repo's working tree that a stray write could change: the porcelain status, the
// full diff against HEAD (so a further edit to an already-modified file shows), and a hash of every untracked file.
// Compare the value before and after a run. Throws if the folder is not a git repo or git fails.
export function repoFingerprint(repo) {
  const git = (...a) => {
    const r = runGit(repo, a);
    if (r.code !== 0 || r.spawnError) throw new Error(`git ${a[0]} failed in ${repo}: ${(r.err || r.spawnError?.message || "").trim()}`);
    return r.out;
  };
  if (git("rev-parse", "--is-inside-work-tree").trim() !== "true") throw new Error(`not a git work tree: ${repo}`);
  const h = crypto.createHash("sha256");
  h.update(git("status", "--porcelain"));
  const hasHead = runGit(repo, ["rev-parse", "--verify", "-q", "HEAD"]).code === 0;
  h.update(hasHead ? git("diff", "HEAD", "--binary", "--no-ext-diff") : git("diff", "--cached", "--binary", "--no-ext-diff"));
  for (const f of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
    const abs = path.join(repo, f);
    h.update(f + "\0");
    try { h.update(fs.readFileSync(abs)); } catch { h.update("unreadable"); }
  }
  return h.digest("hex");
}
