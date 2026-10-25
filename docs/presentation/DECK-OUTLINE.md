# Multi-model orchestrator deck outline

Nine slides, about [fill in] minutes. Built in the Night Shift theme from `C:\VideoMaker\Decks\src\shell.html` (1920x1080 stage, ink #0A0C10, vellum text, Big Shoulders headlines, Instrument Serif italic punch lines, IBM Plex Mono eyebrows). Each slide is a `<section class="s">` with `.eyebrow`, `.h1` or `.h2`, `.lede`, `.punch` and an `<aside class="note">`. Nothing here has been built or generated. Suggested slug when this is wired into `C:\VideoMaker\Decks\build.py`: `05-orchestrate`. Confirm the number. This outline does not edit `build.py`.

## Title options

1. **One plan. Many *models*.**
2. Don't stop *halfway*.
3. Conduct the *lineup*.

**Pick: "One plan. Many *models*."** It is short, it fits a Big Shoulders line, and it says what the product is.

## Accent colour

`--accent: #EE8558` (Claude Code orange lightened). Claude Code's orange is a darker terracotta. On the #0A0C10 stage that darker value sits at the bottom of the readable range and looks dull next to vellum, so the deck uses #EE8558 at 64% lightness (the band to aim for is 60 to 75%). Suggested `--accent-ink: #2A120A` for text on accent fills. Red (`--bad`, #FF6B6B) appears once, on the fingerprint stop (exit 5). The trailer's orange starburst is the same family, so the deck and the film match. Image prefix: `or`.

## Demo moment

Slide 6 is the demo. Play a recording: the three commits on the Parley branch `work-page`, and the token table below. Do not run a tiny plan live. The honest verdict of the first run is that a job this small is not worth it, and a live tiny plan would hide that. Fallback if the recording is missing: walk the token table on this slide and read the verdict out loud. Before the talk, run the comparison this first run did not do: the same medium task, a Sonnet subagent against an orchestrated lineup. Do not demo Copilot, Gemini, or macOS/Linux. They are untested.

---

## 1. Hero title

- **Archetype:** Hero title with background image.
- **Eyebrow:** Multi-model orchestrator
- **Headline:** One plan. Many *models*.
- **Body:** Title slide. Byline under the punch: Todd Pickering.
- **Lede or punch:** "Conduct the plan. Don't stop halfway."
- **Image or mock:** Wide night-office frame of the small white robot alone at a desk, credits fading. Prompt is shot 1 in [TRAILER.md](TRAILER.md). When the deck is built, copy that prompt to `orchestrate-title.md`. Save the still as `img/or-title.jpg`.
- **Speaker notes:** I built this on 2026-10-24 because the day before I ran out of Claude tokens halfway through a 14-task plan. The plugin is multi-model-review, version 1.3.0, and the new skill is multi-model-orchestrate. By the end I will ask you for one thing. Next is the day I got stuck.

## 2. The itch

- **Archetype:** Three-column before/after.
- **Eyebrow:** The day before
- **Headline:** I stopped *halfway*.
- **Body:** Three columns.
  - My plan: "2026-10-23. Fourteen tasks, event sponsorship on MyCreditPlan. Claude tokens ran out partway."
  - Blake: "Same week. AgentParley.org. He wanted the rest of the work on Codex."
  - The trap (hot column): "Claude Code can only hand work to Claude. Same budget."
- **Lede or punch:** "Stop halfway."
- **Image or mock:** None required. Optional faint frame from trailer shot 2, a robot handing a blank page to copies of itself that fade. Prompt file when built: `orchestrate-itch.md`. Save as `img/or-itch.jpg`.
- **Speaker notes:** I had a plan and I could not finish it, because the only helpers I could call spent the same Claude budget. Blake hit the same wall the same week and wanted Codex. The agents were not out of ideas. I was out of credits. What if this session only conducted?

## 3. The cost of the itch

- **Archetype:** Statement quote.
- **Eyebrow:** Stop halfway
- **Headline:** Same budget. Same *stop*.
- **Body:** Serif quote, one accent word: "Just give this to *other* models, and orchestrate."
- **Lede or punch:** "So you do not stop halfway when the credits run out."
- **Image or mock:** None, CSS only. Optional dim background from trailer shot 2.
- **Speaker notes:** That sentence is what I wanted to be able to say on 2026-10-23. Copying between windows would have kept me as the cable. More Claude subagents would have spent the same account. The cost of the itch is a plan that stops when one vendor's limit stops. Next is the sentence turned into a lineup.

## 4. The idea in one line

- **Archetype:** Terminal mock.
- **Eyebrow:** The idea
- **Headline:** Give it to *others*.
- **Body:** CSS terminal, the first run's lineup, not a made-up one.
  - `Lineup  (you approve)`
  - `Task 1  page + test   GPT-6-Sol via Codex           uses your ChatGPT plan`
  - `Task 3  nav           Grok 4.7 Medium via Cursor    uses your Cursor plan`
  - `Task 2  route         Haiku 5.5 via Claude CLI      uses your Claude limits (same budget as this session)`
  - `Sign-off: This Claude session`
  - `// two of the three ran at the same time`
- **Lede or punch:** "Claude conducts. Other models build. Your folder waits until land."
- **Image or mock:** CSS terminal only, as in the worktrees deck. No screenshot.
- **Speaker notes:** I approve a lineup of up to four agents, and every row says how that model is paid. API-key models need an explicit yes. The Cursor billing label on the menu is [fill in], so I will not invent it on the slide. Sign-off is this Claude session, or other models if I am close to my Claude limit. Next is where the files actually go.

## 5. How it works

- **Archetype:** Diagram slide, full-bleed SVG.
- **Eyebrow:** The shape of it
- **Headline:** Off your folder until *land*.
- **Body:** [architecture.svg](architecture.svg) inlined at stage size. One caption line under it: "You approve a lineup. Each agent gets a worktree. Tests gate the task. Then it lands on your branch."
- **Lede or punch:** "Windows Codex and Cursor never write directly. They hand back complete files."
- **Image or mock:** The hand-written SVG. No generated art. A preview PNG is not part of this pass.
- **Speaker notes:** People on the left, the run in the middle, land on the right, and two side boxes: guards, and patch mode. A fingerprint of my repo is taken before and after every worker. If anything outside the worktree changes, the run stops with exit 5. On Windows, Codex and Cursor stay read-only, because a live test showed their sandboxes were not safe. Next is whether I would trust it, and what the first real run actually cost.

## 6. The rules and the first run

- **Archetype:** Four-column answer, plus the token table and a screenshot.
- **Eyebrow:** The first real run
- **Headline:** Not for *small* jobs.
- **Body:** Four hot columns, then the honest table.
  1. Own worktree: nothing touches your folder until land.
  2. Fingerprint: status, diff, and untracked content. An outside change stops the run (exit 5).
  3. Billing on every row. API-key models need an explicit yes.
  4. Token budget: light 150k, standard 400k, heavy 1M. Then you decide.
- **Token table (must be on this slide):**

  | Worker | Tokens, as recorded |
  |---|---|
  | Codex, GPT-6-Sol | 1,711k input (1,492k cached) / 32k output |
  | Grok 4.7 Medium via Cursor | 210k / 15k |
  | Claude Haiku 5.5 via Claude CLI | 60k / 2k |

- **Lede or punch:** "Not worth it for small jobs. 97% of the worker tokens were off Claude's budget, and the total was still several times a Sonnet loop (est. 250-400k)."
- **Image or mock:** `shots/01-work-page-run.png` is not in the repo yet. Capture the three commits on Parley branch `work-page` and the token lines. Crop to the commit subjects and the totals. Save the crop as `img/or-tokens.png`.
- **Speaker notes:** [Demo moment: play the recording, or read this table. Do not launch a tiny live plan.] The job was Parley's /work page, 2026-10-24: three tasks, three vendors, two at the same time. Codex took three fix rounds and then I finished one line in Claude. Grok took one fix round. Haiku's fix rounds are [fill in]. Three commits, 216 Parley tests passed, and we found Parley's .tsx tests had never been running. It also used up my ChatGPT allowance for the day. That is why the budget caps exist. Next is how the plugin itself was built.

## 7. How it was built

- **Archetype:** Stats.
- **Eyebrow:** How it was built
- **Headline:** One day. Real *bugs*.
- **Body:** Four stat tiles, large Big Shoulders numbers.
  - **1** day, 2026-10-24
  - **10** tasks in the plan
  - **163** node:test tests, from 0, zero dependencies
  - **about 40** plugin commits that day [fill in exact]
- **Lede or punch:** "Brainstorm, spec, builder check, then the plan. Sonnet wrote each task. A second Sonnet reviewed it. Then a whole-branch review and a fix wave."
- **Image or mock:** None, CSS only.
- **Speaker notes:** I wrote the direction. Agents wrote the tasks under a reviewer, the way I now ask other models to write under a gate. The tests use real temp git repos, including folders with spaces in the name, and stub CLIs. Reviews found bugs I would not have invented: landing could throw away staged work, a dirty file could be re-edited without tripping the check, workers never received their instructions. All of those were fixed before I trusted the Parley run. The point is not the one day. It is that the real codebase found what the plan did not. Next is where this can run, and where it cannot yet.

## 8. Where it runs

- **Archetype:** Three-column, the same skill in three situations.
- **Eyebrow:** Where it runs
- **Headline:** Your machine. Your *branch*.
- **Body:** Three columns.
  - This Claude Code session (hot): "The plugin on your machine. Worktrees, then land. Install: marketplace add fromclaudetoprod/skills, then multi-model-review@from-claude-to-prod."
  - Windows, today: "Codex and Cursor stay in patch mode. The live sandbox test is why."
  - Not tested yet (dashed): "macOS and Linux. Copilot and Gemini as workers. Codex as the orchestrator is next, because it reads the same SKILL.md."
- **Lede or punch:** "The plugin and the website are not pushed yet."
- **Image or mock:** None, CSS only. Dashed border on the third column, same treatment as an unfinished home.
- **Speaker notes:** Today it runs in this Claude Code session, on Windows, with patch mode for the two tools whose sandboxes failed a live test. I will not pretend macOS, Linux, Copilot, or Gemini are done. Codex can be the conductor later, because the skill file is the same format it already reads. Next is the only thing I want from you.

## 9. The ask

- **Archetype:** Close.
- **Eyebrow:** The ask
- **Headline:** Send me the *numbers*.
- **Body:** One-line request. [fill in: Todd decides.] Suggestion on the slide until then: "Install it, orchestrate one real plan, and send me your token numbers."
- **Lede or punch:** "One plan. Many models. Count the tokens."
- **Image or mock:** Closing frame from trailer shot 8, the robots walking out at dawn. Prompt file when built: `orchestrate-close.md`, copied from [TRAILER.md](TRAILER.md) shot 8. Save as `img/or-close.jpg`.
- **Speaker notes:** Here is my one ask, if I keep this wording: install the plugin, orchestrate one real plan, and send me the token numbers. If it saves the Claude limit, we will see it. If it only multiplies tokens, we will see that too. The first run already taught me that a small job is the wrong test.
