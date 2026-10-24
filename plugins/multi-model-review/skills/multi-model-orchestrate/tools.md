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
Verified live on Windows (2026-10-24): Codex gpt-6-luna and Cursor grok-4.7-medium both returned a diff that was applied in the worktree, with the outside-write probe not written; a resumed Codex session applied a follow-up diff. Copilot and Gemini workers and macOS/Linux are still untested. The live tests also found a bug, now fixed: Codex and Claude workers never received the worker instructions, because only the brief went to stdin. `work` now sends the instructions, then the brief, on stdin.

The worker runs read-only (Codex `-s read-only`, Cursor `--mode ask` without `--force`, Gemini `--approval-mode plan`)
and ends its reply with the COMPLETE new contents of every file it creates or changes, each between a `<<<FILE path=<p> code=<CODE>>>` line and a `<<<END <CODE>>>` line (`<<<DELETE path=<p> code=<CODE>>>` removes a file; no diffs, no abbreviating). After the last block it writes `<<<DONE code=<CODE> files=<N> deletes=<M>>>`; without it, or with wrong counts, the reply is rejected as possibly cut off. `<CODE>` is a fresh random 6-character code `work` makes for each call and puts in the ask, so file text containing ``` or anything else cannot be mistaken for a delimiter; backticks need no escaping. `work` builds the exact git diff itself (models get hunks wrong), keeping each file's line endings, refuses paths that are absolute, contain `..`, are inside `.git`, sit under a symlink or exceed 1 MB, then runs `git apply --check` and `git apply` in the worktree. Only these blocks are accepted (no ```file or ```diff fallback). A reply is rejected (exit 9) if any line starting `<<<FILE`, `<<<END` or `<<<DELETE` has a wrong or missing code (even inside a block), a block is unclosed, an END has no start, a path appears twice, the DONE line is missing or wrong, or there are no blocks. Any line that looks like a delimiter after stripping a BOM, spaces and backticks and normalizing width and case (`<<<` then FILE, END, DELETE or DONE) but is not exact is also rejected, so a file that has such a line cannot be written in patch mode (use write mode). patchError never contains the code, so it is safe to send back verbatim. An existing file keeps its final-newline state. An existing file with mixed CRLF and bare-LF endings is refused (edit it in write mode or normalize it first). Paths with a name ending in a dot or space, a name with `~<digits>` at its end or before an extension (Windows 8.3 short names such as `GIT~1` or `X~1.TXT`), a `:` in a name, or a Windows device name (con, prn, aux, nul, com1-9, lpt1-9, with or without an extension) are refused, as is any path whose real path differs from its spelling. `--context` cannot detect hard links, so a worktree must not contain them. `--context <path>` (repeatable, any tool or mode) appends a file's current contents (max 200 KB) to the brief. Default on Windows for Codex and Cursor; elsewhere those use
`--mode write`. Not available for Claude CLI and Copilot (exit 2). Exit 9 = no valid file blocks, or the reply was rejected or did not apply; `patchError`
says why. Fix rounds in patch mode tell the worker the folder already has its earlier change, so it re-sends complete files based on the current ones.

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
Worktrees live under `~/orchestrate-runs/<date>-<topic>/wt/<id>/`, and a package install inside one
(`node_modules` nests deeply) can pass Windows' 260-character MAX_PATH limit. If an install fails on a long path, set
`MMO_RUN_ROOT=C:\mmo` (a short root; the default `~/orchestrate-runs` is already short) and start the run again.

## When a tool cannot write
If a worker exits 0 but `changedFiles` is empty and its reply is not a legitimate "nothing to change":
`record-write <tool> failed "<note>"` marks it `experimental: may not write on this machine` in `menu` until a later
success is recorded with `record-write <tool> ok`. The review menu is unaffected.
