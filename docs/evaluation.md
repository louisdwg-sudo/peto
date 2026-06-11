# Evaluation

PETO evaluation should measure user-accepted quality per token, not generic benchmark score alone.

## Core Metrics

- acceptance rate
- explicit rejection rate
- retry/escalation rate
- overfit rate
- underfit rate
- estimated token savings versus xhigh
- latency
- route JSON validity
- dispatcher cost overhead

## Event Schema

Every route should log:

```json
{
  "phase": "request",
  "input_hash": "string",
  "incoming_model": "string",
  "incoming_effort": "string",
  "chosen_model": "string",
  "chosen_effort": "string",
  "router_model": "string",
  "router_effort": "string",
  "router_confidence": 0.0,
  "router_rationale": "string",
  "retrieved_notes": [],
  "feedback_signal": false
}
```

Response logs should include status, latency, and usage when available.

## Underfit Detection

Mark underfit when a clear rejection or retry is aimed at the assistant's output.

Do not mark underfit for:

- quoted examples
- user describing another output
- profanity unrelated to the current answer
- requests to change direction for reasons unrelated to quality

## Overfit Detection

Mark overfit when the reviewer judges that a lower effort would likely have produced similar accepted quality.

Durable overfit lessons should be contextual:

```text
Short command lookup with no file edits accepted minimal effort.
```

not universal:

```text
All command questions are minimal.
```

## Estimated Savings

Use historical matched baselines when possible. If no baseline exists, say the baseline is pending rather than inventing precision.

