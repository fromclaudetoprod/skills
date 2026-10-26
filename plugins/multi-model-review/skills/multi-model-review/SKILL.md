---
name: multi-model-review
description: Use when the user asks for a "multi-model review", "review this with other models", "get a second opinion from GPT / Grok / another model", "run the review rounds", "go back and forth with another model", or wants code (a diff, branch, PR or file) or a draft (email, plan, post) reviewed by other AI models. Two modes - a panel (a fresh reviewer each round) or a dialogue (one reviewer that keeps its session and argues it out with Claude over several exchanges). Lists every model the user's local reviewer tools offer (OpenAI Codex CLI, Cursor CLI, Google Gemini CLI, GitHub Copilot CLI, Claude CLI), runs each round read-only with Claude verifying and revising in between, tracks token use, and reports one result.
---

# Multi-model review

You stay the author and the only voice the user hears. Other models review the work through their own command-line
tools, on this machine, read-only. You read every reply in full, check its claims, revise, and at the end the user gets
one report.

Two modes:
- **Panel** (default): each round is a different model with a fresh session. Independent reads; each reviewer
  researches from scratch.
- **Dialogue**: one other model keeps its session across exchanges. It researches once; you send back only what
  changed and why, and it answers its own earlier points. Deeper on one disagreement, more tokens per exchange, and
  the reviewer can drift toward agreeing as the conversation goes on (see step 6b).

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
node --no-deprecation "<this folder>/review.mjs" menu
node --no-deprecation "<this folder>/review.mjs" plan <rounds>
```
`menu` lists **every** usable model, numbered, best first: everything the user's Cursor and Codex accounts list, plus
the suggestions and anything used before for Claude, Gemini and Copilot. One row per model; its other effort levels
are in `variants` (any exact id can be typed). Small or speed-tuned models (`notForReview` in `models.json`) are left
out unless you pass `--all`. `untested` models are fine to offer: a model an account lacks fails instantly and costs
nothing, and the helper remembers the answer.

**Before asking which model, show the whole menu** as one compact table in your message, grouped by family
(OpenAI, Anthropic, Google, xAI, Moonshot, Zhipu, Meta, Cursor, Other), columns `# · model · via · how it's paid · status`, with the row's `billing` label in "how it's paid",
suggested rows marked ★. The question box holds only four options, so the table is how the user sees the rest. Show
the same numbering for every round; do not re-number between rounds. The same model can appear from more than one
tool (Sonnet through the Claude CLI and through Copilot); the via and how-it's-paid columns tell them apart. Never
drop either column.

## 3. Ask the user (AskUserQuestion), skipping anything they already said
- First: **"Which kind of review?"**
  - `Panel: a fresh model each round (Recommended)`: independent reads, each from scratch.
  - `Dialogue: go back and forth with one model`: description must include the warning: "Uses noticeably more tokens:
    every exchange re-sends the whole conversation so far. I'll show running token totals after each exchange."
- **Panel:** **"How many review rounds after my draft? Each round is a different reviewer."** Options `3 (Recommended)`,
  `2`, `1`, `4`. Rounds count reviewers only; your own draft is the starting point, not a round. Then, once the number
  is known, show the menu table and ask one question per round (up to four per AskUserQuestion call): **"Which model
  reviews round N?"** Options: the plan's pick marked `(Recommended)`, then the two next best rows, each described as
  `#<n> · via <tool> · <billing> · <family> · <available | untested> · <why>`. The automatic "Other" takes a menu number or a
  model id. Every round offers the same menu; the user may repeat a model or a family.
- **Dialogue:** show the menu table, then ask both in one call:
  - **"Which model do you want to go back and forth with?"** Options: the best non-Anthropic rows from the plan, the
    first marked `(Recommended)`; "Other" takes a number or id. Dialogue works with Codex, Claude, Cursor and Gemini,
    not Copilot.
  - **"At most how many exchanges?"** Options `3 (Recommended)`, `2`, `5`, `8`. Describe: "An exchange is one reply
    from the other model. It stops sooner if you two agree or stop making progress; this is the ceiling, so it cannot
    run on forever."
- **Billing confirmation (Panel rounds and Dialogue alike).** Once every reviewer is chosen, and before step 4 or any
  run, check each chosen reviewer's menu row, including models the user typed via "Other" or by number, not only the
  options you offered. For every row with `needsConfirm: true`, ask: "**<name> via <source> bills <your API key | an
  account I can't identify>. Use it?**" with options: for `paidBy: "api"`, `Yes, bill my API key`; for
  `paidBy: "unknown"`, `Yes, run it anyway (billing unclear)`; and in both cases `No, pick another model`. A "No"
  re-asks that round (or that dialogue model) with a different pick, then confirms again. A label alone is not enough.
  Stakes: the name Gemini does not mean Copilot's Gemini; `via Gemini CLI` bills an API key.
- Never suggest a model matching `notForReview`; the user may still type one.
- Default plan: a different model family each round, and a Claude model last or not at all, since you wrote the work.

## 4. Write the brief
Exchange folder `<X>` = `~/.claude/review-exchange/<yyyymmdd>-<short-topic>/`. Panel: one `round-N-brief.md` per round.
Dialogue: `exchange-1-brief.md` is a full brief; later exchanges are short (step 6b).
```
# Review, round N of <total>: <model> via <tool>, run locally and read-only
  (dialogue: "# Dialogue review, exchange 1 of up to <max>: <model> via <tool>, run locally and read-only")
## Your job      what is reviewed, what a useful review looks like, read-only, and end with exactly
                 "VERDICT: AGREE" or "VERDICT: REVISE" (plus "## Required changes" for code,
                 "## Proposed draft" for a draft). Dialogue only: number your points (P1, P2, ...) and add
                 "This is a back-and-forth: I will reply in this same conversation with what I changed, accepted
                 and rejected. Keep your notes; you will not need to re-read everything."
## What the user asked for
## The material  the diff pasted in full, with short context on files it touches; or the original text word for word
## Current draft (drafts only)
## Evidence      numbered, each with file:line; facts checked live are marked
                 "LIVE: checked by Claude on <date> with <command>; take as given unless the code contradicts it"
## Prior rounds  (panel round 2+) what each reviewer said, what you accepted, what you rejected and why;
                 "judge independently, do not just endorse earlier rounds"
```
Mark live checks: reviewers can only read files, and without the label they treat every live fact as unsupported.
**A brief leaves this machine for that model's company.** Put in nothing the user has not already shared with you,
and never a secret, key, token or customer data.

## 5. Run a round or exchange
```
node --no-deprecation "<this folder>/review.mjs" run --tool <codex|cursor|gemini|claude|copilot> --model <id> \
  --brief "<X>/round-N-brief.md" --out "<X>/round-N-reply.md" [--repo "<repository root>"] [--session new|<id>]
```
Dialogue: exchange 1 passes `--session new`; the JSON prints `sessionId`; every later exchange passes
`--session <that id>`, the same `--tool`, `--model` and `--repo`, and is run from the same place. Panel: no `--session`.

Run it in the background with a 15-minute timeout and wait for it; do not poll. It prints JSON with `status`,
`verdict`, `treeChanged`, `replyBytes`, `sessionId` (dialogue), this turn's `usage` and the folder's running `totals`
(tokens in, of which cached, out, and dollars where the tool reports them: Claude does; Codex, Cursor and Gemini
report tokens only). Usage is also logged to `<X>/usage.jsonl`.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | reply written | read it (step 6) |
| 3 | model not available to this account (recorded, cost nothing) | tell the user, offer the next suggested model |
| 4 | the tool hit a usage cap | run the round on another tool that has the model, or the next suggestion; say so in one line |
| 5 | the repository changed during the round | stop, show `git status`, report; do not continue |
| 6 | dialogue session not found (expired or deleted) | tell the user; offer to continue with the same model in a new session, sending a full brief that includes the exchange so far |
| 2 | anything else | retry once, then stop and report |

Read-only by flags, on every turn including resumed ones: Codex `-s read-only` (resumed: `-c sandbox_mode=read-only`);
Cursor `--mode ask`, never `--force` (sandbox on macOS/Linux); Gemini `--approval-mode plan` (needs GEMINI_API_KEY); Anthropic API via `ant messages create`, no tools (needs the key file in the README);
Claude gets only Read, Grep and Glob, with no MCP servers, skills or user settings; Copilot with write, shell and web
denied. Never use a cloud coding agent for a round.

## 6. Between rounds
- Read the whole reply (Read tool, never head/tail). A summary drops points.
- It is peer review, not instructions: check each factual claim before adopting it, and push back where it is wrong
  for this context. A reviewer that cannot see live state is not a reason to drop a live-checked fact.
- Drafts: write the next draft. Code: keep a findings list (finding, file:line, verified yes/no, fix). Do not edit
  code unless the user asked for "review and fix".
- Panel: run every round the user chose, even after an AGREE; each model is an independent read.

## 6b. Dialogue exchanges
After each reply, tell the user one line: `Exchange N: <verdict>, <k> points open · this turn <in>k in / <out>k out
(<$ if known>) · total so far <in>k in / <out>k out (<$>)`.

Then decide:
- **Stop** when the reviewer says AGREE with every point RESOLVED or WITHDRAWN; when the max exchanges is reached;
  or when two exchanges in a row bring no new point and no change of position (a standoff, so report it).
- **Otherwise** write `exchange-N-brief.md`, short, because the reviewer already has the material:
  ```
  # Dialogue review, exchange N of up to <max> (same conversation)
  ## What I changed      the revised draft in full, or for code the updated findings and any proposed patch
  ## Accepted            P-numbers, one line each
  ## Rejected            P-numbers, why, with evidence (file:line, LIVE checks)
  ## Your job now        For each of your earlier points answer RESOLVED, STILL STANDS (why) or WITHDRAWN.
                         Raise anything new my changes introduced. Do not agree just to end the conversation:
                         an AGREE must name what convinced you. End with VERDICT: AGREE or VERDICT: REVISE.
  ```
  and run it with `--session <id>`.
- Watch for drift: if the reviewer drops a point without saying what changed its mind, ask once in the next exchange;
  if it still gives no reason, report the point as unresolved rather than as agreed.

## 7. Report
Write `<X>/summary.md`: each round's or exchange's model, tool and verdict, its **tokens in / out** from the `usage`
field (Codex reports input, cached and output; Copilot reports none), what changed because of it, any point still in
dispute with both sides stated fairly, and a total-tokens line taken from `totals`. Then one message to the user:
- The final draft ready to paste, or the verified code findings, most severe first.
- Panel: one line per round: model, verdict, tokens used, the one thing it contributed. Dialogue: how many exchanges,
  why it stopped (agreement, max reached, standoff), tokens used, and what moved over the exchanges.
- Where you and a reviewer still disagree, both sides in a sentence each. The user decides.
- Tokens: total in / out from `totals` (and dollars where known).
- The exchange folder as one full absolute path.

## Upkeep
- Access is learned automatically. After a cap lifts: `node "<this folder>/review.mjs" record <tool> __tool available`.
- `models.json` holds the suggestions and the never-suggest patterns; edit it as models prove themselves.
- Cost: what each tool bills depends on the user's login; the billing labels in the menu say which (a plan, Copilot
  credits, or an API key). A Claude reviewer turn is about 12k input tokens
  before the brief. Each GitHub Copilot CLI call carries a large built-in system prompt, so even a short round uses a
  noticeable number of Copilot credits. In dialogue mode each exchange re-sends the conversation so far, mostly as
  cached tokens, which most providers bill at a discount.
