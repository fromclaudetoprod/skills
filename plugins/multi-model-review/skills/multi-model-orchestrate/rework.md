# Rework, fix rounds and resume

Read this only when sending work back to a worker, resuming a run, or reworking a committed task.

## Fix round inside a run
The worker's worktree is still there. Write a new brief `<run>/briefs/t1/fix<n>.md` (beside the task's `brief.md`) that carries, verbatim: the
reviewer's findings (or yours) and the failing test output. Do not summarize either. Add the worktree path and "edit
files only in this folder; do not commit". Then:
```
node --no-deprecation "<this folder>/orchestrate.mjs" work --tool <tool> --model <id> --repo "<repository root>" \
  --worktree "<wt>" --brief "<run>/briefs/t1/fix<n>.md" --out "<run>/replies/t1-r<n+1>.md" --session <id>
```
- `<id>` is the task's stored `session` (codex, claude, cursor, gemini). Use the same tool and model.
- Copilot (no sessions): omit `--session`; the new brief must also carry the task text and the diff so far.
- Exit 6 (session not found, expired or deleted): tell the user in one line and rerun with the same model and
  `--session new`, with a brief that carries the original task text, the earlier diff and the findings.
- Each fix round updates `task --set fixRounds=<n>`. Setup-caused failures do not count.
- In patch mode (`work` printed `mode: "patch"`), add one line to the fix brief: "The folder already contains your earlier change; send the complete new contents of every file you change in the `<<<FILE ... code=...>>>` / `<<<END ...>>>` blocks from the ask, based on the current files." If the earlier diff did not apply (exit 9), send `patchError` verbatim instead, and tell the worker to re-send complete files.

## Conflict at commit
When `commit` exits 7 with files listed: `discard --run "<run>" --id t1`, then `worktree --run "<run>" --id t1` (a
fresh worktree from the new run tip), then a brief with the conflicting files (current contents on the run branch),
the worker's earlier diff (`<run>/diffs/t1.patch`), and "redo this change on top of these files". Start with
`--session <id>` if the tool has one; Claude and Gemini key sessions by folder, so fall back to the exit 6 route.

## Resume a run
`status --run "<run>"` prints the ledger plus `runTip` and `tipMatches`. If `tipMatches` is false, the run branch was
moved by someone else: stop and show `runTip`, `base` and each passed task's `commit`. Otherwise:
- `passed` tasks are done; `stalled` and `pending` tasks continue; `running` tasks: `discard` first, since their
  worktree state is unknown, then start again.
- For a task stalled by a usage cap, offer the next menu row that suits its size. Changing the worker means
  `task --set worker=… --set tool=… --set model=…` and a fresh session (`--session new`); the old session belongs to
  the old tool.
- Re-run `menu` first: availability and caps change.

## Rework a committed task later
"Send Task 3 back to its agent: the date check is wrong."
1. Find the task's commit and read its trailers: `git log -1 --format=%B <sha>` gives `Implemented-by:`,
   `Worker-session: <tool> <id>`, `Fix-rounds:`. The run's ledger has the same.
2. If the run is landed, start a new run from the user's current branch (`start`) so the rework has its own run
   branch and worktrees; record a task `t3-rework` with the same worker, tool, model and session.
3. `worktree --run "<run>" --id t3-rework`, run setup in it.
4. Brief at `<run>/briefs/t3-rework/brief.md`: the new folder path, what to change (the user's words verbatim), the original
   task text and the commit's diff (`git show <sha>`), the test command.
5. `work ... --worktree "<new wt>" --session <id>` with the same tool and model.
6. Gate as usual, then `commit --run "<run>" --id t3-rework --tests <…> --rework-of <sha>`.
7. No session (Copilot), or exit 6: the same model, fresh (`--session new` where supported), with the original diff
   and the findings in the brief. Say so to the user.
