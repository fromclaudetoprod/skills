# Check Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's checks run as one command, a failed check goes straight back to the builder, and `commit` refuses a task whose checks did not pass on its current files.

**Architecture:** New `checks.mjs` beside `run.mjs` (read config, run commands, write the log, fingerprint). `run.mjs` stores the result in the ledger and enforces it in `commitTask`. SKILL.md steps 6–9 switch to `check`.

**Tech Stack:** Node ≥ 20, zero dependencies, `node --test "test/*.test.mjs"`.

**Spec:** `docs/superpowers/specs/2026-11-19-check-gate-design.md`

## Global Constraints
- Checks file: `<user repo>/.orchestrate/checks.json`, shape `{ "checks": [{ "name": string, "run": string }], "timeoutMinutes"?: number }`; read from the ledger's `repo`, never the worktree.
- Log: `<run>/tests/<id>.log`, capped at 2 MB. Default timeout 20 minutes per check.
- Exit codes: `check` 0 passed, 11 failed, 2 usage. `commit` refusal 7 (`RunRefused`).
- Trailer for an override: `Checks-override: <reason>` (one line, ≤ 500 chars).
- Zero dependencies; every existing test keeps passing.

## Review Focus
- Tests that leave artifacts (`__pycache__/`, `.pytest_cache/`, `coverage/`, `.coverage`, `*.pyc`) must not make the fingerprint differ → commit right after a passing check succeeds.
- A worker that edits `.orchestrate/checks.json` inside its worktree must not change which commands run.
- A malformed checks file (bad JSON, empty `checks`, a check without `run`) → usage error naming the file, nothing run.
- A command that hangs → killed at the timeout, counted as failed, the log says "timed out".
- Runs started on 1.5.0 (no `checks` in the ledger) → `commit` behaves exactly as before.

---

### Task 1: `check` command and commit enforcement

**Files:**
- Create: `plugins/multi-model-review/skills/multi-model-orchestrate/checks.mjs`
- Modify: `plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs` (`commitTask`, CLI `commit`, new `check` CLI)
- Modify: `plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs` (`COMMANDS.check`, exit 11)
- Test: `test/check-gate.test.mjs`

**Interfaces:**
- `readChecks(repo: string): {checks: {name, run}[], timeoutMinutes: number} | null` (null when the file is absent; throws `UsageError` when malformed).
- `worktreeFingerprint(wt: string): string` — sha256 of `git status --porcelain` + `git diff HEAD --binary` + untracked non-ignored files, skipping the artifact paths above.
- `runChecks(run, id, {cmds?: string[]}): {result: "passed"|"failed", failed: string|null, log: string, durationMs: number}` — writes the log, saves `ledger.tasks[id].checks = {result, fingerprint, at}` and `tests`.
- `commitTask(run, id, {title, tests, reworkOf, override})` — when `ledger.tasks[id].checks` exists: refuse unless result is passed and fingerprint matches, or `override` is given; `tests` defaults from the check.

- [ ] **Step 1: Write failing tests** in `test/check-gate.test.mjs` (reuse `setup()` pattern from `run-commit-land.test.mjs`):
  - `check passes and commit succeeds` — checks.json `[{name:"ok", run:"node -e 0"}]`; `runChecks` → `result:"passed"`; log file exists and names `ok`; `commitTask(run,"t1",{})` commits with `Tests: passed`.
  - `check fails and commit refuses` — `run:"node -e process.exit(3)"` → `failed:"tests"`-style name, CLI exits 11; `commitTask` throws `RunRefused` mentioning "checks".
  - `override commits with a trailer` — after a failed check, `commitTask(..., {override:"flaky upstream"})` → body contains `Checks-override: flaky upstream`.
  - `edit after check needs a new check` — passing check, then append to `calc.py` in the worktree → `commitTask` throws `RunRefused`.
  - `artifacts do not invalidate the check` — check command creates `__pycache__/x.pyc` and `.pytest_cache/` → commit succeeds.
  - `worker cannot rewrite the gate` — user repo checks.json fails; worktree's `.orchestrate/checks.json` says `node -e 0` → result `failed`.
  - `--cmd fallback` — no checks file, `runChecks(run,"t1",{cmds:["node -e 0"]})` passes; no file and no cmds → `UsageError`.
  - `malformed file` — `{"checks":[]}` and `not json` → `UsageError` naming `.orchestrate/checks.json`.
  - `timeout` — `timeoutMinutes: 0.01`, command `node -e "setTimeout(()=>{},60000)"` → failed, log contains `timed out`.
  - `stops at first failure` — two checks, first fails → log lacks the second's name.
- [ ] **Step 2:** `node --test test/check-gate.test.mjs` → FAIL (module not found).
- [ ] **Step 3:** Implement `checks.mjs` (spawnSync with `shell: true`, `cwd` = worktree, `timeout`, `maxBuffer` large, log truncated at 2 MB with a "(log cut at 2 MB)" line), `runChecks` + ledger write in `run.mjs` (store `checks` on the task directly via `writeLedger`, not `setTask`, so the manager cannot `--set` it), commit enforcement, CLI `check --run --id [--cmd ...]` and `commit --override <reason>` (make `--tests` optional when a check exists).
- [ ] **Step 4:** `node --test "test/*.test.mjs"` → all pass.
- [ ] **Step 5:** Commit `feat(orchestrate): check command and commit gate`.

### Task 2: Skill, docs and 1.6.0

**Files:** `skills/multi-model-orchestrate/SKILL.md` (steps 2, 6, 7, 8, 9), `plugins/multi-model-review/README.md`, both `plugin.json` (`"version": "1.6.0"`), root `README.md` if it lists versions.

- [ ] **Step 1:** SKILL.md: step 2 says to look for `.orchestrate/checks.json` and offer to create one; step 6 replaces "run the tests yourself" with `check --run --id [--cmd]` (exit 11 → step 8 with the log verbatim, no review); step 7 runs only after a passed check; step 9 drops `--tests` when a check ran and documents `--override` (only with the user's say-so).
- [ ] **Step 2:** README: a short "Check gate" section with the checks.json example.
- [ ] **Step 3:** Bump both `plugin.json` to 1.6.0; `node --test "test/*.test.mjs"` passes.
- [ ] **Step 4:** Commit `1.6.0: check gate before review`.
