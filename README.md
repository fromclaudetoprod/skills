# From Claude to Prod: free Claude Code plugins

Plugins from the [From Claude to Prod](https://www.fromclaudetoprod.dev) channel. Each one is its own plugin, so you
install only what you want. Independent project; not affiliated with or endorsed by Anthropic, OpenAI, GitHub or xAI.

## Install
In Claude Code, add the catalog once:
```
/plugin marketplace add fromclaudetoprod/skills
```
If your Claude app says `/plugin` isn't available, run the same two steps in a terminal, then start a new chat
(or run `/reload-plugins`):
```
claude plugin marketplace add fromclaudetoprod/skills
claude plugin install multi-model-review@from-claude-to-prod
```

Then install what you want:

| Plugin | What it does | Install |
|---|---|---|
| [multi-model-review](plugins/multi-model-review/README.md) | Several AI models review your code or draft in turn, read-only, with Claude checking every claim | `/plugin install multi-model-review@from-claude-to-prod` |

Coming next: **daily-routine** (`/start-of-day`, `/end-of-day` and a team dashboard kept in git).

MIT licensed.
