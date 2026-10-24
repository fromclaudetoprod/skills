# Multi-model orchestrate: design

Date: 2026-10-24. Status: for Todd's approval (builder check done). Plugin: `multi-model-review` (public, `fromclaudetoprod/skills`).
Branch: `orchestrate`, built on `dialogue-mode` (commit e28dfc2).

## Why

Long implementation runs stop halfway when Claude runs out of usage. On 2026-10-23 Todd ran a 14-task plan
(event sponsorship, `C:\MyCreditPlan\my-credit-plan-dnn\.superpowers\sdd\2026-10-23-event-sponsorship\`) through
subagent-driven development. Claude did all of the coordination: writing briefs, reading every diff, reviewing, fix
rounds and final verification, and all implementers were Claude models, so the whole run came out of one Claude
budget. Blake (the scrum master pushing AgentParley) hit the same wall the same week and wished he could have handed
the work to Codex.

Most developers who use Claude Code also pay for at least one other agent (ChatGPT/Codex, GitHub Copilot, Cursor) and
those budgets go unused while Claude's runs out. The plugin already knows how to find and call those tools for
review. This skill lets Claude hand the *work* to them and stay the orchestrator.

Parley (Todd's hosted meeting room for agents) stays brainstorm-only. Agents writing files through a shared room is
the dangerous part. A Parley decision document is one possible *input* to this skill, read locally, never a channel
for writes.

## What it is

A second skill in the same plugin, `multi-model-orchestrate`, next to `multi-model-review`. The user says something
like "orchestrate this", "do this plan but offload the work to other models", or "use the multi-model orchestrator".
Claude:

1. reads the work (a plan file, a spec, a Parley decision doc, or a task typed in chat) and splits it into tasks,
2. **recommends a lineup**: how many agents, and which model from which tool for each task, with a reason,
3. asks the user to approve or change the lineup and to choose who gives the final judgment on each task,
4. runs each task in its own git worktree with the chosen agent, write access confined to that worktree,
5. checks each task (tests always; diff review by Claude or by another model, per the user's choice), sends it back
   for fixes or commits it,
6. at the end, brings the work onto the user's branch with one commit per task, and reports.

## Goals

- **Get the work done when Claude's budget is short.** Implementation tokens come out of other vendors' budgets;
  Claude spends tokens only on splitting, lineup, gating and the report.
- **Claude recommends, the user decides.** Claude proposes the number of agents and a model per task. The user can
  take it as is or change any row.
- **Right-size the model to the task.** Simple tasks (fetch some text, rename, copy edits) get a small, fast model;
  normal tasks a mid model; hard or risky tasks a flagship.
- **Say "you don't need this" when that is true.** If the whole job is small, the recommendation is zero agents:
  "This is small enough that I'll just do it." The user can still override.
- **Never surprise the user with a bill.** Every model row says where it comes from and how it is paid.
- **Each agent stays in its own worktree.** Nothing an agent does touches the user's working folder.
- **Resumable.** If any model, including Claude, runs out mid-run, the run picks up from the last passed task, and
  the user can swap the model for the task that stalled.
- **Works for anyone who installs the public plugin** on Windows, macOS or Linux, with whatever subset of tools they
  have.

## Non-goals (v1)

- Codex, Copilot or any other tool as the orchestrator. Claude orchestrates. (Codex as orchestrator is a later,
  separate project.)
- Writing through Parley.
- Pushing, opening PRs, deploying, or applying database migrations. The run ends with commits on the user's local
  branch; the user does the rest.
- A multi-model security review skill (later brainstorm).
- Running agents on remote/cloud machines.

## Anti-goals (would be a failure even if it technically works)

- An agent changes a file outside its worktree.
- The user is charged by an API key they did not realize they picked (Todd keeps almost picking the Gemini API,
  thinking it is Copilot's Gemini).
- Claude spends about as many tokens orchestrating as it would have spent doing the work, especially on small jobs.
- The user's uncommitted changes are overwritten.
- Claude reports a task as passing when its tests were not run.

## The lineup recommendation

After splitting the work, Claude shows one table and a short recommendation, then asks.

**Number of agents.** 0 to 4, never more than 4 at once.
- 0: the job is small (roughly one short task or a few files of simple edits). Claude says so and offers to do it
  itself. Overridable.
- 1: the default minimum for a real orchestrated run, for example when the user is on Opus and wants Sonnet or Codex
  to do the work.
- 2 to 4: only when there are tasks that do not depend on each other. Claude reads task dependencies (which task
  uses what another task creates) and groups tasks into waves. Agents in the same wave run at the same time in
  separate worktrees; a wave starts from the result of the previous wave. Most plans are mostly a chain (in the
  event-sponsorship plan, Task 3 fed Tasks 8 to 11), so the main benefit is moving work off Claude's budget, not
  speed. Claude should say that plainly when it applies.

**Model per task.** Each task gets a size and a suggested model:

| Size | Typical task | Suggested class |
|---|---|---|
| Light | fetch or copy text, rename, small docs or config edits | small fast model (Haiku class, a mini/fast GPT, a fast Gemini) |
| Standard | a normal feature slice with tests | mid model (Sonnet class, a standard GPT) |
| Heavy | cross-cutting changes, security-sensitive code, tricky logic, migrations | flagship (GPT-6.1-Sol, Opus, Grok high, Gemini flagship) |

The reason is one short phrase in the table ("only reads two files and edits copy"). The actual model ids come from
the runner's `menu` (what is installed and available on this machine), never from memory.

**The table.** One row per task:

`# · task · size · model · via (source) · how it's paid · why`

Under it, Claude's one-paragraph recommendation (agent count, why), then the questions.

## Where each model comes from (labels)

Every model row, in both the worker menu and the reviewer menu, and in the existing `multi-model-review` menu too,
shows its **source** and **how it is paid**. The same model name can appear more than once from different sources
(Sonnet through the Claude CLI, Sonnet through Copilot); the source column is what tells them apart.

| Source | Label |
|---|---|
| Claude CLI (subscription login) | `uses your Claude limits`, marked as the **same budget as this session** |
| GitHub Copilot CLI | `uses Copilot credits` |
| Codex CLI (ChatGPT login) | `uses your ChatGPT plan` |
| Cursor CLI | `uses your Cursor plan` |
| Any tool running on an API key (today: Gemini CLI with `GEMINI_API_KEY`; Claude or Codex if they are on an API key) | **⚠ API costs will apply** |

On Windows, Codex and Cursor rows carry the note `patch mode on Windows: proposes a diff, Claude applies it` (see
Worker safety). The old write-mode warnings (`⚠ force, no sandbox` for Cursor, `⚠ Windows sandbox: may not write, or
may write outside its folder` for Codex) are kept as `writeWarnings` and apply only with `--mode write`. On macOS and
Linux Cursor runs with `--sandbox enabled` and gets no warning.

How the runner tells a plan login from an API key is left to the builder (environment variables, the tool's own
status command, or its config). If it cannot tell, the row says `may be billed by API key; check` rather than
guessing "plan". A Claude CLI on an API key gets `⚠ API costs will apply` like any other tool.

**Confirm before first use** (Todd's decision): any lineup row marked `⚠ API costs will apply` or `may be billed by
API key` (workers and reviewers alike) needs one extra explicit answer before the run starts, e.g. "Gemini 4 Argon via
Gemini CLI bills your Google API key. Use it?" with `Yes, bill my API key` / `No, pick another model`. A label alone
is not enough.

When the user says they are close to their Claude limit, the recommendation prefers non-Claude sources and says
that Claude CLI workers (Haiku, Sonnet) still draw on the same Claude limits.

## The questions (AskUserQuestion)

Skip anything the user already said.

1. **"Use this lineup?"** `Yes, run it (Recommended)` · `Change some models` · `Fewer agents` · `I'll just have you do
   it` (the last only when Claude recommended agents). "Change some models" leads to one question per task to
   change, with the menu table shown first, the same way `multi-model-review` asks per round.
2. **"Who should sign off on each task before it's committed?"**
   - `This Claude session (Recommended)`: "I'll read every change myself, check it against the plan, and decide
     whether it passes or goes back for another pass. The most careful option, and it uses more of your Claude
     budget."
   - `Other models: I'm close to my Claude limit`: "Another model reviews each change and gives a verdict. I only
     read the verdict and run the tests, so sign-off costs your Claude budget very little."
   When the second is chosen, ask which model reviews (default: a different family from the task's worker, non-Claude
   first), labelled the same way as workers.

Show the recommendation as "Recommended" based on what the user said: if they said they are near their limit, the
second option is the recommended one.

## How a run works

### Setup
- Run folder `<R>` = `~/.claude/orchestrate/<yyyymmdd>-<short-topic>/`, next to the review skill's exchange folders:
  briefs, replies, diffs, test logs and the ledger.
- Private run branch `orchestrate/<short-topic>` from the user's current `HEAD`. If the user's working folder has
  uncommitted changes, note which files; they are not part of the run.
- One worktree per agent, under `<R>/wt/<task-id>` (or a sibling folder if a tool cannot write under the user's
  home; builder's call), each on its own branch off the run branch's current tip.

### Each task
1. Claude writes the task brief: the task text from the plan, the files it touches, what done means, the test
   command, and "edit files only inside this folder; do not commit".
2. The runner starts the worker in that worktree with write mode (see "Worker safety").
3. When it finishes, Claude (not the worker) runs the build and tests in the worktree and saves the log.
4. The gate:
   - **Claude judges**: Claude reads the diff and the test result and decides.
   - **Others judge**: the reviewer model gets the diff, the brief and the test log through the existing read-only
     review path and returns a verdict. Claude reads only the verdict and the test result.
5. Fail: send the findings back to the same worker. Use its session (the dialogue machinery) where the tool supports
   it; otherwise a fresh brief with the findings. At most 3 fix rounds per task (my call), then stop the task and ask
   the user: try a different model, have Claude do it, or skip.
6. Pass: Claude commits the worktree's change on the run branch, one commit per task, with trailers:
   ```
   Task 3: EventSponsorshipRules

   Implemented-by: GPT-6.1-Sol via Codex CLI
   Worker-session: codex 019a2f...   (omitted for tools that cannot resume, e.g. Copilot)
   Reviewed-by: Gemini 4 Argon via Gemini CLI   (or: Claude Opus 5.5, this session)
   Fix-rounds: 1
   ```
   Every task commit names the agent that did the work as `<model> via <tool>` (Todd: "Grok 4.7 via Cursor"), so
   `git log` shows which agent wrote what. The worktree is removed after its commit.

### Rework later, by the same agent
The `Worker-session` trailer (and the ledger) let the user send rework back to the agent that wrote the task, even
after the run ended: "send Task 3 back to its agent: the date check is wrong." Claude reads the trailer, makes a fresh
worktree from the current branch tip, resumes that session with the same tool and model, tells it the new folder
path and what to change, and gates and commits the result like any task (`Rework-of: <commit>`). Resume works for
Codex, Claude, Cursor and Gemini; Copilot has no resume, so it gets a fresh session with the original diff and the
findings. If the session has expired or was deleted (the runner's existing "session not found" case), say so and
offer the same model in a fresh session with that context.

### Waves
Tasks with no dependency on each other in the same wave run at the same time, up to the agent count. A wave's
worktrees all branch from the run branch tip after the previous wave. Same-wave tasks should not touch the same
files; if they do anyway, the second to finish is rebased onto the first and re-tested, and a conflict sends it back
to its worker with the conflict shown.

### Ledger and resume
`<R>/ledger.md` records, per task: status, worker (`<model> via <tool>`), worker session id, reviewer, fix rounds,
run-branch commit, test result, tokens. On
resume ("continue the orchestrate run"), Claude reads only the ledger, checks the run branch matches it, and starts
at the first task not passed. If a worker fails because its tool or account is out of usage, mark the task
`stalled: <tool> out of usage`, and offer to rerun it on another model.

### Finishing
- Optional: offer a whole-run review with `multi-model-review` (one round, a different family) before landing.
- Land on the user's branch: default **merge the run branch's per-task commits** (fast-forward when possible). Option
  at the end: squash into one commit.
- If the repo or plan forbids commits (CLAUDE.md, AGENTS.md, the plan's own constraints, or a user rule), do not
  commit on the user's branch: apply the combined change uncommitted and say so. The run branch keeps the per-task
  history either way.
- If a file the run changed also has uncommitted user changes, stop and ask; never overwrite.
- Report: one line per task (model, source, verdict, fix rounds, tokens), totals by source, what Claude itself spent
  if known, and anything stalled or skipped.

## Worker safety

The rule: **a worker can edit files only inside its worktree. It gets a shell only where that tool's own sandbox
confines the shell to the worktree; otherwise it edits files only and Claude runs every command.** No worker pushes,
deploys or commits.

Starting points per tool. The builder verifies each against the installed version and records what actually works:

| Tool | Write mode | Shell | Notes |
|---|---|---|---|
| Codex | `exec -s workspace-write -C <worktree>`; the user's MCP servers and plugins switched off by name from `CODEX_HOME/config.toml` (`-c mcp_servers.<name>.enabled=false`, `-c plugins."<p>".enabled=false`) | inside its sandbox | Unsafe on Windows (see Live results): the elevated sandbox cannot write, the unelevated one let `apply_patch` write outside the worktree. So on Windows it defaults to patch mode (`-s read-only`; resumed: `-c sandbox_mode=read-only`). Unverified on macOS/Linux. |
| Claude CLI | `-p` with only Read, Grep, Glob, Edit, Write; no MCP, skills or user settings | no | Used for Haiku/Sonnet workers. Same budget as the session. |
| Copilot CLI | allow write, deny shell and url, `--add-dir <worktree>` only | no | Not installed on Todd's main machine; must be tested on his other computer (Copilot credits there). Built and tested in v1. |
| Gemini CLI | an edit-allowing approval mode, no shell | no | API key: always labelled ⚠ API costs will apply. |
| Cursor CLI | `--force` (only way to write in print mode) | macOS/Linux: `--sandbox enabled`; Windows: none | Works on Windows (wrote in its worktree, session captured, no approval prompt in the live run) but is not confined there, so on Windows it defaults to patch mode (`--mode ask`, never `--force`). Claude Code's auto-mode safety check blocked a `--force` run in the earlier spike, so the skill still tells the user a `--mode write` run may need approval. |

**Patch mode.** `work --mode write|patch`; default `patch` for codex and cursor on Windows, `write` elsewhere; supported for codex, cursor and gemini (gemini: `--approval-mode plan`), exit 2 for claude and copilot. The worker runs read-only and replies with one unified diff in a ```diff block. `work` takes the last block, rejects absolute paths, `..` segments, `.git` paths, rename/copy targets outside the folder and symlinks, then runs `git apply --check` and `git apply --whitespace=nowarn` in the worktree (never `--unsafe-paths`) and saves the diff as `<out>.patch`. Output adds `mode`, `patchApplied`, `patchError`; exit **9** = the diff was missing or did not apply (exit 5 still wins). A failed patch is a failed attempt: the worker gets `patchError` verbatim as a fix round.

**Live results (2026-10-24, Windows).** Claude CLI worker (Haiku): wrote in its worktree, a write to an absolute path
outside it was refused, session captured: confined. Cursor (Grok 4.7 Medium, `--force`): wrote in its worktree, session
captured, no approval prompt; not confined on Windows. Codex: `-c mcp_servers={}` does not stop the user's MCP servers;
`-c mcp_servers.<name>.enabled=false` works only for servers defined as `[mcp_servers.<name>]` in `config.toml` (one from a
plugin fails with "invalid transport"), and plugin-provided tools (e.g. a JS REPL) go off with
`-c plugins."<p>".enabled=false`. In the elevated Windows sandbox Codex cannot write even inside the worktree; in the
unelevated one its `apply_patch` wrote outside the worktree. Codex write mode is therefore unsafe on Windows. The whole
lifecycle (start, worktree, work, commit, status, discard, land) worked with correct trailers. Running Python tests in
a worktree created `__pycache__/`, which `commit` picked up; the skill now has Claude remove such artifacts first.
Because of these results, Codex and Cursor on Windows now use patch mode (read-only plus a validated diff). **Patch-mode retest (Windows, 2026-10-24), all passed:** Codex gpt-6-luna (read-only, diff applied in the worktree, outside probe not written, a resumed session applied a follow-up diff as a fix round); Cursor grok-4.7-medium (`--mode ask`, no `--force`, diff applied, outside probe declined); Claude Haiku write mode confined; three per-task commits landed with correct trailers. The live tests also found that Codex and Claude workers never received the worker instructions (the brief alone went to stdin); fixed. Still untested: Copilot and Gemini workers, and macOS/Linux.

**If a tool fails its write test** (Todd's decision): v1 ships with the tools that pass. A failing tool stays in the
worker menu marked `experimental: may not write on this machine` until it is fixed; the review menu is unaffected.
**Approval prompts are acceptable.** A run does not have to be fully unattended: when the user's own Claude Code
permission settings ask before a worker command (as auto mode did for Cursor `--force`), the skill tells the user
what is being approved and why, and waits.

Before committing a task, Claude checks the user's working folder and the run branch did not change except by
Claude's own commit (the review runner already has a tree-changed check; reuse it).

## Implementation notes (decided)

- Same plugin, new skill folder `skills/multi-model-orchestrate/` with its own `SKILL.md`. Reuse `review.mjs`
  for detect/menu/model memory and the read-only review gate; add the write-mode worker call either as a new
  subcommand there or a sibling script (builder's call), sharing the tool table.
- **First task of the build:** reconcile the two token-tracking versions. `main` has 1.2.0's `parseReply` +
  `tokens`; `dialogue-mode` has its own `usage` + running `totals`. Keep one implementation that covers both
  (per-turn usage and running totals) before adding anything.
- The labels (source, how paid, warnings) also go into the existing `multi-model-review` menu.
- Plugin version bump, README and plugin description updated to mention orchestration.
- After the build: update the site page (`C:\FromClaudeToProd\fromclaudetoprod`, `content/plugins.ts`,
  `/plugins/multi-model-review`) with the orchestrator, then the presentation.

## Calls made after the builder check (Claude's calls, Todd to check)

- **Setup and test commands.** They come from the plan when it names them (the plan wins); otherwise Claude detects
  them (package.json scripts, .sln/.csproj, pyproject, Makefile) and shows them in the lineup message so the user can
  correct them before the run. Each new worktree gets the setup step before its worker starts: Claude runs the
  install/restore command there, and copies untracked files the build needs (`.env`, local config) only when the user
  names them. Setup runs once per worktree, not shared.
- **No test command, or setup failed.** The task can still be gated, but the ledger, commit (`Tests: not run`) and
  report say so; it is never called "passed". When "everybody else judges" is chosen and a task has no tests, Claude
  says up front that those tasks rest on the reviewer's read alone.
- **Workers needing a command.** The brief tells workers they cannot run commands; if they need one (install a
  package, run a generator, a formatter), they say so in their reply as `NEEDS: <command> because <reason>`. Claude
  runs it only if it is a setup/build/format/codegen command inside the worktree, never a migration, network call
  outside the package manager, push or deploy; anything else goes to the user. Failures caused by missing setup do
  not count as fix rounds.
- **Git preflight.** Requires a git repo with at least one commit and a named branch (detached HEAD: ask the user to
  make a branch). An existing `orchestrate/<topic>` branch from an earlier run gets a numeric suffix, unless the user
  is resuming it. Submodules: not supported in v1; warn and continue only if the plan does not touch them. In a
  monorepo the worktree is the whole repo; tasks name their subfolder. If the plan depends on the user's
  uncommitted changes, stop before the run and ask the user to commit or stash them; never silently leave them out.
- **Waves.** Order per task: worker finishes, setup/tests, gate, Claude commits on the task's worktree branch, then
  that commit is cherry-picked onto the run branch. A task that passes commits right away even while a sibling is
  still in fix rounds; the next wave starts only when every task in the current wave is passed, stalled or skipped.
  A later sibling that conflicts is replayed onto the new tip and re-tested; a real conflict goes back to its worker.
- **Plan input.** Any markdown or chat text. Superpowers plan files (`### Task N`, global constraints) are recognised
  directly. The plan's own test commands, constraints and "do not commit" rules win over the skill's defaults.
- **Tokens.** Recorded when a tool reports them, `null` otherwise (Copilot reports none; Codex a total only). The
  report does not claim to measure Claude's own spend.
- **Landing without commits.** The run branch is kept and named in the report; the user deletes it when done.
- **Release.** The source/payment labels in the review menu ship in the same version as the orchestrator. The PR
  includes the `dialogue-mode` commits, with token tracking reconciled first.

## Left to the builder

- Exact flags per tool for write mode, and how to detect plan login versus API key.
- Whether the worker call lives in `review.mjs` or a sibling script.
- Where worktrees live if a tool's sandbox cannot write under the user's home.
- How Claude estimates "small enough to do myself" (a rough size rule is fine).
- Test on Windows (Todd's main machine: Codex, Claude, Cursor, Gemini) and on Todd's other computer (Copilot).
