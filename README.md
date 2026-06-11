# PETO

PETO means **Personalized Effort and Tokenomics Optimization**.

The thesis is simple:

> Generic effort routing optimizes for average tasks. PETO optimizes for the lowest cost per answer the user accepts.

PETO is not a generic model router. It is a user-calibrated effort router that learns from acceptance, rejection, retries, overfit reviews, underfit reviews, and token usage.

## V1 Shape

The first data-testing version should stay intentionally small:

```text
every message
-> one cheap dispatcher model
-> choose effort only
-> fixed executor model
-> log route and outcome
-> executor/reviewer records lessons when useful
```

The dispatcher must not answer the user, rewrite the request, change intent, or choose hidden requirements.

## Core Components

- `packages/core/` - routing schemas, evaluation logic, and memory interfaces.
- `packages/gateway/` - OpenAI-compatible proxy for clients that can point at a custom `base_url`.
- `packages/mcp/` - MCP adapter for agents that cannot use a proxy.
- `packages/cli/` - command-line utilities for route tests, evals, and diagnostics.
- `skills/` - optional Codex skills for analysis, evaluation, and local model benchmarking.
- `docs/` - methodology, deployment, and evaluation notes.

## Recommended Data-Test Config

```yaml
dispatcher:
  provider: openai-compatible
  model: gpt-5.4-mini
  effort: low

executor:
  provider: openai-compatible
  model: gpt-5.5
  route_surface: effort_only

reviewer:
  model: executor
  visible_review_words: 5
  durable_logs: lesson_signals_only

memory:
  type: llmwiki
  path: ./memory
```

## Reviewer Rule

The executor can act as reviewer/logger after answering. It should show only a tiny visible review line, while logging a fuller review only when there is a reusable learning signal.

Examples:

```text
Effort review: appropriate, no lesson.
Effort review: overfit, lesson logged.
Effort review: underfit, lesson logged.
Effort review: uncertain, monitor next.
```

## Status

This repo is a research and data-testing scaffold. It is not yet a packaged release.

