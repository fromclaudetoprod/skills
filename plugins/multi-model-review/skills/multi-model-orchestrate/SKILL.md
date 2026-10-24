---
name: multi-model-orchestrate
description: Use when the user says "orchestrate this", "multi-model orchestrator", "offload the work to other models", "have Codex / Copilot / Cursor / Gemini do the work", "hand this plan to other agents", or "I'm running out of Claude, have other models do it". Claude splits a plan or task list into tasks, recommends how many agents to use (0 to 4) and which model for each task, each agent writes only inside its own git worktree, Claude or another model signs off on every task, and each passed task becomes one commit on the user's branch. Uses the local tools the user already has (OpenAI Codex CLI, GitHub Copilot CLI, Cursor CLI, Google Gemini CLI, Claude CLI) and says what each one bills.
---

# Multi-model orchestrate

You stay the orchestrator and the only voice the user hears. Other models do the work through their own command-line
tools, on this machine, each inside its own git worktree. You split, brief, check, commit and report. Workers never
commit, push or deploy; only `orchestrate.mjs commit` commits, and nothing is pushed by anyone.

Helper: `orchestrate.mjs`, in the same folder as this file. Run it as
`node --no-deprecation "<this folder>/orchestrate.mjs" <command> …`. Commands: `menu`, `record-write`, `start`,
`task`, `worktree`, `work`, `status`, `commit`, `rebaseline`, `land`, `discard`. Every command prints JSON.
The review helper is `../multi-model-review/review.mjs`. Read only the file you need, when you need it:
- `tools.md`: before the first `work` call with a tool you have not used in this run.
- `rework.md`: only when resuming, reworking an earlier task, or sending a fix back to a worker's session.

Rules for the whole run:
- **Hand off word for word.** A brief carries the plan's task text verbatim (quoted, not rewritten) and the spec or
  plan path. A fix request carries the reviewer's findings and the failing test output verbatim, not a summary. You
  add only the folder path, what done means and the safety rules.
- **Fold first.** When you have budget left and the tasks are mostly a chain, doing it in this session is often
  better: fewer handoffs, no lost context. Orchestrate when the user's Claude budget is short or the tasks are truly
  independent. Split by task and files, never by specialty ("frontend agent", "backend agent").
- **Nothing in the user's repo changes during a run, except through you.** Exit 5 from `work`, `commit` or the
  review gate means something wrote there: stop, show the user what changed (`git -C "<repo>" status` and `git -C
  "<repo>" diff`) and ask whether the change was theirs. If it was theirs, run `rebaseline --run "<run>"` (it takes
  the baseline again; exit 7 if their branch changed) and continue. If not, stop the run. Rebaseline only after the user
  confirms, never on your own judgment.
- **A brief leaves this machine for that model's company.** Put in nothing the user has not already shared with you,
  and never a secret, key, token or customer data.

## 1. Pin down the work
Take it from the conversation when clear: a plan file (superpowers plans have `### Task N` and Global Constraints), a
spec, a Parley decision document read locally, or text typed in chat. Ask only if it is genuinely unclear.
- The plan's own test commands, constraints and "do not commit" rules win over this skill's defaults.
- Read the repo's `CLAUDE.md` / `AGENTS.md` for rules against committing. If there are any, land mode is
  `uncommitted` (step 9); say so up front.

## 2. Split and size
List tasks: id, title, files, depends-on, size. Sizes:
- **light**: fetch or copy text, rename, small docs or config edits.
- **standard**: a normal feature slice with tests.
- **heavy**: cross-cutting changes, security-sensitive code, tricky logic, migrations.

Group tasks into **waves** by depends-on (a task that uses what another creates goes in a later wave). Find the
setup command (install or restore) and the test command: the plan's if it names them, else detect them
(`package.json` scripts, `.sln` / `.csproj`, `pyproject.toml`, `Makefile`). With no test command, say so now:
those tasks are committed as `Tests: not run`, never called passed on tests, and under "others sign off" they rest on
the reviewer's read alone.

## 3. Recommend
```
node --no-deprecation "<this folder>/orchestrate.mjs" menu
```
`menu` prints one numbered row per installed tool and model: `tiers` (the sizes it suits), `source`, `billing`,
`paidBy`, `sameBudgetAsSession`, `needsConfirm`, `writeStatus`, `warnings`. Take model ids only from here, never
from memory.
- **Agent count 0 to 4.** 0 when the job is small (about one short task, or a few files of simple edits): say "This
  is small enough that I'll just do it." and offer to. 1 is the default minimum for a real run. More than 1 only for
  independent tasks in the same wave, never more than 4.
- If most tasks are a chain and the user has not said their Claude budget is short, recommend 0 agents and say why
  (fewer handoffs, no lost context). Recommend agents when the budget is short or the tasks are independent and can
  run in parallel. If the budget is unclear, ask one short question. When you do recommend agents for a chain, say
  plainly that the gain is budget, not speed.
- Per task, pick from rows whose `tiers` include the task's size. If the user said they are near their Claude limit,
  prefer non-Anthropic rows. Whenever a row with `sameBudgetAsSession` is chosen as a worker, say that Claude CLI
  workers share your Claude limits with this session.

Show one table: `# · task · size · model · via · how it's paid · why` (why = one short phrase), with each row's
`warnings` inline, then the setup and test commands and one paragraph of recommendation.

## 4. Ask (AskUserQuestion), skipping anything the user already said (except the billing confirmation)
1. **"Use this lineup?"** `Yes, run it (Recommended)` · `Change some models` · `Fewer agents` · `I'll just have you do
   it` (the last only when you recommended agents). "Change some models" asks one question per task to change, with
   the menu table shown first, the way `multi-model-review` asks per round.
2. **"Who should sign off on each task before it's committed?"**
   - `This Claude session (Recommended)`: "I'll read every change myself, check it against the plan, and decide
     whether it passes or goes back for another pass. The most careful option, and it uses more of your Claude
     budget."
   - `Other models: I'm close to my Claude limit`: "Another model reviews each change and gives a verdict. I only
     read the verdict and run the tests, so sign-off costs your Claude budget very little."

   If the user said they are near their limit, mark the second `(Recommended)` instead. If others sign off, ask which
   model reviews: default a different family from the task's worker, non-Claude first, labelled like workers.
3. **Billing confirmation**, for every chosen worker or reviewer row with `needsConfirm: true` (including ones the
   user typed via "Other"): "**<name> via <source> bills <your API key | an account I can't identify>. Use it?**"
   with `Yes, bill my API key` (or `Yes, run it anyway (billing unclear)` when `paidBy` is `unknown`) and
   `No, pick another model`. A "No" re-asks with another pick. A label alone is not enough. The billing confirmation is never skipped, even if the user named the model.

Also: offer rows with `writeStatus: "failed"` only with their warning ("experimental: may not write on this
machine"). On Windows, Codex and Cursor run in **patch mode** (read-only; they propose a diff and `work` applies it), so the row
shows the note `patch mode on Windows: proposes a diff, Claude applies it` and no unsafe-write warning. Only if the
user asks for `--mode write` on those two, show the row's `writeWarnings` plainly and prefer another model.

## 5. Start
```
node --no-deprecation "<this folder>/orchestrate.mjs" start --repo "<repository root>" --topic <short-topic>
```
Prints `run` (the folder `<run>`), `runBranch`, `base`, `userBranch` and `dirty` (the user's uncommitted files). If the
plan depends on any file in `dirty`, stop and ask the user to commit or stash it first; never leave it out silently.
Exit 7 = refused (no commits, detached HEAD, submodules, run folder inside the repo): show the reason.
Tell the user to avoid editing the repo while the run is going; any edit there stops the run (exit 5).
Then record every task:
```
node --no-deprecation "<this folder>/orchestrate.mjs" task --run "<run>" --id t1 --set title="…" --set wave=1 \
  --set worker="<model> via <Tool> CLI" --set tool=<tool> --set model=<id>
```
Worker naming is `<model display name or id> via <Tool name CLI>`, e.g. `Grok 4.7 High via Cursor CLI`. Set
`reviewer` the same way when someone other than this session signs off (`Claude, this session` otherwise).

## 6. Each task
1. `worktree --run "<run>" --id t1` prints `path`. Run the setup command inside it (setup runs once per worktree).
   Copy untracked files the build needs (`.env`) only if the user named them.
2. Write the brief to `<run>/briefs/t1/brief.md` (each task gets its own folder, because Gemini, Cursor and Copilot can
   write there), never into the worktree: the task text verbatim, the spec or plan path,
   files, what done means, the test command, and "edit files only in this folder; do not commit". Say workers cannot
   run commands.
3. Run the worker (in the background, 30-minute ceiling):
   ```
   node --no-deprecation "<this folder>/orchestrate.mjs" work --tool <tool> --model <id> --repo "<repository root>" \
     --worktree "<wt>" --brief "<run>/briefs/t1/brief.md" --out "<run>/replies/t1-r1.md" [--session new]
   ```
   Pass `--session new` for codex, claude, cursor and gemini, then store the printed `sessionId` with
   `task --set session=<id>`; Copilot has no sessions. Output: `status`, `needs`, `changedFiles`, `outsideChanged`,
   `mode`, `usage` and running `totals` (also in `<run>/replies/usage.jsonl`). `--mode write|patch` defaults to `patch`
   for codex and cursor on Windows and `write` elsewhere (see `tools.md`); the output also lists `isolationSkipped`
   (Codex MCP servers or plugins that could not be switched off). In **patch mode** the worker cannot edit files: it
   replies with one unified diff, `work` validates it and applies it in the worktree (`patchApplied`, `patchError`,
   and the diff saved beside the reply as `<out>.patch`). Tell patch-mode workers the task is a diff in the reply.
4. **Exit codes of `work`:** 0 ok · 3 model unavailable: tell the user, offer the next row · 4 capped:
   `task --set status=stalled --set note="<tool> out of usage"` and offer another model · 5 something changed in the
   user's repo: **stop the run** and follow the exit-5 rule above (show `git status` and `diff`, ask, `rebaseline` only if the user says it was theirs) · 6 session not found (see `rework.md`) · 9 patch mode: the worker's diff was missing or did not apply, which
   counts as a failed attempt: send the worker the `patchError` verbatim as a fix round, and say the folder already has
   its earlier change if an earlier diff applied (`rework.md`) ·
   2 anything else: read the `.log` beside `--out`; retry once only if it shows a transient error (network or
   timeout), otherwise ask the user (a blind retry can bill a metered tool twice).
5. **`needs`:** each entry is a command the worker asked for. Run it only if it is a setup, build, format or codegen
   command inside the worktree. Never run migrations, pushes, deploys, or network calls outside the package manager;
   ask the user about anything else. Then send the worker back (`rework.md`). A failure caused by missing setup is
   not a fix round.
6. Run the tests yourself in the worktree and save the log to exactly `<run>/tests/t1.log` (`start` creates only `briefs/`; make `tests/` and `diffs/` yourself). `commit` with `--tests passed` or `failed` refuses (exit 2) without a non-empty file at that path. Where the language allows, run tests with cache-writing off (`PYTHONDONTWRITEBYTECODE=1` for Python).
   **Before `commit`** (it runs `git add -A`) compare `git -C "<wt>" status --porcelain` with the worker's `changedFiles` plus the files from its fix rounds. List candidates with the dry run `git -C "<wt>" clean -nd`. Delete only paths that are untracked, are not in `changedFiles` or any fix-round list, and are known artifacts (`__pycache__/`, `.pytest_cache/`, `coverage/`, `.coverage`, `*.pyc`). Never delete a tracked file or anything else.
7. **Gate.** `git -C "<wt>" add -N .` (deliberate, so the diff shows new files) then `git -C "<wt>" diff > "<run>/diffs/t1.patch"`.
   - *This session signs off:* read the diff and the test log; decide against the plan.
   - *Others sign off:* write a review brief at `<run>/briefs/t1-review/brief.md`, a folder of its own apart from the task's (diff pasted in, the task brief, the test log, ending in
     `VERDICT: AGREE` or `VERDICT: REVISE` with `## Required changes`, as in `multi-model-review` step 4) and run
     `review.mjs run --tool <t> --model <id> --brief … --out … --repo "<wt>"`. Read only the `verdict` and the test
     result. Check reviewer claims before sending them on. `review.mjs run` exits: 5 (`treeChanged`) stop the run like
     `work` (exit-5 rule above); 2, 3 or 4 pick another reviewer, or ask.
8. **Fail:** send the worker the reviewer's or your findings and the failing test output verbatim (`rework.md`) and
   count one fix round: `task --set fixRounds=<n>`. At most **3 fix rounds**, then ask the user: a different model /
   Claude does it / skip (`task --set status=skipped`).
9. **Pass:** `commit --run "<run>" --id t1 --tests <passed|failed|not-run>`. Prints `commit`, `files`, and
   `cleanupWarning` if removing the worktree failed (mention it in the report; it is not a failure). Exit 8 = the
   worker changed nothing: treat as a failed attempt (if the reason says the task has a commit that is not on the run
   branch, an earlier commit conflicted: `discard` and redo). Exit 5 = the user's folder changed: follow the exit-5 rule
   above. Exit 7 `Conflict` (the reason lists files): `discard --run "<run>" --id t1`, `worktree` again (fresh from the
   new tip), then send the worker the conflicting files and its earlier diff.

## 7. Waves
Run up to the agent count at once (parallel `work` calls in the background, one worktree each). Commit each task as
soon as it passes, even while a sibling is still in fix rounds. The next wave starts only when every task in the wave
is `passed`, `stalled` or `skipped`.

## 8. Resume ("continue the orchestrate run")
`status --run "<run>"` (list `~/.claude/orchestrate`, or `MMO_RUN_ROOT`, if the user does not give the folder). If
`tipMatches` is false, stop and show why. Otherwise continue at the first task whose status is not `passed`. Read
`rework.md` for stalled tasks.

## 9. Finish
- Offer one `multi-model-review` round (a different family from the workers) on `base..runBranch`.
- Land on the user's branch: `land --run "<run>"` (merge, fast-forward when possible); `--squash` if the user asks;
  `--uncommitted` when commits are forbidden (say so in the report). `land` refuses (exit 7) if the user has ANY
  staged changes, is on a different branch than at start, or a file the run changed has uncommitted edits. Tell the
  user exactly which, ask them to commit or unstage, and land again. Never stage, unstage, stash or commit the
  user's changes yourself, and never run `git restore` or `git checkout` in their folder. Tell them exactly what
  to run and wait. `land` never overwrites.
- The run branch is kept either way; the user deletes it when done.
- Report one line per task: worker, verdict, fix rounds, tokens, tests. Then totals by source from `usage.jsonl`
  (Copilot reports none; Codex a total only; do not claim to know your own Claude spend), stalled or skipped tasks,
  any `cleanupWarning`, the run folder and the run branch as full absolute paths and names.

## 10. Rework later ("send Task 3 back to its agent")
Read `rework.md`.
