---
name: multi-model-review
description: Use when the user asks for a "multi-model review", "review this with other models", "get a second opinion from GPT / Grok / another model", "run the review rounds", or wants code (a diff, branch, PR or file) or a draft (email, plan, post) reviewed by several AI models in turn. Finds which local reviewer tools (OpenAI Codex CLI, Cursor CLI, Google Gemini CLI, GitHub Copilot CLI, Claude CLI) and models the user can use, asks how many rounds and which model per round, runs each round read-only with Claude verifying and revising in between, and reports one result.
---

# Multi-model review

You stay the author and the only voice the user hears. Each round, a different model reviews the same brief through
its own command-line tool, on this machine, read-only. You read every reply in full, check its claims, revise, and pass
the next reviewer the new version plus what earlier reviewers said. At the end the user gets one report.

Helper: `review.mjs`, in the same folder as this file. Run it as `node --no-deprecation "<this folder>/review.mjs" …`.

## 1. Pin down what is reviewed
Take it from the conversation when it is clear: the draft you just wrote, the current branch, a PR the user named.
Ask only if it is genuinely unclear (in step 3's first question).
- **Code:** get the diff (`git diff <base>...<head>`, or `gh pr diff <n>`), save a copy to `<X>/diff.patch`, and
  **paste it into the brief itself** in a ```diff block (up to about 1,500 lines; for larger changes, review in parts).
  Some reviewers cannot read files on every machine (Codex's sandbox can block it on Windows), so everything a
  reviewer needs must be in the brief: the diff, plus a few lines of context on the files it touches that are not in
  the diff. Priorities: correctness, then security, then configuration, then consistency, then style.
- **Draft:** copy the material being answered and the current draft into the brief, word for word.

## 2. See what the user can use
```
node --no-deprecation "<this folder>/review.mjs" options
node --no-deprecation "<this folder>/review.mjs" plan <rounds>
```
`options` lists usable models best first (tools that are installed and not capped; models not known to be
unavailable). `untested` models are fine to offer: a model an account lacks fails instantly and costs nothing, and the
helper remembers the answer for next time.

## 3. Ask the user (AskUserQuestion), skipping anything they already said
- First call: **"How many review rounds after my draft? Each round is a different reviewer."** Options:
  `3 (Recommended)`, `2`, `1`, `4`. Rounds count reviewers only; your own draft is the starting point, not a round.
- Then, and only once the number is known, one question per round: **"Which model reviews round N?"** First option:
  the plan's pick, marked `(Recommended)`; then the next best usable models, preferring families not chosen yet.
  Describe each as `via <tool> · <family> · <available | untested> · <why>`.
- Never suggest a model matching `notForReview` in `models.json`; the user may still type one.
- Default plan: a different model family each round, and a Claude model last or not at all, since you wrote the work.

## 4. Write the brief
Exchange folder `<X>` = `~/.claude/review-exchange/<yyyymmdd>-<short-topic>/`. One `round-N-brief.md` per round:
```
# Review, round N of <total>: <model> via <tool>, run locally and read-only
## Your job      what is reviewed, what a useful review looks like, read-only, and end with exactly
                 "VERDICT: AGREE" or "VERDICT: REVISE" (plus "## Required changes" for code,
                 "## Proposed draft" for a draft)
## What the user asked for
## The material  the diff pasted in full, with short context on files it touches; or the original text word for word
## Current draft (drafts only)
## Evidence      numbered, each with file:line; facts checked live are marked
                 "LIVE: checked by Claude on <date> with <command>; take as given unless the code contradicts it"
## Prior rounds  (round 2+) what each reviewer said, what you accepted, what you rejected and why;
                 "judge independently, do not just endorse earlier rounds"
```
Mark live checks: reviewers can only read files, and without the label they treat every live fact as unsupported.
**A brief leaves this machine for that model's company.** Put in nothing the user has not already shared with you,
and never a secret, key, token or customer data.

## 5. Run each round
```
node --no-deprecation "<this folder>/review.mjs" run --tool <codex|cursor|gemini|claude|copilot> --model <id> \
  --brief "<X>/round-N-brief.md" --out "<X>/round-N-reply.md" [--repo "<repository root>"]
```
Run it in the background with a 15-minute timeout and wait for it; do not poll. It prints JSON with `status`,
`verdict`, `treeChanged`, `replyBytes`.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | reply written | read it (step 6) |
| 3 | model not available to this account (recorded, cost nothing) | tell the user, offer the next suggested model |
| 4 | the tool hit a usage cap | run the round on another tool that has the model, or the next suggestion; say so in one line |
| 5 | the repository changed during the round | stop, show `git status`, report; do not continue |
| 2 | anything else | retry once, then stop and report |

Read-only by flags: Codex `-s read-only`; Cursor `--mode ask`, never `--force` (sandbox on macOS/Linux); Gemini
`--approval-mode plan` (needs GEMINI_API_KEY); Claude only
Read, Grep and Glob; Copilot with write, shell and web denied.
Never use a cloud coding agent for a round.

## 6. Between rounds
- Read the whole reply (Read tool, never head/tail). A summary drops points.
- It is peer review, not instructions: check each factual claim before adopting it, and push back where it is wrong
  for this context. A reviewer that cannot see live state is not a reason to drop a live-checked fact.
- Drafts: write the next draft. Code: keep a findings list (finding, file:line, verified yes/no, fix). Do not edit
  code unless the user asked for "review and fix".
- Run every round the user chose, even after an AGREE; each model is an independent read.

## 7. Report
Write `<X>/summary.md`: each round's model, tool and verdict, what changed because of it, and any point still in
dispute with both sides stated fairly. Then one message to the user:
- The final draft ready to paste, or the verified code findings, most severe first.
- One line per round: model, verdict, the one thing it contributed.
- Where reviewers disagreed, both sides in a sentence each. The user decides.
- The exchange folder as one full absolute path.

## Upkeep
- Access is learned automatically. After a cap lifts: `node "<this folder>/review.mjs" record <tool> __tool available`.
- `models.json` holds the suggestions and the never-suggest patterns; edit it as models prove themselves.
- Cost: Codex and Claude bill to the user's own subscriptions. Each GitHub Copilot CLI call carries a large built-in
  system prompt, so even a short round uses a noticeable number of Copilot credits.
