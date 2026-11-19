# Check gate for multi-model-orchestrate (1.6.0)

**Why:** a task whose tests fail still reaches the reviewer today, so a review is paid for code that is known to be
broken, and the "tests must pass" rule lives only in SKILL.md prose. Step 1 of three (then: reviewers routed by what
changed; one work item in, one PR out, Azure DevOps or GitHub).

## Decided
- **Optional checks file** in the user's repo: `.orchestrate/checks.json`, e.g.
  `{ "checks": [ { "name": "tests", "run": "npm test" }, { "name": "lint", "run": "npm run lint" } ], "timeoutMinutes": 20 }`.
  Without it the manager passes the detected test command(s) with `--cmd` (repeatable), so every repo keeps working.
- **New command** `orchestrate.mjs check --run <run> --id <id> [--cmd "<command>"]...` runs every check in the task
  worktree (stops at the first failure), writes the combined output to `<run>/tests/<id>.log` (where `commit` already
  looks), records the result and a fingerprint of the worktree in the ledger, and prints JSON. Exit 0 passed,
  11 failed, 2 usage error (no checks file and no `--cmd`).
- **Fail goes straight back to the builder** with the log, as a fix round. No review is run on a failed check.
- **Enforced in code:** once a check has run for a task, `commit` refuses (exit 7) unless the last check passed *and*
  the worktree is unchanged since that check (a worker edit after the check needs a new check). `--override "<reason>"`
  commits anyway and adds a `Checks-override: <reason>` trailer. `--tests` is then taken from the check result.
- A task with no check run behaves as today (back-compatible for runs started on 1.5.0).

## My calls (builder's)
- The checks file is read from the **user's repo folder**, never from the task worktree, so a worker cannot rewrite
  its own gate (e.g. change `npm test` to `echo ok`).
- Folder name `.orchestrate/` rather than `.claude/`, because Codex can manage runs too.
- Commands run through the shell (they are the user's own lines), with the worktree as the working folder, a
  per-check timeout (default 20 minutes) and output capped in the log at 2 MB.

## Approaches considered
- Prose only (today): leaks, nothing enforces it. Rejected.
- Required checks file: breaks every repo without one. Rejected.
- Optional file + `--cmd` fallback + commit enforcement: chosen.
