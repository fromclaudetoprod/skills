# Multi-model review

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
| You have | Reviewers you get |
|---|---|
| Claude Code + **Cursor** (simplest) | GPT, Grok, Gemini, Kimi, GLM and Claude models from one Cursor plan |
| Claude Code + **Gemini API key** | Gemini as the outside reviewer, Claude last |
| Claude Code + **Codex** (ChatGPT plan) | GPT models |
| Any mix of the above | the plugin picks a different company each round |

## Install
```
/plugin marketplace add toddpick/fromclaudetoprod-skills
/plugin install multi-model-review@from-claude-to-prod
```
Or copy `skills/multi-model-review` into `~/.claude/skills/`.

## Use it
Say **"Run the multi-model review"**. Claude asks which mode, shows the full numbered model list, then asks:
- **Panel:** how many rounds (three is the default) and which model for each round.
- **Dialogue:** which model to go back and forth with, and the most exchanges to allow (three is the default). It
  stops sooner if you agree or stop making progress.

Or say **"Go back and forth with grok-4.7 on this, five exchanges at most."** Or say it all at once: *"Multi-model review of this branch, three rounds: grok-4.7, then gpt-6.1-sol, then
claude-opus-5-5."*

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
- **Your data:** each brief goes to that model's company. Claude keeps secrets, keys and customer data out of it.
- **Cost:** Codex and Claude bill to your own subscriptions. A Claude reviewer runs with only its read tools and none
  of your MCP servers, skills or plugins, about 12k input tokens a turn before the brief. Each Copilot CLI call carries a large built-in system
  prompt, so even short rounds use Copilot credits.
- **Tested:** Claude CLI, Cursor CLI, Codex CLI and Gemini CLI (API key) rounds on Windows (2026-10-19); dialogue
  mode with all four, including that a resumed session remembers earlier turns and still cannot write (2026-10-22).
  Copilot CLI support follows its documented flags.
