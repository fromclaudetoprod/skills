# Multi-model review

This plugin has two skills. **Review** has other models check your code or draft, read-only. **Orchestrate** hands
the tasks of a plan to other models that write code. Both use the tools you already have installed.

Ask Claude Code for a review and it runs it in one of two modes:

- **Panel:** several rounds, each by a fresh model, ideally from a different company.
- **Dialogue:** one other model that keeps its session. It researches once, then argues it out with Claude over a few
  exchanges, answering its own earlier points instead of starting from scratch each time.

In a panel, Claude writes
the brief, hands it to the reviewer through that model's own command-line tool, reads the reply in full, checks every
claim, revises, and gives the next reviewer the new version plus what earlier reviewers said. You get one report: the
final draft or the verified code findings, and where the reviewers disagreed.

Everything runs on your machine, read-only. No cloud agents.

## What you need
- **Claude Code** and **Node.js 18+**.
- **At least one reviewer tool**, signed in:
  - OpenAI Codex CLI (`codex`)
  - **Cursor CLI** (`cursor-agent`; install from cursor.com/cli, then `cursor-agent login`). One Cursor plan reaches
    GPT, Grok, Gemini, Kimi, GLM and Claude models, so it is the easiest way to get reviewers from several companies.
  - **Google Gemini CLI** (`npm install -g @google/gemini-cli`) with a **Gemini API key** (from Google AI Studio):
    put `GEMINI_API_KEY=...` in `~/.gemini/.env`. Signing in with a personal Google account no longer works for
    scripted use, so the key is required. Billed per use by Google.
  - GitHub Copilot CLI (`npm install -g @github/copilot`, run `copilot` once to sign in)
  - Claude Code's own CLI (`claude`), which you already have

It lists every model your Cursor and Codex accounts offer (one row per model, effort levels folded in), plus the
suggested models for Claude, Gemini and Copilot, and over time only models your account can actually use.

## Pick a setup
| You have | Models you get | How it is paid |
|---|---|---|
| Claude Code + **Cursor** (simplest) | GPT, Grok, Gemini, Kimi, GLM and Claude models from one Cursor plan | your Cursor plan |
| Claude Code + **Gemini API key** | Gemini as the outside reviewer or worker, Claude last | your API key, per use |
| Claude Code + **Codex** (ChatGPT plan) | GPT models | your ChatGPT plan |
| Claude Code + **Copilot CLI** | the models your Copilot plan offers | Copilot credits |
| Claude CLI (you already have it) | Claude models | your Claude limits, the same budget as this session |
| Any mix of the above | the plugin picks a different company each round | each model shows its own label |

Every model in every menu shows its tool and how it is paid. Anything billed to an API key shows
`⚠ API costs will apply`, and Claude asks for a yes before it runs that model, even if you named it yourself. If it
cannot tell who gets billed, the label says `may be billed by API key; check` and it asks the same way.

## Install
```
/plugin marketplace add fromclaudetoprod/skills
/plugin install multi-model-review@from-claude-to-prod
```
Or copy `skills/multi-model-review` into `~/.claude/skills/`.

If your Claude app says `/plugin` isn't available, run the same two steps in a terminal, then start a new chat
(or run `/reload-plugins`):
```
claude plugin marketplace add fromclaudetoprod/skills
claude plugin install multi-model-review@from-claude-to-prod
```

## Use it
Say **"Run the multi-model review"**. Claude asks which mode, shows the full numbered model list, then asks:
- **Panel:** how many rounds (three is the default) and which model for each round.
- **Dialogue:** which model to go back and forth with, and the most exchanges to allow (three is the default). It
  stops sooner if you agree or stop making progress.

Or say **"Go back and forth with grok-4.7 on this, five exchanges at most."** Or say it all at once: *"Multi-model review of this branch, three rounds: grok-4.7, then gpt-6.1-sol, then
claude-opus-5-5."*

## Orchestrate
Say **"Orchestrate this plan"** (or "have Codex and Cursor do the work"). Claude splits your plan or task list into
tasks, then recommends how many agents to use (0 to 4) and which model for each task. Each model works in
its own git worktree. Claude or another model signs off on each task before it is committed.

If the job is small, or the tasks are mostly a chain and your Claude budget is fine, Claude will say it should just do
the work itself. Splitting a chain across agents saves budget, not time.

### The lineup
Claude shows one table and asks "Use this lineup?" before anything runs. For example:

| # | task | size | model | via | how it's paid | why |
|---|---|---|---|---|---|---|
| 1 | Copy the config templates | light | Claude Haiku 5.5 | Claude CLI | uses your Claude limits (same budget as this session) | cheap and fast for copying |
| 2 | Rewrite the permissions check | heavy | GPT-6.1-Sol | Codex CLI | uses your ChatGPT plan | careful with tricky logic |
| 3 | Add the report export | heavy | Gemini 4 Argon | Gemini CLI | ⚠ API costs will apply | independent of task 2 |

Row 3 gets a question first: "Gemini 4 Argon via Gemini CLI bills your API key. Use it?" You can change any row, use
fewer agents, or have Claude do it all.

### Who signs off
You pick one:
- **This Claude session (recommended):** Claude reads every change, checks it against the plan, and decides whether it
  passes or goes back. The most careful option. It uses more of your Claude budget.
- **Other models:** another model reviews each change and gives a verdict. Claude reads the verdict and runs the
  tests. Use this when you are close to your Claude limit.

A task that fails goes back to its worker with the findings and the test output, word for word. After three fix
rounds Claude asks you: a different model, Claude does it, or skip.

### One commit per task
Workers never commit, push or deploy. Claude commits each task that passes, on a run branch, and nothing is pushed by
anyone. When the run is done, Claude lands the branch on yours (a merge, or a squash if you ask). The commit message
says which agent did the work:

```
Add the report export

Implemented-by: Grok 4.7 High via Cursor CLI
Worker-session: cursor 4f2c9a1e
Reviewed-by: Claude, this session
Fix-rounds: 1
Tests: passed
```

A reworked task also carries `Rework-of: <commit>`. `git log --grep "Implemented-by: Grok"` finds what a model wrote.

### Send a task back
Say **"Send Task 3 back to its agent: the date check is wrong."** Claude reads the trailers on that commit and
resumes the same worker session, so the model still remembers the task. Copilot sessions can't be resumed, so rework
gets a fresh session with the original diff and your note. The same happens when any other session has expired, and
Claude tells you.

### Safety, tool by tool
Workers are told to edit files only in their own worktree, and are not allowed to commit or push. Where the table
below says so, the tool's own sandbox or permission flags enforce this (Codex `workspace-write`, the Claude CLI tool
allowlist and working-folder-only edit approval, Cursor's sandbox on macOS and Linux). Elsewhere it rests on the instruction. If anything in your own
folder changes, Claude detects it and stops the run; that is detection, not prevention. Claude runs the tests itself.

**Status (tested live on Windows, 2026-10-24):**
- **Claude CLI:** works and is confined. It wrote inside its worktree, and a write to an absolute path outside it was refused.
- **Cursor (`--force`):** works, but it is not confined on Windows (it has no sandbox there). So on Windows Cursor now
  uses **patch mode** (see below). The old `⚠ force, no sandbox` warning applies only to `--mode write`.
- **Codex write mode:** unsafe on Windows, so Codex now uses **patch mode** there. In the "elevated" Windows
  sandbox Codex could not write even inside its worktree. In the "unelevated" sandbox its patch tool wrote a file
  outside the worktree. Codex as a read-only reviewer is not affected.
- **Patch mode (Codex and Cursor on Windows):** the worker runs read-only and answers with whole files, each between `<<<FILE path=... code=CODE>>>` and `<<<END CODE>>>` lines with a random code per call (models write unreliable diffs, and Markdown fences are ambiguous); `work` builds the
  exact diff, keeps CRLF/LF, checks it (no paths outside the folder, none inside `.git`, none under a symlink, 1 MB cap) and applies it with git. Tested live on Windows
  (2026-10-24): Codex (gpt-6-luna) applied its diff in the worktree, a resumed session applied a follow-up diff, and the
  outside-write probe was not written; Cursor (grok-4.7-medium, `--mode ask`, no `--force`) applied its diff and
  declined the outside write; Claude Haiku write mode stayed confined; three per-task commits landed with correct
  trailers. Still untested: Copilot and Gemini workers, and macOS/Linux.
- **Copilot and Gemini write modes:** not tested. macOS and Linux: not tested.

Codex has no single switch for "no MCP servers". Claude switches off your MCP servers and plugins one by one, by
reading the names from your `config.toml` (in `CODEX_HOME`, default `~/.codex`). A server or plugin that is not listed there
is not switched off.

| Tool | How it writes | Shell for the worker |
|---|---|---|
| Codex | `workspace-write` sandbox; your MCP servers and plugins switched off by name from your Codex config. Windows: patch mode, read-only, returns whole files | inside its sandbox. Windows: none (read-only) |
| Claude CLI | only Read, Grep, Glob, Edit and Write; no MCP, skills or user settings | none |
| Copilot | write allowed, shell and url denied | none |
| Gemini | `auto_edit` approval mode (patch mode: `plan`) | none |
| Cursor | `--force`; sandbox on macOS and Linux. Windows: patch mode, `--mode ask` without `--force`, returns whole files | macOS/Linux: sandboxed. Windows: none (read-only) |

Limits to know about:
- **Claude CLI workers share your Claude limits.** They draw from the same budget as this session, so on a plan login
  they do not save Claude usage.
- **Gemini CLI bills your API key** and asks for a yes first, every run.
- **Cursor on Windows can only write with `--force` and has no sandbox,** so it runs in patch mode there. If you force
  `--mode write`, the menu warns `⚠ force, no sandbox`, and your Claude Code permission settings may ask you to approve
  a worker that edits files with nothing confining it.
- **Copilot sessions can't be resumed**, and it reports no token usage.
- **Codex on Windows** runs in patch mode and cannot start a shell, so Claude runs its commands. A reply with no valid file blocks, or one that does not apply, is a failed attempt (exit 9) and goes back to the worker as a fix round.
- If a tool exits cleanly but changes no files when it should have, Claude records that. The model then shows
  `experimental: may not write on this machine` in the menu until a later run succeeds.
- If the repository has a rule against committing (in `CLAUDE.md` or `AGENTS.md`), Claude lands the work as
  uncommitted changes and says so.
- Each brief leaves your machine for that model's company. Claude puts in nothing you have not already shared with it,
  and never a secret or key.

Claude saves each task's test output in the run folder and will not record `Tests: passed` or `failed` without it. If
you edit your own folder on purpose during a run, Claude shows you the change and asks; only on your yes does it
`rebaseline` and carry on.

Run folders (briefs, replies, diffs, test logs, token use) are in `~/orchestrate-runs/<date>-<topic>/` (not under `~/.claude`: Claude Code refuses worker writes there). Set
`MMO_RUN_ROOT` to move them (a root inside `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, or reached through a link into one, is refused). To pick up an interrupted run, say "continue the orchestrate run".

## Where things go
| What | Where |
|---|---|
| Each round's brief, reply and the summary | `~/.claude/review-exchange/<date>-<topic>/` |
| Token use per round and running totals | `usage.jsonl` in that folder |
| Which models your account can use (learned as you go) | `~/.claude/multi-model-review/access.json` |
| Suggested models and the never-suggest list | `models.json` in the skill folder; edit freely |

## Good to know
- **Read-only:** reviewers get no shell and no write access; Claude puts the diff in the brief. If the repository
  changes during a round, the run stops.
- **Cursor is NOT read-only by default.** Its non-interactive mode can write files and run commands. The plugin runs
  it in **ask mode** (read-only), never with `--force`, and with its sandbox on macOS/Linux (the sandbox does not exist
  on Windows, where ask mode, Cursor's command allowlist and the working-tree check are the guard).
- **Gemini CLI** runs in `--approval-mode plan`, its read-only mode.
- **Dialogue mode uses more tokens.** Every exchange re-sends the conversation so far (mostly as cached tokens,
  which providers bill at a discount). Claude prints the running total after each exchange. Works with Codex, Claude,
  Cursor and Gemini; not Copilot yet. The read-only flags are passed again on every resumed turn.
- **Usage limits:** plans cap some models (Cursor's Pro plan caps API models such as Gemini per month). A capped model
  is skipped until you clear it; other models on the same tool keep working.
- **Token usage:** every round records the tokens it used in `usage` (input, cached and output where the tool reports
  them; Copilot reports none), and `totals` adds them up per review, so you see what a review really costs.
- **Your data:** each brief goes to that model's company. Claude keeps secrets, keys and customer data out of it.
- **Cost:** Codex and Claude bill to your own subscriptions. A Claude reviewer runs with only its read tools and none
  of your MCP servers, skills or plugins, about 12k input tokens a turn before the brief. Each Copilot CLI call carries a large built-in system
  prompt, so even short rounds use Copilot credits.
- **Tested:** Claude CLI, Cursor CLI, Codex CLI and Gemini CLI (API key) rounds on Windows (2026-10-19); dialogue
  mode with all four, including that a resumed session remembers earlier turns and still cannot write (2026-10-22).
  Copilot CLI support follows its documented flags.
