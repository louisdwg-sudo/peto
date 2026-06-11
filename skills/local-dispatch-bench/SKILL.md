---
name: local-dispatch-bench
description: Benchmark local dispatcher candidates such as Qwen2.5 for PETO routing by testing JSON validity, latency, bilingual request handling, agreement with a reference router, and underfit risk.
---

# Local Dispatch Bench

Use this skill when testing a local model as a PETO dispatcher.

## Benchmark Surface

Test at least:

- JSON validity
- schema completeness
- latency
- effort agreement with reference router
- overfit/underfit tendency
- English and Chinese request handling
- robustness to quoted rejection words

## Minimum Test Set

Include:

- trivial command question
- short translation
- article/research planning
- code edit request
- high-risk architecture request
- explicit rejection of prior output
- quoted profanity that is not feedback

## Decision Rule

A local dispatcher may enter live routing only after it reliably produces valid route JSON and does not show a high underfit rate on ambiguous or high-stakes requests.

Otherwise, use it in shadow mode.

