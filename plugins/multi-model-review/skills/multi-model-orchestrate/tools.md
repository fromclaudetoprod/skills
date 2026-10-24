# Worker tools: notes for `work`

Read the section for a tool before its first `work` call in a run. All tools run with the worktree as the folder,
write access to that folder only, and no push, deploy or commit. Flags are set by `workers.mjs`; do not add your own.

| Tool | Write mode (`--mode write`) | Shell for the worker | Resumes a session | Billing label |
|---|---|---|---|---|
| Codex | `exec -s workspace-write -C <worktree>`; your MCP servers and plugins switched off by name | inside its own sandbox. **Unsafe on Windows: use patch mode** | yes | `uses your ChatGPT plan` |
| Claude CLI | `-p` with Read, Grep, Glob, Edit, Write; edits auto-approved only inside the worktree (`acceptEdits`); no MCP, skills or user settings. Verified live on Windows: confined | none | yes | `uses your Claude limits (same budget as this session)` |
| Copilot | allow `write`, deny `shell` and `url`. Untested | none | no | `uses Copilot credits` |
| Gemini | `--approval-mode auto_edit`. Untested. Patch mode: `--approval-mode plan` | none | yes | `⚠ API costs will apply` (needs `GEMINI_API_KEY`) |
| Cursor | `--force`. Works on Windows but is not confined there: use patch mode | macOS/Linux: `--sandbox enabled`; Windows: none | yes | `uses your Cursor plan` |

## Patch mode
The worker runs read-only (Codex `-s read-only`, Cursor `--mode ask` without `--force`, Gemini `--approval-mode plan`)
and ends its reply with one unified diff in a ```diff block. `work` takes the last such block, rejects it if any path
is absolute, contains `..`, is inside `.git`, leaves the folder through a rename or copy, or is a symlink, then runs
`git apply --check` and `git apply` in the worktree. Default on Windows for Codex and Cursor; elsewhere those use
`--mode write`. Not available for Claude CLI and Copilot (exit 2). Exit 9 = no diff or it did not apply; `patchError`
says why. Fix rounds in patch mode tell the worker the folder already has its earlier change, so it diffs against the
current files.

## Codex
- **Write mode is unsafe on Windows (live test 2026-10-24):** the "elevated" sandbox cannot write even inside the
  worktree, and in the "unelevated" one `apply_patch` wrote outside it. So it defaults to patch mode there. The
  menu's `writeWarnings` (`⚠ Windows sandbox: may not write, or may write outside its folder`) apply only if the user
  overrides with `--mode write`; then prefer another model. `outsideChanged` (exit 5) is the backstop, not a guarantee.
- The sandbox also cannot start Codex's shell on Windows, so Claude runs every command. Do not expect `NEEDS:` lines
  to be answered by Codex itself.
- `-c mcp_servers={}` does NOT switch the user's MCP servers off. `work` reads `CODEX_HOME/config.toml` and passes
  `-c mcp_servers.<name>.enabled=false` for each `[mcp_servers.<name>]` header and
  `-c plugins."<p>".enabled=false` for each `[plugins."<p>"]` header (plugin tools such as a JS REPL come from
  plugins), plus `-c web_search="disabled"`. A server that is not in that file is not switched off.
- If a Codex worker returns `changedFiles: []` while its reply claims edits, run
  `orchestrate.mjs record-write codex failed "<what happened>"` and offer another model.
- Session id is a thread id; resumed turns use `-c sandbox_mode=workspace-write` (patch mode: `read-only`) because `exec resume` has no `-s`.
- `isolationSkipped` in the `work` output lists MCP servers or plugins whose names could not be passed safely; they stay enabled.

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
- Print mode writes only with `--force`, which auto-approves everything the worker does and has no sandbox on Windows
  (it did write in its worktree in the live run, but is not confined).
- So on Windows it defaults to patch mode: `--mode ask`, never `--force`. The `writeWarnings` (`⚠ force, no sandbox`)
  apply only if the user overrides with `--mode write`; then Claude Code's own permission settings may stop or ask
  about the run. Tell the user what they are approving, wait for the answer, never work around the prompt.
- On macOS and Linux it runs `--force` with `--sandbox enabled` and no warning.

## Long paths on Windows
Worktrees live under `~/.claude/orchestrate/<date>-<topic>/wt/<id>/`, and a package install inside one
(`node_modules` nests deeply) can pass Windows' 260-character MAX_PATH limit. If an install fails on a long path, set
`MMO_RUN_ROOT=C:\mmo` (a short root) and start the run again.

## When a tool cannot write
If a worker exits 0 but `changedFiles` is empty and its reply is not a legitimate "nothing to change":
`record-write <tool> failed "<note>"` marks it `experimental: may not write on this machine` in `menu` until a later
success is recorded with `record-write <tool> ok`. The review menu is unaffected.
