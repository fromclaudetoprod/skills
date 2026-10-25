# Building the multi-model orchestrator - Field Journal

A running record of how the multi-model orchestrator got built, written for someone who does not write code. It is raw material for a future show-and-tell.

- **The thing:** Claude Code splits a plan into tasks, other companies' models do the work in separate folders, and Claude checks each task before it lands on my branch.
- **Who built it:** Todd. On the build day, a Sonnet agent wrote each task and a second Sonnet agent reviewed it. The first real run then used Codex, Cursor, and the Claude CLI.
- **Dates:** The itch was 2026-10-23. The skill was built and first used on 2026-10-24.

---

## 1. The itch

On 2026-10-23 I ran a 14-task plan, the event sponsorship feature on MyCreditPlan, and I ran out of Claude tokens partway. I would have loved to say just give this to other models so you can just orchestrate and not stop halfway through when you run out of credits.

Blake, the scrum master pushing AgentParley.org, ran out of Claude tokens the same week and wished he could have offloaded the work to Codex. Claude Code on its own can only hand work to Claude subagents, and those spend the same budget. I started calling the pain "stop halfway".

| Who is stuck | What they do | What it costs |
|---|---|---|
| Todd, 2026-10-23 | A 14-task plan (event sponsorship, MyCreditPlan). Claude stops partway. | The rest of the plan waits. Money: [fill in]. |
| Blake, same week | Wants AgentParley.org work offloaded to Codex when Claude tokens run out. | [fill in] |
| Claude Code alone | Can hand work only to Claude subagents. | The same Claude budget I had just emptied. |

**Lesson:** The wall was Claude's budget, not the lack of a plan.

---

## 2. What already exists

The review skill was already in the plugin. Several models from different companies read code or a draft in turn, and they do not change it. Claude checks every claim. Panel mode starts a fresh reviewer each round. Dialogue mode lets one reviewer keep its session. The tools are Codex CLI, Cursor CLI, Gemini CLI, GitHub Copilot CLI, and Claude CLI. That skill can judge. It cannot finish a plan.

Parley, my hosted room where agents from different people talk, stays read-only on purpose. It decides. My machine does the work. Before this orchestrator, nothing in that picture could take the next task and write it without spending more of the same Claude session.

The plugin is public, from From Claude to Prod (fromclaudetoprod.dev). The repo is `fromclaudetoprod/skills`, folder `plugins/multi-model-review`, version 1.3.0, MIT. Install is `/plugin marketplace add fromclaudetoprod/skills` then `/plugin install multi-model-review@from-claude-to-prod`. The orchestrate skill is the second skill in that plugin.

**Lesson:** A reviewer that cannot write still leaves the plan on the one budget that just ran out.

---

## 3. The idea in one sentence

Claude splits a plan into tasks, recommends who should do each one, and after I approve, those agents write the code in their own folders. Claude runs the tests, commits each task, and lands the run on my branch.

It is not a pile of Claude subagents, because those share this session's budget. It is not Parley, because Parley stays read-only. It is not me copying answers between windows. Rework can go back to the same agent's session later.

**Lesson:** The orchestrator keeps the gate. The workers do not touch my folder until land.

---

## 4. The decisions

| Decision | Choice | Why |
|---|---|---|
| Who writes | 0 to 4 agents per task, a model each, marked light, standard, or heavy | I approve the lineup. Claude subagents would spend the budget I had just lost. |
| Who signs off | "This Claude session" or "Other models: I'm close to my Claude limit" | The gate has to be someone who still has budget. |
| Where the work sits | One private run branch, one git worktree per agent | Nothing touches my folder until land. |
| What each model row shows | Where the model comes from, and how it is paid | The labels I have are "uses your ChatGPT plan", "uses your Claude limits (same budget as this session)", and "⚠ API costs will apply". API-key models need an explicit yes first. |
| Windows writes | Patch mode for Codex and Cursor | Their own sandboxes were not safe. Unelevated Codex wrote a file outside its folder. Elevated Codex could not write at all. Cursor can only write with --force, and it has no sandbox. |
| How patch mode writes | The worker is read-only and returns complete files between random-code markers. A script builds an exact patch. Git applies it. | Path checks, git's own checks, NTFS/HFS protection, and a symlink check with rollback. Adversarial reviewers tried 25+ escape diffs. None got out. |
| How big one task may get | Light 150k, standard 400k, heavy 1M | The worker is not run again until I decide. The first real run is why this exists. |
| What a surprise looks like | A fingerprint of my repo before and after every worker call: status, diff, and untracked content | Any change outside the worktree stops the run (exit 5). |
| How a run finishes | Merge, squash, or uncommitted | Land refuses if I have staged changes, if I switched branch, or if I edited a file the run changed. |

**Lesson:** The safety design held every time: every bug stopped at a checkpoint before reaching real code.

---

## 5. How it was built

It was one day, 2026-10-24. Brainstorm, then a spec, then a builder check, then a 10-task plan. I used subagent-driven development: a Sonnet implementer and a Sonnet reviewer on every task, fix rounds, a final whole-branch review, then a final fix wave.

Tests went from 0 to 163 node:test tests, with zero dependencies. The tests use real temp git repos, including folders with spaces in the name, and stub CLIs on PATH. Plugin commits that day: about 40 [fill in exact].

Reviews and live tests found real bugs, and all of these were fixed:

- Landing could throw away staged work.
- The outside-change check missed a re-edit of a file that was already dirty.
- On macOS and Linux, paths were passed with literal quotes. The same bug was in the existing review skill.
- Codex and Claude workers never actually received their instructions.
- Codex could not read files in its Windows read-only sandbox.
- Models wrote diffs that git would not accept.
- Markdown fences inside files confused the parser.
- Claude CLI refuses to write under ~/.claude.
- A symlink-mode spelling (0120000) could slip a filter.

**Lesson:** Checkpoints are where the bugs stopped. The list is long because the checks were there.

---

## 6. The first run

The first real run was the same day, 2026-10-24. The job was Parley's "/work" page: the page that says Parley decides and my machine does the work. Three tasks, three vendors. Two of them ran at the same time.

| Task | Work | Who | Fix rounds |
|---|---|---|---|
| 1 | Page component and test | GPT-6-Sol via Codex | 3, then Claude finished one line |
| 3 | Nav and the /security link | Grok 4.7 Medium via Cursor | 1 |
| 2 | Route | Claude Haiku 5.5 via Claude CLI | 0 (Claude CLI refused to write under ~/.claude, so Claude saved its file as written) |

The result was 3 commits on the Parley branch `work-page`, each naming its agent. All 216 Parley unit tests passed. The run also found that Parley's .tsx tests had never been running.

| Worker | Tokens, as recorded |
|---|---|
| Codex, GPT-6-Sol | 1,711k input (1,492k cached) / 32k output |
| Grok 4.7 Medium via Cursor | 210k / 15k |
| Claude Haiku 5.5 via Claude CLI | 60k / 2k |

97% of the worker tokens were off Claude's budget. For a job this small, it was not worth it. The total was several times more than Sonnet subagents would have used (est. 250-400k). It also used up my ChatGPT allowance for the day. That run is why the token budget exists.

What this run did not prove: that a medium task is cheaper or faster than a Sonnet subagent, that Copilot or Gemini can take a worktree, or that macOS and Linux are safe. Those are still untested.

Later runs, after the fixes, are separate. Grok via Cursor edited a CRLF README that contained fenced code blocks, created a file, and deleted one, on the first try, at 69k tokens. Grok built the token-budget feature itself (1,375k input on Cursor credits), Cursor's Composer reviewed it, and the website plugin page was updated.

**Lesson:** Only a real run on a real codebase finds the real problems.

---

## 7. What it costs

Orchestrating spends the workers' budgets so this Claude session can keep going. It does not spend fewer tokens overall. The agent CLIs re-send the whole context on every internal step.

| Piece | Cost |
|---|---|
| Codex on the first run | 1,711k input (1,492k cached) / 32k output. It used up the day's ChatGPT allowance. Dollars: [fill in]. |
| Grok on the first run | 210k / 15k. Dollars: [fill in]. |
| Haiku on the first run | 60k / 2k. This one uses Claude limits, the same budget as the session. |
| A small job done by Sonnet subagents | est. 250-400k. Not a measurement from this run. |
| Share of worker tokens off Claude's budget | 97% on the first run. |
| Later README edit by Grok | 69k tokens. |
| Later token-budget feature by Grok | 1,375k input on Cursor credits. Cursor's Composer reviewed it. |
| Plugin | Version 1.3.0, MIT. Price to install: [fill in]. |
| Caps after that first run | Light 150k, standard 400k, heavy 1M. Then I decide whether to run again. |

**Lesson:** Orchestrating saves Claude usage, not total tokens: agent CLIs re-send the whole context on every internal step.

---

## 8. What is next

- Let Codex be the orchestrator. Codex reads the same SKILL.md format.
- Run a fair comparison: the same medium task, a Sonnet subagent against an orchestrated lineup.
- Try Copilot and Gemini as workers. Untested.
- Try macOS and Linux. Untested. The Windows path is the one the live sandbox test forced into patch mode.
- Push the plugin and the website. Not yet pushed.
- The ask for the talk: [fill in: Todd decides; suggestion: "Install it, orchestrate one real plan, and send me your token numbers."]

Small or chained jobs are cheaper in one loop. I orchestrate when Claude's limit is the constraint, or when tasks truly run in parallel. Anthropic's 2026-10-22 article "When to fold subagents into your main agent loop" agrees: subagents are for context, parallel work, and verification.

**Lesson:** Fold first: small or chained jobs are cheaper in one loop; orchestrate when Claude's limit is the constraint or tasks truly run in parallel.
