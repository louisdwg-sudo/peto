---
name: peto-evaluator
description: Evaluate PETO effectiveness by comparing routed effort against user acceptance, retry/escalation signals, estimated xhigh baselines, latency, and token usage.
---

# PETO Evaluator

Use this skill when measuring whether PETO improves accepted output per token.

## Metrics

Report:

- acceptance rate
- rejection rate
- retry/escalation rate
- overfit rate
- underfit rate
- estimated savings versus xhigh
- dispatcher overhead
- latency impact
- route JSON validity

## Evaluation Rules

Use exact savings only when a real xhigh counterfactual exists.

Use estimated savings when comparing against matched historical xhigh baselines or a documented baseline model.

Say `baseline pending` when neither exists.

## Output

Summarize whether PETO is saving cost without raising underfit risk. Name the weakest evidence and the next test needed.

