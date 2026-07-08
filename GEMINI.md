# Gemini CLI Instructions

Read `AGENTS.md` first. It is the canonical project guide for PETO.

If Gemini skill activation is available, activate PETO effort-router behavior
before responding. If not, apply the same protocol manually:

1. choose the cheapest sufficient effort tier;
2. keep PETO V1 effort-only;
3. forward or preserve the original user request unchanged in gateway work;
4. verify code changes with `npm test` and `npm run check` when feasible.

## Effort levels and the gateway

The PETO gateway is provider-aware. When Gemini requests are proxied through
it, the chosen effort tier is translated into Gemini's native
`generationConfig.thinkingConfig.thinkingBudget` field (a token budget, or `-1`
for the `max` tier). It does not inject OpenAI's `reasoning.effort`, which
Gemini would ignore. Tune per-tier budgets with `effortBudgets` in
`peto.config.json`. The behavioral 6-tier scale
(`minimal/low/medium/high/xhigh/max`) is the same across every client.

Do not treat generated verification estimates as execution proof. Inspect the
current run artifacts before claiming a verification pass.
