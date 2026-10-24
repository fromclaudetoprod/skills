#!/usr/bin/env node
// Multi-model orchestrate: Claude plans and reviews, other models do the work in isolated worktrees.
// Zero dependencies. Commands are added to COMMANDS below.
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  detect, billingOf, accessFile, readJson, writeJson, MODELS_FILE, familyOf, TOOLS, TOOL_PREFERENCE, UsageError,
} from "../multi-model-review/core.mjs";
import { work } from "./workers.mjs";
import { start, task, worktree, status, commit, land, discard, rebaselineCmd, RunRefused } from "./run.mjs";

const TIER_ORDER = ["heavy", "standard", "light"];

// One numbered row per installed tool x model, tagged with the size tiers that list it.
export function workerMenu({ platform = process.platform, detectFn = detect, env = process.env, codexHome } = {}) {
  const { tools } = detectFn();
  const workers = readJson(MODELS_FILE, {}).workers ?? {};
  const access = readJson(accessFile(), {});
  const rows = [];
  for (const [tool, t] of Object.entries(tools)) {
    if (!t.installed || t.capped) continue;
    const b = billingOf(tool, { env, codexHome });
    const writeStatus = access[tool]?.__write?.status ?? "untested";
    // Tools with no model catalog only list review suggestions, so add the worker-tier ids (Haiku is not a review model).
    const listed = new Set(t.models.map((m) => m.id));
    const extra = t.catalog ? [] : TIER_ORDER.flatMap((tier) => workers[tool]?.[tier] ?? [])
      .filter((id, i, a) => !listed.has(id) && a.indexOf(id) === i)
      .map((id) => ({ id, name: null, family: familyOf(id), status: access[tool]?.[id]?.status ?? "untested" }));
    for (const m of [...t.models, ...extra]) {
      if (m.status === "unavailable" || m.status === "capped") continue;
      const tiers = TIER_ORDER.filter((tier) => (workers[tool]?.[tier] ?? []).includes(m.id));
      const warnings = [];
      if (tool === "cursor" && platform === "win32") warnings.push("⚠ force, no sandbox");
      if (writeStatus === "failed") warnings.push("experimental: may not write on this machine");
      rows.push({ tool, model: m.id, name: m.name, family: m.family, status: m.status, tiers,
        source: b.source, paidBy: b.paidBy, billing: b.label, sameBudgetAsSession: b.sameBudgetAsSession,
        needsConfirm: b.needsConfirm, writeStatus, warnings });
    }
  }
  const best = (r) => (r.tiers.length ? TIER_ORDER.indexOf(r.tiers[0]) : TIER_ORDER.length);
  rows.sort((a, b) =>
    ((b.tiers.length > 0) - (a.tiers.length > 0))
    || (best(a) - best(b))
    || ((a.family === "Anthropic") - (b.family === "Anthropic"))
    || (TOOL_PREFERENCE[a.tool] - TOOL_PREFERENCE[b.tool]));
  return rows.map((r, i) => ({ n: i + 1, ...r }));
}

// Remember whether a tool managed to write files here. Stored beside review availability, under access[tool].__write.
export function recordWrite(tool, status, note) {
  if (!TOOLS.includes(tool)) throw new UsageError(`unknown tool ${tool}`);
  if (status !== "ok" && status !== "failed") throw new UsageError(`status must be ok or failed, not ${status}`);
  const access = readJson(accessFile(), {});
  access[tool] ??= {};
  access[tool].__write = { status, date: new Date().toISOString().slice(0, 10), ...(note ? { note: note.slice(0, 200) } : {}) };
  writeJson(accessFile(), access);
}

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const COMMANDS = {
  menu: (args) => console.log(JSON.stringify(workerMenu({ platform: flag(args, "--platform") ?? process.platform }), null, 2)),
  "record-write": (args) => { recordWrite(args[0], args[1], args[2]); console.log('{"ok":true}'); },
  work,
  start, task, worktree, status, commit, land, discard, rebaseline: rebaselineCmd,
};

function main() {
  const [command, ...args] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) { console.error(`usage: node orchestrate.mjs ${Object.keys(COMMANDS).join(" | ")}`); process.exit(2); }
  fn(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (e) {
    // A refusal (exit 7) also prints its reason as JSON so callers can read it from stdout.
    if (e instanceof RunRefused) { console.log(JSON.stringify({ ok: false, reason: e.reason })); console.error(e.reason); process.exit(e.exitCode); }
    console.error(e instanceof Error ? e.message : String(e)); process.exit(2);
  }
}
