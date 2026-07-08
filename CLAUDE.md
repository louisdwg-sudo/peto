# Claude Code Instructions

Read `AGENTS.md` first. It is the canonical project guide for PETO.

Use the project-local skill adapter when available:

```text
.claude/skills/peto-effort-router/SKILL.md
```

The canonical source skill also lives at:

```text
skills/peto-effort-router/SKILL.md
```

Claude Code should keep PETO V1 effort-only:

- choose effort metadata only;
- do not rewrite the user request;
- do not switch executor models unless the user explicitly asks for a model
  routing experiment;
- verify code changes with `npm test` and `npm run check` when feasible.

## Effort levels and the gateway

The effort scale has six tiers: `minimal / low / medium / high / xhigh / max`.
`max` sits above `xhigh` for Claude, whose reasoning scale extends past
OpenAI's ceiling. When Claude requests are proxied through the PETO gateway,
the chosen tier is translated into Anthropic's native
`thinking.budget_tokens` field (not OpenAI's `reasoning.effort`, which Claude
would ignore); `minimal` disables extended thinking. Per-tier token budgets are
configurable via `effortBudgets` in `peto.config.json`. The response footer is
injected only for OpenAI-shaped responses; for Anthropic responses the gateway
routes effort but does not append the footer.

Before editing, inspect `git status --short` and preserve unrelated user or
agent changes.
