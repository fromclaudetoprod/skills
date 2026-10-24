# Worker tools: notes for `work`

Read the section for a tool before its first `work` call in a run. All tools run with the worktree as the folder,
write access to that folder only, and no push, deploy or commit. Flags are set by `workers.mjs`; do not add your own.

| Tool | Write mode | Shell for the worker | Resumes a session | Billing label |
|---|---|---|---|---|
| Codex | `exec -s workspace-write -C <worktree>`, MCP servers switched off | inside its own sandbox (may not start) | yes | `uses your ChatGPT plan` |
| Claude CLI | `-p` with Read, Grep, Glob, Edit, Write; edits auto-approved only inside the worktree (`acceptEdits`); no MCP, skills or user settings | none | yes | `uses your Claude limits (same budget as this session)` |
| Copilot | allow `write`, deny `shell` and `url` | none | no | `uses Copilot credits` |
| Gemini | `--approval-mode auto_edit` | none | yes | `⚠ API costs will apply` (needs `GEMINI_API_KEY`) |
| Cursor | `--force` | macOS/Linux: `--sandbox enabled`; Windows: none | yes | `uses your Cursor plan` |

## Codex
- The Windows sandbox could not start Codex's shell in the 2026-10-24 spike, so it cannot run tests. Claude runs
  every command. Do not expect `NEEDS:` lines to be answered by Codex itself.
- Codex may write through an MCP tool from the user's own Codex config. `work` passes `-c mcp_servers={}` to switch
  them off. If a Codex worker returns `changedFiles: []` while its reply claims edits, MCP-off may have left it unable
  to write: run `orchestrate.mjs record-write codex failed "<what happened>"` and offer another model.
- Session id is a thread id; resumed turns use `-c sandbox_mode=workspace-write` because `exec resume` has no `-s`.

## Claude CLI
- Shares the session's Claude budget. With a plan login it is not a way to save Claude usage; say so when the user is
  near their limit. On an API key the row shows `⚠ API costs will apply` and needs confirmation.
- Sessions are kept per folder. Resuming from a new worktree folder may exit 6; see `rework.md`.

## Copilot
- No resume. Every fix round is a fresh run with a new brief that carries the findings and the earlier diff.
- Reports no token usage; `usage` is null. The report says so.

## Gemini
- Needs `GEMINI_API_KEY`, so `needsConfirm` is true: ask the billing question every time. "Gemini" here is not
  Copilot's Gemini.
- Sessions are kept per project folder, same caveat as Claude.

## Cursor
- Print mode writes only with `--force`, which auto-approves everything the worker does.
- On Windows there is no sandbox, so the row carries `⚠ force, no sandbox`. Claude Code's own permission settings may
  stop or ask about the run (auto mode blocked a `--force` run in the spike). Tell the user what they are approving: a
  Cursor worker that edits files in its worktree and may run commands unconfined. Wait for the answer; never work
  around the prompt. If the user declines, offer another model.
- On macOS and Linux it runs with `--sandbox enabled` and no warning.

## Long paths on Windows
Worktrees live under `~/.claude/orchestrate/<date>-<topic>/wt/<id>/`, and a package install inside one
(`node_modules` nests deeply) can pass Windows' 260-character MAX_PATH limit. If an install fails on a long path, set
`MMO_RUN_ROOT=C:mmo` (a short root) and start the run again.

## When a tool cannot write
If a worker exits 0 but `changedFiles` is empty and its reply is not a legitimate "nothing to change":
`record-write <tool> failed "<note>"` marks it `experimental: may not write on this machine` in `menu` until a later
success is recorded with `record-write <tool> ok`. The review menu is unaffected.
