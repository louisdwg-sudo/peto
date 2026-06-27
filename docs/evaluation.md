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
  "schema_version": "1.0",
  "phase": "request",
  "id": "string",
  "route_id": "string",
  "input_hash": "string",
  "incoming_model": "string",
  "incoming_effort": "string",
  "chosen_model": "string",
  "chosen_effort": "string",
  "profile_segment": "string",
  "risk_tier": "low|medium|high|unknown",
  "language": "string",
  "request_class": "codex_suggestions|session_restore|memory_extraction|coding_help|other",
  "connected_app_required": false,
  "memory_lookup_needed": false,
  "optimization_segment": "effort_sensitive|capability_sensitive",
  "router_model": "string",
  "router_effort": "string",
  "router_confidence": 0.0,
  "router_rationale": "string",
  "router_usage": {},
  "executor_usage": null,
  "acceptance_label": "accepted|underfit|overfit|rejected|ambiguous|invalid|null",
  "annotations": [],
  "retrieved_notes": [],
  "feedback_signal": false
}
```

Response logs should include `status`, `latency_ms`, and `executor_usage` when available. During migration, response logs may also keep `usage` as a backward-compatible alias for `executor_usage`. Router usage and executor usage must stay separate.

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

## CLI Evaluation

Use the CLI for local, reproducible checks against router JSONL logs:

```bash
npm run cli -- doctor
npm run cli -- feedback --route-id ROUTE_ID --label accepted
npm run cli -- eval
npm run cli -- replay --limit 10
npm run cli -- verify create --ticket ticket.json
npm run cli -- verify run --id peto-verify-run
npm run cli -- verify gate --id peto-verify-run
npm run cli -- verify report --id peto-verify-run
```

`peto eval` reads the configured router and feedback logs, then reports:

- route JSON validity
- effort distribution
- acceptance, rejection, retry/escalation, overfit, and underfit rates
- estimated xhigh savings when usage data exists
- dispatcher overhead when router usage is logged
- cost per accepted outcome when token usage and acceptance labels are available
- median latency
- weakest evidence and the next test needed

The CLI should not claim exact savings without real counterfactual xhigh runs. When logs do not contain enough usage or feedback data, it must say `baseline pending` and name the missing evidence.

`optimization_segment` is a reporting-only derived field. `codex_suggestions` requests that require connected app context are `capability_sensitive`; all other traffic is `effort_sensitive`. This segmentation makes PETO's effort-routing performance legible without changing routing behavior.

`peto verify` writes deterministic offline verification artifacts under `memory/verification/runs/<run_id>/`. V1 verification runs the candidate router and fixed baselines over logged samples only; it does not execute user requests or invoke RouteLLM unless a later explicit comparator ticket adds that behavior.

Verification tickets may set `segment_filter` to `all`, `effort_sensitive`, or `capability_sensitive`. They may set `sample_mode` to `representative` or `stress`. Representative samples are seeded random samples from the selected segment and are claim-grade. Stress samples preserve the failure-biased underfit/rejected sampling behavior and are stress-grade for failure analysis.

## Agent-Orchestrated Verification

V1 automated verification should run through `peto verify` first. The Symphony loop spec in [symphony-verification-loop.md](symphony-verification-loop.md) remains a design reference for a later agent wrapper, not a dependency of the PETO core harness.
