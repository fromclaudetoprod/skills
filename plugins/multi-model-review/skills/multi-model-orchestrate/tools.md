# Worker tools: notes for `work`

Read the section for a tool before its first `work` call in a run. All tools run with the worktree as the folder,
write access to that folder only, and no push, deploy or commit. Flags are set by `workers.mjs`; do not add your own.

| Tool | Write mode | Shell for the worker | Resumes a session | Billing label |
|---|---|---|---|---|
| Codex | `exec -s workspace-write -C <worktree>`; your MCP servers and plugins switched off by name | inside its own sandbox. **Unsafe on Windows** | yes | `uses your ChatGPT plan` |
| Claude CLI | `-p` with Read, Grep, Glob, Edit, Write; edits auto-approved only inside the worktree (`acceptEdits`); no MCP, skills or user settings. Verified live on Windows: confined | none | yes | `uses your Claude limits (same budget as this session)` |
| Copilot | allow `write`, deny `shell` and `url`. Untested | none | no | `uses Copilot credits` |
| Gemini | `--approval-mode auto_edit`. Untested | none | yes | `⚠ API costs will apply` (needs `GEMINI_API_KEY`) |
| Cursor | `--force`. Works on Windows but is not confined there | macOS/Linux: `--sandbox enabled`; Windows: none | yes | `uses your Cursor plan` |

## Codex
- **Unsafe on Windows (live test 2026-10-24).** In the "elevated" sandbox Codex cannot write even inside the worktree.
  In the "unelevated" sandbox its `apply_patch` wrote a file outside the worktree. The row carries
  `⚠ Windows sandbox: may not write, or may write outside its folder`. Offer it only with that warning, say plainly
  what it means, and prefer another model. `outsideChanged` (exit 5) is the backstop, not a guarantee.
- The sandbox also cannot start Codex's shell on Windows, so Claude runs every command. Do not expect `NEEDS:` lines
  to be answered by Codex itself.
- `-c mcp_servers={}` does NOT switch the user's MCP servers off. `work` reads `CODEX_HOME/config.toml` and passes
  `-c mcp_servers.<name>.enabled=false` for each `[mcp_servers.<name>]` header and
  `-c plugins."<p>".enabled=false` for each `[plugins."<p>"]` header (plugin tools such as a JS REPL come from
  plugins), plus `-c web_search="disabled"`. A server that is not in that file is not switched off.
- If a Codex worker returns `changedFiles: []` while its reply claims edits, run
  `orchestrate.mjs record-write codex failed "<what happened>"` and offer another model.
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
- Verified live on Windows: it writes in its worktree, the session is captured and no approval prompt appeared. It is not confined there.
- On Windows there is no sandbox, so the row carries `⚠ force, no sandbox`. Claude Code's own permission settings may
  stop or ask about the run (auto mode blocked a `--force` run in the spike). Tell the user what they are approving: a
  Cursor worker that edits files in its worktree and may run commands unconfined. Wait for the answer; never work
  around the prompt. If the user declines, offer another model.
- On macOS and Linux it runs with `--sandbox enabled` and no warning.

## Long paths on Windows
Worktrees live under `~/.claude/orchestrate/<date>-<topic>/wt/<id>/`, and a package install inside one
(`node_modules` nests deeply) can pass Windows' 260-character MAX_PATH limit. If an install fails on a long path, set
`MMO_RUN_ROOT=C:\mmo` (a short root) and start the run again.

## When a tool cannot write
If a worker exits 0 but `changedFiles` is empty and its reply is not a legitimate "nothing to change":
`record-write <tool> failed "<note>"` marks it `experimental: may not write on this machine` in `menu` until a later
success is recorded with `record-write <tool> ok`. The review menu is unaffected.
