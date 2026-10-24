# Multi-model orchestrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `multi-model-orchestrate` skill to the public `multi-model-review` plugin, so Claude can hand plan tasks
to other models (Codex, Copilot, Cursor, Gemini, Claude CLI), each writing only in its own git worktree, then gate,
commit per task and land the work. Also add source and billing labels to both menus.

**Architecture:** Shared code moves out of `review.mjs` into `core.mjs` (tool detection, menu, process runner, reply
and usage parsing, failure classification, billing labels). `review.mjs` stays the review CLI. A new
`orchestrate.mjs` CLI adds the worker menu, the write-mode worker run, and the git run lifecycle (start, worktree,
commit, land) with a JSON ledger. A new `SKILL.md` tells Claude how to drive it. Tests use `node:test` against
temp git repos, with no network and no real agent calls.

**Tech Stack:** Node.js ≥ 18 ESM (`.mjs`), no dependencies, `node:test` + `node:assert/strict`, git ≥ 2.30.

**Spec:** `docs/superpowers/specs/2026-10-24-multi-model-orchestrate-design.md` (read it before any task).

## Global Constraints

- Repo: `C:\FromClaudeToProd\fromclaudetoprod-skills`, branch `orchestrate` (already contains `dialogue-mode`).
  Never push.
- No npm dependencies. No `package.json` is required; run tests with
  `node --test "test/*.test.mjs"` from the repo root.
- Must run on Windows, macOS and Linux. On Windows, tools are `.cmd` shims run with `shell: true`. Every path passed
  to a tool goes through `safePath()` (refuses `UNSAFE_PATH` characters) and `quote()`. Every model id matches
  `MODEL_ID` and every session id matches `SESSION_ID`.
- Workers never push, deploy or commit. Claude (through `orchestrate.mjs commit`) is the only one that commits.
- `review.mjs` behavior and its JSON output fields stay backward compatible. Fields may only be added.
- Exact label text (copy verbatim):
  - Claude CLI on a plan: `uses your Claude limits (same budget as this session)`
  - Copilot: `uses Copilot credits`
  - Codex on a ChatGPT login: `uses your ChatGPT plan`
  - Cursor: `uses your Cursor plan`
  - Any API-key billing: `⚠ API costs will apply`
  - Billing not determinable: `may be billed by API key; check`
  - Cursor write mode on Windows only: `⚠ force, no sandbox`
  - Tool whose write test failed: `experimental: may not write on this machine`
- Commit trailers (exact keys): `Implemented-by:`, `Worker-session:`, `Reviewed-by:`, `Fix-rounds:`, `Tests:`,
  `Rework-of:`. Worker naming is `<model display name or id> via <Tool name CLI>`, e.g. `Grok 4.7 High via Cursor CLI`.
- `orchestrate.mjs` exit codes: 0 ok · 2 usage or unexpected error · 3 model unavailable · 4 capped · 5 something
  changed outside the worktree · 6 session not found · 7 preflight or landing refused · 8 nothing to commit.
- Run root: `MMO_RUN_ROOT` env var, default `~/.claude/orchestrate`. Run folder `<root>/<yyyymmdd>-<topic>/`.
- Commit messages follow the repo's plain style and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the implementing model's own attribution line).

## Review Focus

1. **Paths with spaces** (`C:\Users\Jane Doe\...`, a repo in `My Projects`). Every tool call and git call must
   still work. Test: `workerArgs` quotes a worktree path containing a space (Task 5), and the lifecycle tests run in
   a temp folder whose name contains a space (Task 6).
2. **A worker writes into the user's folder instead of its worktree.** `commit` must refuse with exit 5 and change
   nothing. Test in Task 7.
3. **A worker finishes but changed nothing.** `commit` must exit 8 with a clear message, not create an empty
   commit. Test in Task 7.
4. **Resume after a crash mid-task.** The task's worktree already exists. `worktree` must return the existing one
   (same branch), not fail or make a second one. Test in Task 6.
5. **The user commits on their branch while the run is going.** `land` must do a real merge (no fast-forward),
   not fail. Test in Task 7.

---

## File structure

| File | Responsibility |
|---|---|
| `plugins/multi-model-review/skills/multi-model-review/core.mjs` (new) | Shared: constants, `runTool`, `binOf`, `quote`, `safePath`, JSON helpers, `detect`, `menu`, `plan`, `record`, `jsonObjects`, `sumUsage`, `parseResult`, `classifyFailure`, `billingOf` |
| `.../multi-model-review/review.mjs` | Review CLI only: arg parsing, `run` (read-only), command dispatch. Imports `core.mjs` |
| `.../multi-model-review/models.json` | Gains a `workers` section (size tiers per tool) |
| `.../multi-model-review/SKILL.md` | Menu table gains the billing column and the API-key confirmation |
| `plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs` (new) | Orchestrate CLI: `menu`, `record-write`, `work`, `start`, `task`, `worktree`, `commit`, `land`, `status` |
| `plugins/multi-model-review/skills/multi-model-orchestrate/workers.mjs` (new) | Pure `workerArgs()` per tool (write mode) and the worker instruction text |
| `plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs` (new) | Git lifecycle and ledger: `startRun`, `ensureWorktree`, `setTask`, `commitTask`, `landRun`, `readLedger`, `renderLedger` |
| `plugins/multi-model-review/skills/multi-model-orchestrate/SKILL.md` (new) | The skill Claude follows |
| `test/helpers.mjs`, `test/*.test.mjs` (new, repo root) | Tests; not shipped inside the plugin folder |
| `plugins/multi-model-review/.claude-plugin/plugin.json`, `plugins/multi-model-review/README.md`, `README.md`, `.claude-plugin/marketplace.json` | Version 1.3.0 and docs |

---

### Task 1: Reconcile token tracking (merge `main` into `orchestrate`)

`main` has 1.2.0 (`parseReply`, a `tokens` field, "tokens in / out" in the summary). `dialogue-mode` has its own
version (`usage` per turn plus running `totals`, kept in `usage.jsonl`) and Dialogue mode. Keep the dialogue-mode
implementation, because it is a superset, and carry over main's report wording.

**Files:**
- Modify: `plugins/multi-model-review/skills/multi-model-review/review.mjs`, `SKILL.md`, `README.md`,
  `.claude-plugin/plugin.json` (all under `plugins/multi-model-review/`)

**Interfaces:**
- Produces: the merged `review.mjs` that prints `usage` and `totals` (unchanged dialogue-mode fields), with no
  `parseReply` or `tokens`.

- [ ] **Step 1:** `git merge main` on branch `orchestrate`. Expect conflicts in `plugin.json`, `SKILL.md` and
  `review.mjs`.
- [ ] **Step 2:** Resolve `review.mjs` by taking the `orchestrate` side completely (`git checkout --ours`). Resolve
  `plugin.json` by taking ours (version stays `1.2.0`, description mentions dialogue and token use).
- [ ] **Step 3:** Resolve `SKILL.md` by taking ours, then make sure the summary step (step 7/"Write
  `<X>/summary.md`") says: each round's or exchange's model, tool and verdict, its **tokens in / out** from the
  `usage` field (Codex reports input, cached and output; Copilot reports none), and a total-tokens line taken from
  `totals`; and the final message has one line per round with model, verdict, tokens used and the one thing it
  contributed. Make `README.md` keep main's "Token usage" bullet, reworded to say tokens come from `usage` per
  round and `totals` per review, with Copilot reporting none.
- [ ] **Step 4: Verify.** Run `node --check plugins/multi-model-review/skills/multi-model-review/review.mjs`
  (expect no output), `node plugins/multi-model-review/skills/multi-model-review/review.mjs menu` (expect a JSON
  array), and `grep -rn "parseReply\|<<<<<<<\|>>>>>>>" plugins` (expect nothing).
- [ ] **Step 5: Commit** the merge: `Merge main: keep dialogue-mode token tracking (usage + totals), main's report wording`.

---

### Task 2: Extract `core.mjs` and add the test harness

Pure refactor plus tests. `review.mjs` must behave exactly as before.

**Files:**
- Create: `plugins/multi-model-review/skills/multi-model-review/core.mjs`, `test/helpers.mjs`, `test/core.test.mjs`
- Modify: `plugins/multi-model-review/skills/multi-model-review/review.mjs`

**Interfaces:**
- Produces (exports of `core.mjs`):
  - constants `TOOLS`, `SESSION_TOOLS`, `TOOL_PREFERENCE`, `MODEL_ID`, `SESSION_ID`, `UNSAFE_PATH`, `MODELS_FILE`,
    `CODEX_HOME`, and `accessFile()` (reads `MMR_ACCESS_FILE` at call time so tests can override it)
  - `class UsageError extends Error`. `safePath(p, label)` throws it. CLIs catch it and exit 2 with the message.
  - `runTool(cmd, args, {input, cwd, timeout}) -> {code, out, err, spawnError}`, `binOf(tool)`, `quote(p)`,
    `readJson(file, fallback)`, `writeJson(file, value)`
  - `familyOf(id)`, `splitVariant(id)`, `detect()`, `menu(all)`, `plan(rounds)`, `record(tool, model, status, note)`
  - `jsonObjects(text)`, `sumUsage(list)`
  - `parseResult(tool, r, {session, resume, sid, chat}) -> {text, sessionId, usage}`: the per-tool reply/session/
    usage parsing currently inline in `run()`, moved as is
  - `classifyFailure(r, {resume}) -> {status, exitCode, note}`: the failure regexes currently in `run()`, moved as is
- `review.mjs` keeps `run()` (building its read-only args) and dispatch, and imports everything else.
- `test/helpers.mjs` exports `tmpDir(prefix)` (makes a temp folder **whose name contains a space**, removed on
  process exit), `git(cwd, ...args) -> stdout` (throws on non-zero), `makeRepo(dir)` (git init, user.name/email set
  locally, one commit containing `calc.py`, branch `main`), and `runCli(script, args, {env, cwd}) -> {code, out, err, json}`.

- [ ] **Step 1: Write `test/core.test.mjs`** with these tests:
  - `jsonObjects parses one doc, an array, and JSON lines`: `'{"a":1}'` → `[{a:1}]`; `'[{"a":1},{"b":2}]'` → two;
    `'{"a":1}\nnoise\n{"b":2}'` → two.
  - `sumUsage totals tokens and counts turns without cost`: two entries `{inputTokens:10,outputTokens:5,costUsd:0.01}`
    and `{inputTokens:3,outputTokens:1}` → `{turns:2,inputTokens:13,outputTokens:6,costUsd:0.01,turnsWithoutCost:1, cachedInputTokens:0}`.
  - `splitVariant folds effort and fast`: `grok-4.7-high-fast` → `{base:"grok-4.7",effort:"high",fast:true,thinking:false}`.
  - `familyOf`: `gpt-6.1-sol`→OpenAI, `claude-haiku-5-5`→Anthropic, `grok-4.7`→xAI, `gemini-4-argon`→Google.
  - `parseResult claude reads result, session and usage`: `r.out` = one JSON line
    `{"type":"result","result":"hi","session_id":"s1","usage":{"input_tokens":5,"cache_read_input_tokens":2,"output_tokens":3},"total_cost_usd":0.02}`
    → `text "hi"`, `sessionId "s1"`, `usage.inputTokens 7`, `cachedInputTokens 2`, `outputTokens 3`, `costUsd 0.02`.
  - `parseResult codex reads thread id and turn usage`: lines `{"type":"thread.started","thread_id":"t9"}` and
    `{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20}}` →
    `sessionId "t9"`, `usage.inputTokens 100`.
  - `classifyFailure`: `{code:1,err:"Error: model gpt-x not available on your plan"}` → `exitCode 3`, `status "unavailable"`;
    `{code:1,err:"usage limit reached"}` → `4`, `"capped"`; with `{resume:"abc"}` and `err:"session abc not found"` → `6`;
    `{code:1,err:"sandbox denied"}` → `2`, `status null`.
  - `safePath throws UsageError on a quote`: `safePath('C:\\a"b', 'x')` throws `UsageError`.
- [ ] **Step 2:** Run `node --test "test/*.test.mjs"`. Expected: FAIL (cannot find `core.mjs`).
- [ ] **Step 3:** Create `core.mjs` by moving code out of `review.mjs` (no behavior change). Make `review.mjs` import
  from `./core.mjs`. Keep the header comment in `review.mjs`, and give `core.mjs` a short header saying it is shared
  with `multi-model-orchestrate`.
- [ ] **Step 4:** Run `node --test "test/*.test.mjs"`. Expected: all PASS. Then check the refactor is invisible: save
  `node review.mjs menu` output from before Step 3 (`git stash` or the previous commit) and after, and `diff` them.
  Expected: identical.
- [ ] **Step 5: Commit:** `Move shared helper code into core.mjs; add node:test tests`.

---

### Task 3: Source and billing labels in the review menu

**Files:**
- Modify: `core.mjs`, `plugins/multi-model-review/skills/multi-model-review/SKILL.md`
- Test: `test/billing.test.mjs`

**Interfaces:**
- Consumes: `core.mjs` from Task 2.
- Produces: `billingOf(tool, {env = process.env, codexHome = CODEX_HOME} = {}) -> Billing`, where
  `Billing = {source, paidBy: "plan"|"api"|"unknown", label, sameBudgetAsSession: boolean, needsConfirm: boolean}`
  - `source`: `"Claude CLI" | "Codex CLI" | "Cursor CLI" | "Gemini CLI" | "GitHub Copilot CLI"`
  - Rules: **claude**: `env.ANTHROPIC_API_KEY` non-empty, or `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`
    set → api; otherwise plan with `sameBudgetAsSession: true`. **codex**: read `<codexHome>/auth.json`;
    `auth_mode === "chatgpt"` or a `tokens` object → plan; `auth_mode === "apikey"` or a non-null `OPENAI_API_KEY`
    with no tokens → api; missing or unreadable → unknown. **gemini**: always api. **cursor**: plan.
    **copilot**: plan.
  - `label`: plan → the tool's plan label from Global Constraints; api → `⚠ API costs will apply`;
    unknown → `may be billed by API key; check`.
  - `needsConfirm`: `paidBy !== "plan"`.
- `menu()` rows gain `source`, `paidBy`, `billing` (the label), `sameBudgetAsSession`, `needsConfirm`. Existing
  fields are unchanged.

- [ ] **Step 1: Write `test/billing.test.mjs`:**
  - `claude on a login is plan and same budget`: `billingOf("claude",{env:{}})` → `paidBy "plan"`,
    `label "uses your Claude limits (same budget as this session)"`, `sameBudgetAsSession true`, `needsConfirm false`.
  - `claude with ANTHROPIC_API_KEY is api`: `env {ANTHROPIC_API_KEY:"sk-x"}` → `label "⚠ API costs will apply"`, `needsConfirm true`.
  - `codex chatgpt login is plan`: temp `auth.json` `{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{}}` →
    `label "uses your ChatGPT plan"`.
  - `codex api key is api`: `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-y"}` → `paidBy "api"`.
  - `codex without auth.json is unknown`: empty temp dir → `label "may be billed by API key; check"`, `needsConfirm true`.
  - `gemini is always api`: → `label "⚠ API costs will apply"`.
  - `copilot and cursor are plan`: `"uses Copilot credits"`, `"uses your Cursor plan"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL (`billingOf` not exported).
- [ ] **Step 3:** Implement `billingOf` in `core.mjs` and add its fields to `menu()` rows.
- [ ] **Step 4:** In the review `SKILL.md` step 2, change the menu table columns to `# · model · via · how it's paid ·
  status`, with the `billing` label in "how it's paid". Add a rule: "The same model can appear from more than one
  tool (Sonnet through the Claude CLI and through Copilot); the via and how-it's-paid columns tell them apart.
  Never drop either column." In step 3, add: "For every chosen reviewer whose row has `needsConfirm: true`, ask
  before running it: '**<name> via <source> bills <your API key | an account I can't identify>. Use it?**' with
  options `Yes, bill my API key` / `No, pick another model`. A label alone is not enough." Dialogue/panel question
  descriptions now read `#<n> · via <tool> · <billing> · <family> · <status> · <why>`.
- [ ] **Step 5:** Run the tests. Expected: PASS. Run `node review.mjs menu` and check every row has `billing`.
- [ ] **Step 6: Commit:** `Menu shows where each model comes from and how it is paid; API-key rows need a yes first`.

---

### Task 4: Worker menu, size tiers and write status

**Files:**
- Create: `plugins/multi-model-review/skills/multi-model-orchestrate/orchestrate.mjs` (with `menu` and
  `record-write` only for now)
- Modify: `plugins/multi-model-review/skills/multi-model-review/models.json`
- Test: `test/orchestrate-menu.test.mjs`

**Interfaces:**
- Consumes: `detect`, `billingOf`, `accessFile`, `readJson`, `writeJson`, `TOOLS`, `UsageError` from
  `../multi-model-review/core.mjs`.
- Produces:
  - `models.json` gains `"workers"`: per tool, `{light: [ids], standard: [ids], heavy: [ids]}`. Starting values
    (Claude's call; verify the ids in Task 10): claude `light ["claude-haiku-5-5"]`,
    `standard ["claude-sonnet-5-5"]`, `heavy ["claude-opus-5-5"]`; codex `light ["gpt-6-luna"]`,
    `standard ["gpt-6-sol"]`, `heavy ["gpt-6.1-sol"]`; cursor `standard ["grok-4.7-medium"]`,
    `heavy ["grok-4.7-high"]`; gemini `standard ["gemini-3.1-pro"]`, `heavy ["gemini-4-argon"]`; copilot
    `light ["claude-haiku-5.5"]`, `standard ["claude-sonnet-5.5"]`, `heavy ["gpt-6.1-sol"]`. Add a `_workersReadme`
    line: "Size tiers for orchestrate workers. Unlike review, small and fast models are welcome here."
  - `workerMenu({platform = process.platform, detectFn = detect} = {}) -> Row[]`, numbered from 1. One row per installed tool × model
    (not filtered by `notForReview`; skip `unavailable` and `capped`, same as `menu`). Each row has `n, tool, model,
    name, family, status, tiers` (the tiers listing it, `[]` if none), plus the Task 3 billing fields, plus
    `writeStatus: "ok"|"failed"|"untested"` (from `access[tool].__write.status`), and `warnings: string[]`:
    `"⚠ force, no sandbox"` when `tool === "cursor" && platform === "win32"`, and
    `"experimental: may not write on this machine"` when `writeStatus === "failed"`. Sort: rows with any tier first
    (heavy before standard before light), then non-Anthropic before Anthropic, then `TOOL_PREFERENCE`.
  - `recordWrite(tool, status: "ok"|"failed", note?)` writes `access[tool].__write = {status, date, note?}`.
  - CLI: `orchestrate.mjs menu [--platform <p>]` prints `workerMenu()` JSON; `orchestrate.mjs record-write <tool> <ok|failed> [note]`
    prints `{"ok":true}`.

- [ ] **Step 1: Write `test/orchestrate-menu.test.mjs`.** Use a temp `MMR_ACCESS_FILE`, and test `workerMenu` through
  an injectable `detectFn` option (`workerMenu({platform, detectFn})`) fed a fixed `detect()`-shaped object with
  tools `claude` (models `claude-haiku-5-5`, `claude-opus-5-5`) and `cursor` (`grok-4.7-high`):
  - `haiku is offered and tagged light`: a row with `model "claude-haiku-5-5"`, `tiers ["light"]`.
  - `cursor warns only on Windows`: `platform "win32"` → cursor row `warnings` includes `"⚠ force, no sandbox"`;
    `platform "darwin"` → it doesn't.
  - `failed write test marks experimental`: after `recordWrite("cursor","failed")`, the cursor row has
    `writeStatus "failed"` and `warnings` includes `"experimental: may not write on this machine"`.
  - `rows carry billing`: the claude rows have `billing "uses your Claude limits (same budget as this session)"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. `orchestrate.mjs` dispatch mirrors the bottom of `review.mjs`, catching `UsageError`
  to exit 2.
- [ ] **Step 4:** Run the tests. Expected: PASS. Run `node .../orchestrate.mjs menu` on this machine; expect Haiku,
  Sonnet and Opus via Claude CLI, the Codex models, and Cursor rows with the Windows warning.
- [ ] **Step 5: Commit:** `Orchestrate: worker menu with size tiers, billing and write-status warnings`.

---

### Task 5: Write-mode worker run (`work`)

**Files:**
- Create: `plugins/multi-model-review/skills/multi-model-orchestrate/workers.mjs`
- Modify: `orchestrate.mjs` (add `work`)
- Test: `test/workers.test.mjs`

**Interfaces:**
- Consumes: `runTool`, `binOf`, `quote`, `safePath`, `parseResult`, `classifyFailure`, `record`, `jsonObjects`,
  `sumUsage`, `MODEL_ID`, `SESSION_ID`, `SESSION_TOOLS` from core.
- Produces:
  - `WORKER_ASK(briefPath)`, a string: "Read the task brief at <briefPath> and do exactly what it asks. Edit files
    only inside the current folder. Do not commit, push or deploy. Do not run commands; if you need one (install a
    package, run a generator or formatter), do not run it — end your reply with a line `NEEDS: <command> because
    <reason>`. End your reply with a short summary of what you changed."
  - `workerArgs(tool, {model, worktree, brief, out, session, resume, chat, platform}) -> {cmd, args, input, cwd}`. `worktree`
    and `brief` are already absolute and safe. Per tool (verify against installed versions in Task 10; record any
    flag change in a comment):
    - **codex**: new `["exec","--json","--skip-git-repo-check","-m",model,"-o",quote(out),"-s","workspace-write","-C",quote(worktree),"-c","mcp_servers={}","-"]`;
      resumed `["exec","resume","--json","--skip-git-repo-check","-m",model,"-o",quote(out),"-c","sandbox_mode=workspace-write","-c","mcp_servers={}",resume,"-"]`;
      `input` = the brief text.
    - **claude**: `["-p","--model",model, session flags as in review.mjs, "--output-format","json","--tools","Read,Grep,Glob,Edit,Write","--strict-mcp-config","--disable-slash-commands","--setting-sources","project,local","--permission-mode","acceptEdits","--allowedTools","Read","Grep","Glob","Edit","Write","--disallowedTools","Bash","PowerShell","NotebookEdit","WebFetch","WebSearch"]`;
      `input` = the brief text (no `--add-dir`, so it can write only under `cwd`).
    - **copilot**: `["-p",quote(WORKER_ASK(brief)),"--model",model,"--add-dir",quote(dirname(brief)),"--allow-tool","write","--deny-tool","shell","--deny-tool","url","--no-color","-s"]`.
    - **gemini**: `["-p",quote(WORKER_ASK(brief)),"-m",model, session flags as in review.mjs, "--approval-mode","auto_edit","--skip-trust","-o","json","--include-directories",quote(dirname(brief))]`.
    - **cursor**: `["-p","--force", ...(platform==="win32" ? [] : ["--sandbox","enabled"]),"--trust","--output-format","json","--model",model, ...(chat?["--resume",chat]:[]),"--workspace",quote(worktree),"--add-dir",quote(dirname(brief)),quote(WORKER_ASK(brief))]`.
    - `cwd` is always `worktree`.
  - CLI `orchestrate.mjs work --tool <t> --model <id> --brief <file> --worktree <dir> --out <file> --repo <user repo> [--session new|<id>]`:
    runs the worker (timeout 30 min), writes the reply to `--out` and a `.log` beside it, appends usage to
    `usage.jsonl` beside `--out` (same format as review), records availability/caps through `record` (same rules as
    review), and prints JSON `{tool, model, exitCode, status, out, sessionId, usage, totals, needs: string[], changedFiles: string[], outsideChanged: boolean}`.
    `needs` = every `NEEDS:` line in the reply. `changedFiles` = `git -C <worktree> status --porcelain` paths.
    `outsideChanged` = `git -C <repo> status --porcelain` differs from before the run → exit 5. Otherwise the exit
    code comes from `classifyFailure`.

- [ ] **Step 1: Write `test/workers.test.mjs`** (pure, no processes):
  - `codex writes in its sandbox with MCP off`: args include `"-s","workspace-write"` and `"mcp_servers={}"`, and
    never `"read-only"`.
  - `claude gets edit tools but no shell or web`: the `--tools` value is `"Read,Grep,Glob,Edit,Write"`;
    `--disallowedTools` is followed by `"Bash"` and `"WebFetch"`; there is no `--add-dir`.
  - `copilot may write but not run shell or fetch urls`: args contain `"--allow-tool","write"`, `"--deny-tool","shell"`
    and `"--deny-tool","url"`.
  - `gemini uses auto_edit`: `"--approval-mode","auto_edit"`.
  - `cursor sandbox only off Windows`: `platform "linux"` → contains `"--sandbox","enabled"`; `"win32"` → doesn't; both contain `"--force"`.
  - `paths with spaces are quoted`: worktree `C:\\Users\\Jane Doe\\wt\\t1` for codex → args contain `"\"C:\\Users\\Jane Doe\\wt\\t1\""`.
  - `ask forbids commits and asks for NEEDS lines`: `WORKER_ASK("x")` includes `"Do not commit"` and `"NEEDS:"`.
  - `needs lines are extracted`: export `parseNeeds(text) -> string[]`;
    `"done\nNEEDS: npm install zod because schema\n"` → `["npm install zod because schema"]`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `workers.mjs` and the `work` command.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `Orchestrate: write-mode worker run, confined to its worktree`.

---

### Task 6: Run start, worktrees and ledger

**Files:**
- Create: `plugins/multi-model-review/skills/multi-model-orchestrate/run.mjs`
- Modify: `orchestrate.mjs` (add `start`, `task`, `worktree`, `status`)
- Test: `test/run-start.test.mjs`

**Interfaces:**
- Produces (exported from `run.mjs`; every git call goes through `runTool("git", ["-C", quote(dir), ...])`):
  - `startRun({repo, topic, root = runRoot(), date = today}) -> {run, runBranch, runWorktree, base, userBranch, dirty}`.
    Preflight (each failure throws `RunRefused` with a `reason`, and the CLI exits 7): not a git repo; no commits;
    detached HEAD ("make a branch first"); `.gitmodules` exists (`reason` mentions submodules; the CLI exits 7
    unless `--allow-submodules`). `topic` must match `^[a-z0-9][a-z0-9-]{0,40}$`. The run branch is
    `orchestrate/<topic>`; if it exists, use `orchestrate/<topic>-2`, `-3`, and so on. It creates the run folder
    `<root>/<yyyymmdd>-<topic>[-n]/` and a run worktree at `<run>/wt/_run` on the run branch at `HEAD`, and writes
    `ledger.json` and `ledger.md`.
  - `ledger.json` = `{version:1, topic, repo, base, userBranch, runBranch, runWorktree, userStatusAtStart, dirty, createdAt, tasks:{}}`.
    `userStatusAtStart` is the raw `git status --porcelain` text; `dirty` is its paths.
  - `readLedger(run)`, `writeLedger(run, ledger)` (always re-renders `ledger.md`), `renderLedger(ledger) -> string`:
    a markdown table `| Task | Status | Worker | Reviewer | Fix rounds | Tests | Commit |`.
  - `setTask(run, id, fields)`: merges `fields` into `tasks[id]`. Allowed keys: `title, status, worker, tool, model,
    session, reviewer, fixRounds, tests, commit, note, wave`. `status` ∈ `pending|running|passed|stalled|skipped|failed`;
    `tests` ∈ `passed|failed|not run`. Anything else throws `UsageError`. `id` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$`.
  - `ensureWorktree(run, id) -> {path, branch, created: boolean}`: branch `orchestrate/<topic>--<id>` from the run
    branch tip, path `<run>/wt/<id>`. If that worktree already exists on that branch, return it with
    `created: false`.
  - CLI: `start --repo <dir> --topic <t> [--allow-submodules]`; `task --run <R> --id <id> --set k=v [--set k=v ...]`;
    `worktree --run <R> --id <id>`; `status --run <R>` (prints the ledger plus `runTip` and `tipMatches`: whether the
    run branch tip equals the newest `passed` task's `commit`, or `base` if none). All print JSON.

- [ ] **Step 1: Write `test/run-start.test.mjs`.** Each test uses `tmpDir()` (the name contains a space) and
  `MMO_RUN_ROOT` inside it:
  - `start creates run branch, run worktree and ledger`: on `makeRepo` → `runBranch "orchestrate/demo"`,
    `git branch --list orchestrate/demo` is non-empty, `<run>/wt/_run/calc.py` exists, `ledger.md` contains `| Task |`.
  - `second start gets a numbered branch`: start twice with topic `demo` → the second is `orchestrate/demo-2`.
  - `refuses a folder that is not a repo`: exit 7, `reason` mentions "not a git repository".
  - `refuses detached HEAD`: after `git checkout --detach` → exit 7, `reason` mentions "branch".
  - `records the user's dirty files`: modify `calc.py` before start → `dirty ["calc.py"]`.
  - `worktree is created once and reused on resume`: `ensureWorktree(run,"t1")` twice → same `path`, second
    `created false`, and `git worktree list` shows it once.
  - `task rejects unknown keys and statuses`: `setTask(run,"t1",{bogus:1})` throws; `{status:"done"}` throws;
    `{status:"running", worker:"GPT-6.1-Sol via Codex CLI"}` is saved and shows up in `ledger.md`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `Orchestrate: run branch, per-task worktrees and a ledger that survives restarts`.

---

### Task 7: Commit a task and land the run

**Files:**
- Modify: `run.mjs`, `orchestrate.mjs` (add `commit`, `land`)
- Test: `test/run-commit-land.test.mjs`

**Interfaces:**
- Consumes: `startRun`, `ensureWorktree`, `setTask`, `readLedger` from Task 6.
- Produces:
  - `commitTask(run, id, {title, tests, reworkOf}) -> {commit, files}`. In order:
    1. If `git -C <repo> status --porcelain` ≠ `userStatusAtStart` → throw `OutsideChange` (CLI exit 5), change nothing.
    2. If the task worktree has no changes → throw `NothingToCommit` (exit 8).
    3. `git add -A` and commit in the task worktree. Message: `<title>` (first line, from `--title`, else
       `tasks[id].title`), a blank line, then the trailers in this order, each only when known:
       `Implemented-by: <tasks[id].worker>`, `Worker-session: <tool> <session>`, `Reviewed-by: <reviewer>`,
       `Fix-rounds: <fixRounds ?? 0>`, `Tests: <tests>` (required: `passed|failed|not run`), `Rework-of: <reworkOf>`.
       Commit with `-c user.name=... -c user.email=...` taken from the user repo's git config, so it works in a
       fresh worktree.
    4. `git -C <runWorktree> cherry-pick <commit>`. On conflict: `cherry-pick --abort`, leave the task worktree in
       place, and throw `Conflict` (exit 7, `reason` lists the conflicting files).
    5. Remove the task worktree (`git worktree remove`) and its branch.
    6. `setTask(run, id, {status:"passed", commit:<run-branch sha>, tests})`.
  - `landRun(run, {mode: "merge"|"squash"|"uncommitted"}) -> {mode, commits, files, kept: runBranch}`:
    - Refuse (`RunRefused`, exit 7) if any file changed in `base..runBranch` is currently dirty in the user repo;
      `reason` lists them.
    - `merge`: `git merge --ff-only <runBranch>` when the user's HEAD is still `base`, otherwise
      `git merge --no-ff -m "Merge orchestrate run <topic>" <runBranch>`.
    - `squash`: `git merge --squash <runBranch>`, then commit `Orchestrate run <topic>: <n> tasks` with one line
      per task (`- <title> (<worker>)`).
    - `uncommitted`: `git merge --squash <runBranch>`, no commit; changes are left staged.
    - Every mode removes the run worktree and keeps the run branch.
  - CLI: `commit --run <R> --id <id> --tests <passed|failed|not-run> [--title ..] [--rework-of <sha>]`
    (`not-run` maps to `not run`); `land --run <R> [--squash | --uncommitted]`.

- [ ] **Step 1: Write `test/run-commit-land.test.mjs`.** Setup helper: `makeRepo` → `startRun` →
  `ensureWorktree(run,"t1")` → write `def subtract...` into the worktree's `calc.py` →
  `setTask(run,"t1",{title:"Task 1: subtract", worker:"GPT-6.1-Sol via Codex CLI", tool:"codex", session:"019a", reviewer:"Claude Opus 5.5 (this session)", fixRounds:1})`.
  - `commit carries the agent trailers`: `commitTask(run,"t1",{tests:"passed"})` → `git log -1 --format=%B <runBranch>`
    contains `Implemented-by: GPT-6.1-Sol via Codex CLI`, `Worker-session: codex 019a`, `Fix-rounds: 1`,
    `Tests: passed`; the task worktree folder is gone; the ledger status is `passed`.
  - `tests not run is recorded, never passed`: `tests:"not run"` → the message contains `Tests: not run`.
  - `refuses when the user's folder changed` (Review Focus 2): write a file into the user repo before
    `commitTask` → throws `OutsideChange`; the run branch tip is unchanged.
  - `refuses an empty change` (Review Focus 3): a fresh worktree with no edits → throws `NothingToCommit`.
  - `second task builds on the first`: after t1 is committed, `ensureWorktree(run,"t2")` sees `subtract` in `calc.py`.
  - `land merge fast-forwards with one commit per task`: two committed tasks → `landRun(run,{mode:"merge"})` →
    the user branch log has both task commits; the `orchestrate/demo` branch still exists.
  - `land merges when the user committed meanwhile` (Review Focus 5): commit an unrelated file on the user branch
    after start → `landRun` merge succeeds; HEAD has two parents.
  - `land squash makes one commit`: → one new commit whose body lists `Task 1: subtract (GPT-6.1-Sol via Codex CLI)`.
  - `land uncommitted leaves changes staged`: → `git diff --cached --name-only` lists `calc.py`; HEAD unchanged.
  - `land refuses to overwrite the user's edits`: run changed `calc.py`, the user also has uncommitted edits in
    `calc.py` → throws `RunRefused`; the user's edit is still there.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite `node --test "test/*.test.mjs"`. Expected: all PASS.
- [ ] **Step 5: Commit:** `Orchestrate: commit each passed task with its agent and session, then land the run`.

---

### Task 8: The `multi-model-orchestrate` SKILL.md

Prose only, so there's no unit test. Verification is the dry run in Step 3 plus Task 10.

**Files:**
- Create: `plugins/multi-model-review/skills/multi-model-orchestrate/SKILL.md`

**Interfaces:**
- Consumes: every `orchestrate.mjs` command (Tasks 4–7), `review.mjs run` for the read-only gate, and the
  `multi-model-review` skill for the optional whole-run review.

- [ ] **Step 1: Write the frontmatter.** `name: multi-model-orchestrate`; the description triggers on "orchestrate
  this", "multi-model orchestrator", "offload the work to other models / Codex / Copilot", "hand this plan to other
  agents", "I'm running out of Claude, have other models do it". It says: Claude splits the work, recommends how
  many agents (0–4) and which model per task, each agent writes only in its own git worktree, Claude or another model
  signs off, one commit per task.
- [ ] **Step 2: Write the body.** In the style of the review `SKILL.md` (numbered steps, `<this folder>` paths,
  `node --no-deprecation`), covering, in this order:
  1. **Pin down the work.** A plan file (recognize superpowers plans: `### Task N`, Global Constraints), a spec, a
     Parley decision doc, or chat text. The plan's own test commands, constraints and "do not commit" rules win.
     Also read CLAUDE.md/AGENTS.md for "do not commit" rules → land mode `uncommitted`, said up front.
  2. **Split and size.** Tasks with id, title, files, depends-on, size (light/standard/heavy, using the spec's
     table). Group into waves by depends-on. Detect setup and test commands (package.json scripts,
     `.sln`/`.csproj`, pyproject, Makefile) unless the plan names them.
  3. **Recommend.** Run `orchestrate.mjs menu`. Agent count 0–4 (0 = "This is small enough that I'll just do
     it.", roughly one short task or a few files of simple edits; 1 = default minimum; >1 only for independent
     tasks in the same wave). If most tasks are a chain, say the gain is budget, not speed. Pick per task from the
     rows whose `tiers` include the task's size. If the user said they are near their Claude limit, prefer
     non-Anthropic rows and say Claude CLI workers share the session's budget. Show the table
     `# · task · size · model · via · how it's paid · why`, with warnings inline, plus the setup and test commands
     and one paragraph of recommendation.
  4. **Ask** (AskUserQuestion), with the spec's two questions copied **verbatim**: "Use this lineup?" (4 options)
     and "Who should sign off on each task before it's committed?" (`This Claude session (Recommended)` /
     `Other models: I'm close to my Claude limit`, with the spec's descriptions; recommend the second when the user
     said they are near their limit). If others sign off, ask which reviewer (a different family from the worker,
     non-Claude first). Then, **for every chosen worker or reviewer row with `needsConfirm`**, ask
     "<name> via <source> bills <your API key | an account I can't identify>. Use it?" with
     `Yes, bill my API key` / `No, pick another model`. Rows with `writeStatus "failed"` are offered only with
     the experimental warning. For Cursor on Windows, say that the user's Claude Code permission settings may ask
     them to approve the `--force` run, and what they are approving.
  5. **Start.** `orchestrate.mjs start`. If the plan depends on files in `dirty`, stop and ask the user to commit or
     stash. Record every task with `task --set` (title, wave, worker as `<name> via <source>`, tool, model).
  6. **Each task:** `worktree`; run setup in it; write the brief (task text, files, done means, test command,
     "edit files only in this folder; do not commit") to `<run>/t<id>-brief.md`; `work ... --session new` for
     session tools; store `session` with `task --set`. Handle `NEEDS:` lines: run only setup, build, format or
     codegen commands inside the worktree, never migrations, pushes, deploys or network calls outside the package
     manager; ask the user for anything else; failures caused by missing setup do not count as fix rounds. Run
     tests yourself in the worktree and save the log. **Gate**: this session reads the diff (`git -C <wt> diff`)
     and the test log, or the reviewer gets the diff, brief and test log through `review.mjs run` and you read only
     its verdict line and the test result. A fail goes back to the worker with `--session <id>` (or a fresh brief
     with the findings for Copilot). At most **3 fix rounds**, then ask: different model / Claude does it / skip.
     A pass → `commit --tests ...`. Exit 5 → stop the run and tell the user what changed outside the worktree.
     Exit 8 → treat as a failed attempt. Exit 4 (capped) → `task --set status=stalled note="<tool> out of usage"`
     and offer another model.
  7. **Waves.** Up to the agent count at once (parallel `work` calls in background). Commit each pass right away.
     The next wave starts when every task in the wave is passed, stalled or skipped. Exit 7 `Conflict` → send the
     worker the conflicting files, in a fresh worktree from the new tip.
  8. **Resume** ("continue the orchestrate run"): `status`; if `tipMatches` is false, stop and show why; continue at
     the first task not `passed`.
  9. **Finish.** Offer one `multi-model-review` round (different family) on `base..runBranch`. Then `land` (default
     merge; `--squash` if the user asks; `--uncommitted` when commits are forbidden). Report one line per task
     (worker, verdict, fix rounds, tokens, tests), totals by source from `usage.jsonl`, stalled/skipped tasks, and
     that the run branch is kept.
  10. **Rework later** ("send Task 3 back to its agent"): find the commit's `Worker-session` trailer, `worktree` with
      a new id (`t3-rework`), `work --session <id>` with the new folder path and what to change, gate, then
      `commit --rework-of <sha>`. No session (Copilot) or exit 6 → the same model fresh, with the original diff and
      findings.
- [ ] **Step 3: Dry run.** In a throwaway repo under the session scratchpad (never a work repo), use
  `start` → `worktree` → `work --tool claude --model claude-haiku-5-5` with a one-line task → run its test →
  `commit --tests passed` → `land`. Expected: the user branch has one commit with
  `Implemented-by: ... via Claude CLI`. Fix any step the SKILL.md got wrong.
- [ ] **Step 4: Commit:** `Orchestrate skill: Claude recommends the lineup, agents work in their own worktrees`.

---

### Task 9: Version and docs

**Files:**
- Modify: `plugins/multi-model-review/.claude-plugin/plugin.json`, `plugins/multi-model-review/README.md`,
  `README.md`, `.claude-plugin/marketplace.json`

- [ ] **Step 1:** `plugin.json`: version `1.3.0`. The description adds: "...and an orchestrator: Claude hands plan
  tasks to other models, each writing only in its own git worktree, and commits each task with the agent that did
  it." Add the keywords `orchestrate` and `multi-agent`.
- [ ] **Step 2:** `README.md` (plugin): a new "Orchestrate" section (what it does, the lineup table example, the
  sign-off choice, per-task commits with `Implemented-by`, rework by session, safety rules per tool including the
  Windows Cursor note, and that Claude CLI workers share your Claude limits). Update the setup table with a column
  for how each tool is paid, and note that API-key models need a yes first.
- [ ] **Step 3:** Root `README.md` and `marketplace.json`: one-line descriptions that mention orchestration.
- [ ] **Step 4: Verify:** `node --test "test/*.test.mjs"` passes; `grep -n "1.3.0" plugins/multi-model-review/.claude-plugin/plugin.json`.
- [ ] **Step 5: Commit:** `1.3.0: multi-model orchestrate; source and billing labels in every menu`.

---

### Task 10: Live acceptance (controller with Todd, not a subagent)

Real agents, real accounts. Only in a throwaway repo in the session scratchpad. Each run costs the user's plan
usage, so confirm with Todd before starting, and **never run Gemini (API key) without his yes**.

- [ ] **Step 1: Windows, this machine.** For each of Codex (`gpt-6-luna` or the Task 4 light id), Claude CLI
  (Haiku) and Cursor (Grok, with Todd approving the `--force` prompt): a one-line task through `start` → `worktree`
  → `work` → `commit` → `land`. For each tool, confirm: files changed only in the worktree, `outsideChanged` false,
  the reply was parsed, the session id was captured. Record `record-write <tool> ok|failed` from the result. For
  Codex, confirm writing still works with `mcp_servers={}` (the 2026-10-24 spike wrote through a `node_repl` MCP
  tool); if it cannot write without MCP, record `failed` and note why.
- [ ] **Step 2: Verify the worker ids in `models.json` `workers`** against `orchestrate.mjs menu` and fix any that
  don't exist.
- [ ] **Step 3: Copilot checklist for Todd's other computer.** Write `docs/copilot-acceptance.md`: install command,
  the exact `orchestrate.mjs` commands to run in a scratch repo, what to check (writes only in the worktree,
  shell denied, the reply is captured), and how to `record-write copilot ok|failed`. Todd runs it there.
- [ ] **Step 4:** Update the spec's worker safety table with what actually worked. Commit:
  `Acceptance: record which tools can write on Windows; Copilot checklist`.
