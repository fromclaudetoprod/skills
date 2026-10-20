# Multi-model review

Ask Claude Code for a review and it runs several rounds, each by a model from a different company. Claude writes
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

It only offers tools you have installed and, over time, only models your account can actually use.

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

If your Claude app says `/plugin` isn't available, run the same two steps in a terminal, then start a new chat
(or run `/reload-plugins`):
```
claude plugin marketplace add toddpick/fromclaudetoprod-skills
claude plugin install multi-model-review@from-claude-to-prod
```


## Use it
Say **"Run the multi-model review"**. Claude asks how many rounds (three is the default) and which model for each
round. Or say it all at once: *"Multi-model review of this branch, three rounds: grok-4.7, then gpt-6.1-sol, then
claude-opus-5-5."*

## Where things go
| What | Where |
|---|---|
| Each round's brief, reply and the summary | `~/.claude/review-exchange/<date>-<topic>/` |
| Which models your account can use (learned as you go) | `~/.claude/multi-model-review/access.json` |
| Suggested models and the never-suggest list | `models.json` in the skill folder; edit freely |

## Good to know
- **Read-only:** reviewers get no shell and no write access; Claude puts the diff in the brief. If the repository
  changes during a round, the run stops.
- **Cursor is NOT read-only by default.** Its non-interactive mode can write files and run commands. The plugin runs
  it in **ask mode** (read-only), never with `--force`, and with its sandbox on macOS/Linux (the sandbox does not exist
  on Windows, where ask mode, Cursor's command allowlist and the working-tree check are the guard).
- **Gemini CLI** runs in `--approval-mode plan`, its read-only mode.
- **Usage limits:** plans cap some models (Cursor's Pro plan caps API models such as Gemini per month). A capped model
  is skipped until you clear it; other models on the same tool keep working.
- **Token usage:** every round records the tokens it used (input and output for Claude, Cursor and Gemini; a total
  for Codex), and the final report adds them up, so you see what a review really costs.
- **Your data:** each brief goes to that model's company. Claude keeps secrets, keys and customer data out of it.
- **Cost:** Codex and Claude bill to your own subscriptions. Each Copilot CLI call carries a large built-in system
  prompt, so even short rounds use Copilot credits.
- **Tested:** Claude CLI, Cursor CLI, Codex CLI and Gemini CLI (API key) rounds on Windows (2026-10-19). Copilot CLI
  support follows its
  documented flags.
