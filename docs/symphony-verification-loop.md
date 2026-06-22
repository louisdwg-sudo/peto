# PETO Symphony Verification Loop

## Purpose

The Symphony loop automates PETO verification as a controlled agent workflow. Its job is not to make the router look good. Its job is to prove whether a dispatcher candidate improves accepted quality per total token without increasing underfit, retries, latency, or operational risk.

The loop uses a ticket-controller-worker-review pattern:

```text
verification ticket
-> conductor
-> isolated workers
-> evaluator and judge
-> report builder
-> ship gate
-> policy or lesson update
```

## Non-Negotiable Rules

- The user's original request must never be rewritten for execution.
- PETO V1 verification is effort-only unless the ticket explicitly names a model-routing experiment.
- Savings must include dispatcher overhead.
- Exact savings require real counterfactual runs. Otherwise report estimated savings or `baseline pending`.
- Underfit is a blocker when it rises above the active baseline tolerance.
- Durable lessons are written only for reusable routing signals, not for every run.
- Every agent must write bounded artifacts, not free-form chat history.

## Agent Roles

### 1. Conductor

Owns the verification ticket from intake to verdict.

Inputs:

- ticket YAML
- current PETO config
- route logs
- feedback logs
- baseline policy

Actions:

1. Validate the ticket schema.
2. Assign a run id.
3. Create an isolated run directory.
4. Freeze config snapshots.
5. Select worker agents.
6. Enforce budget, timeout, and retry limits.
7. Stop the run if a critical gate fails.

Outputs:

- `run-manifest.json`
- `config-snapshot.json`
- `agent-assignments.json`

Failure handling:

- Missing config: fail ticket as `blocked_config`.
- Missing logs: continue with `baseline_pending`.
- Router unavailable: mark `router_unavailable`, run offline eval only.

### 2. Dataset Curator

Builds the verification sample set.

Inputs:

- route log path
- feedback log path
- sampling policy
- profile segment id

Actions:

1. Load route events.
2. Pair request and response events by route id.
3. Remove malformed pairs.
4. Stratify samples by effort level, request class, language, profile segment, and risk tier.
5. Include all known underfit and explicit rejection cases.
6. Include a random accepted sample for regression coverage.
7. Hash sensitive prompt text when full text is not needed.

Outputs:

- `samples.jsonl`
- `sample-summary.json`
- `excluded-events.jsonl`

Pass criteria:

- At least one sample exists for every effort level present in production logs.
- 100% of known underfit/rejection events are included unless explicitly excluded with reason.

### 3. Dispatcher Runner

Runs the candidate PETO dispatcher on the sample set.

Inputs:

- `samples.jsonl`
- candidate router config
- memory retrieval config

Actions:

1. Run `npm run cli -- doctor --json`.
2. If local dispatcher is configured, check `/health`.
3. For each sample, call the candidate dispatcher.
4. Validate returned route JSON.
5. Record effort, confidence, rationale, latency, source, and errors.
6. Do not execute the user request.

Outputs:

- `candidate-routes.jsonl`
- `candidate-router-health.json`

Pass criteria:

- Route JSON validity >= 99%.
- Median dispatcher latency within ticket threshold.
- No disallowed effort labels.

### 4. Baseline Runner

Runs baselines for comparison.

Allowed baselines:

- current production PETO router
- fixed xhigh effort
- fixed medium effort
- local heuristic router
- RouteLLM model router, when the ticket explicitly tests model routing

Actions:

1. Run each configured baseline against the same samples.
2. Preserve the same memory retrieval settings when comparing PETO variants.
3. For RouteLLM, record model decision separately from effort decision.
4. Do not mix model-routing and effort-routing metrics without labeling the comparison.

Outputs:

- `baseline-routes.<name>.jsonl`
- `baseline-summary.<name>.json`

Pass criteria:

- Every baseline has the same sample count unless documented.
- RouteLLM comparisons are labeled as model-routing baselines, not PETO effort replacements.

### 5. Counterfactual Executor

Runs selected user requests at alternate efforts only when the ticket authorizes cost.

Inputs:

- `samples.jsonl`
- counterfactual policy
- execution budget

Actions:

1. Select representative samples for xhigh, medium, and candidate effort runs.
2. Execute each sample with the original user request unchanged.
3. Store output, token usage, latency, and model metadata.
4. Stop when the budget is exhausted.
5. Never execute requests marked sensitive unless the ticket permits it.

Outputs:

- `counterfactual-results.jsonl`
- `usage-summary.json`

Pass criteria:

- Every executed counterfactual includes usage and latency.
- If no counterfactuals run, savings must be labeled `estimated` or `baseline_pending`.

### 6. Quality Judge

Labels output quality and effort fit.

Inputs:

- original sample
- candidate output
- baseline output
- user/profile acceptance rubric

Actions:

1. Compare outputs against the requested job, not generic style preference.
2. Label each output: `accepted`, `underfit`, `overfit`, `ambiguous`, or `invalid`.
3. Mark underfit only when quality is insufficient for the original request.
4. Mark overfit only when lower effort produced equivalent accepted quality.
5. Record confidence and rationale.
6. Send low-confidence cases to human review queue.

Outputs:

- `quality-labels.jsonl`
- `human-review-queue.jsonl`

Pass criteria:

- Judge confidence average >= ticket threshold or ambiguous cases are queued.
- No severe underfit is silently counted as accepted.

### 7. Metrics Auditor

Computes the verification metrics.

Inputs:

- routes
- counterfactual results
- quality labels
- feedback logs

Actions:

1. Compute acceptance rate.
2. Compute explicit rejection rate.
3. Compute retry/escalation rate.
4. Compute underfit and overfit rate.
5. Compute JSON validity.
6. Compute dispatcher overhead.
7. Compute latency percentiles.
8. Compute exact or estimated xhigh savings.
9. Compare candidate against active baseline.

Outputs:

- `metrics.json`
- `regressions.jsonl`

Pass criteria:

- Underfit rate <= baseline + tolerance.
- JSON validity >= 99%.
- Dispatcher overhead <= threshold.
- Savings are positive after overhead, unless ticket is diagnostic-only.

### 8. Report Builder

Creates the human-readable verification bundle.

Inputs:

- all run artifacts

Actions:

1. Summarize verdict.
2. Name weakest evidence.
3. List pass/fail gates.
4. Include exact command log.
5. Link all artifacts.
6. Propose next action: promote, hold, rollback, retest, or collect more data.

Outputs:

- `report.md`
- `executive-summary.md`

### 9. Ship Gate

Blocks unsafe promotion.

Actions:

1. Check required artifacts exist.
2. Check metrics gates.
3. Check no critical regressions.
4. Check lessons are contextual.
5. Check rollback path exists.

Verdicts:

- `promote`
- `promote_with_caution`
- `hold`
- `rollback`
- `blocked`

### 10. Memory Curator

Writes durable policy updates only after the ship gate.

Actions:

1. Write a dispatcher lesson only for reusable signals.
2. Avoid universal lessons such as `coding = high`.
3. Include boundary conditions.
4. Link back to verification run id.

Outputs:

- `lesson-candidates.md`
- committed policy or lesson update only if approved

## Ticket Schema

```yaml
id: peto-verify-YYYYMMDD-short-name
type: dispatcher_candidate | policy_change | regression_check | routellm_comparison
profile_segment: default | enterprise | coding-heavy | writing-heavy
candidate:
  name: local-qwen-v3
  config_path: ./peto.config.json
baselines:
  - current-production
  - fixed-xhigh
  - routellm
sample_policy:
  max_samples: 200
  include_all_underfit: true
  stratify_by:
    - chosen_effort
    - language
    - risk_tier
counterfactual_policy:
  enabled: true
  max_runs: 30
  efforts:
    - candidate
    - medium
    - xhigh
gates:
  max_underfit_delta: 0.01
  min_json_validity: 0.99
  max_dispatcher_overhead_ratio: 0.08
  min_net_savings_ratio: 0.10
  max_median_dispatch_latency_ms: 2000
budgets:
  max_total_tokens: 500000
  max_wall_clock_minutes: 60
  max_retries_per_agent: 1
```

## State Machine

```text
draft
-> validated
-> sampling
-> routing
-> counterfactuals
-> judging
-> auditing
-> reporting
-> gate
-> promoted | held | rollback | blocked
```

State transition requirements:

- `draft -> validated`: ticket schema passes.
- `validated -> sampling`: run directory created.
- `sampling -> routing`: `samples.jsonl` and `sample-summary.json` exist.
- `routing -> counterfactuals`: candidate route validity passes minimum gate.
- `counterfactuals -> judging`: outputs and usage are captured or counterfactuals are marked skipped.
- `judging -> auditing`: quality labels exist for every executed output.
- `auditing -> reporting`: `metrics.json` exists.
- `reporting -> gate`: `report.md` exists.
- `gate -> promoted`: all hard gates pass.

## Directory Layout

```text
verification-runs/
  peto-verify-YYYYMMDD-short-name/
    ticket.yaml
    run-manifest.json
    config-snapshot.json
    samples.jsonl
    sample-summary.json
    candidate-routes.jsonl
    baseline-routes.current-production.jsonl
    baseline-routes.fixed-xhigh.jsonl
    counterfactual-results.jsonl
    quality-labels.jsonl
    human-review-queue.jsonl
    metrics.json
    regressions.jsonl
    lesson-candidates.md
    report.md
```

## Agent Handoff Contract

Every handoff must include:

```json
{
  "run_id": "peto-verify-YYYYMMDD-short-name",
  "from_agent": "dataset_curator",
  "to_agent": "dispatcher_runner",
  "state": "sampling_complete",
  "inputs": ["samples.jsonl", "sample-summary.json"],
  "expected_outputs": ["candidate-routes.jsonl", "candidate-router-health.json"],
  "hard_constraints": [
    "do not execute user requests",
    "validate effort label",
    "record latency"
  ],
  "budget_remaining": {
    "tokens": 450000,
    "minutes": 52
  }
}
```

## Optimal Agent Behavior Rules

- Keep context small: pass file paths and summaries, not full logs.
- Validate inputs before doing work.
- Write machine-readable artifacts first, prose second.
- Treat absent evidence as unknown, not pass.
- Escalate ambiguity rather than inventing labels.
- Use deterministic sampling seeds.
- Never update production policy before the ship gate.
- Prefer one retry with a smaller scope over repeated full reruns.

## Minimum Automation Commands

Current commands:

```bash
npm run cli -- doctor --json
npm run cli -- eval --json
npm run cli -- replay --limit 50 --json
```

Needed next commands:

```bash
npm run cli -- verify create --ticket ticket.yaml
npm run cli -- verify run --id peto-verify-YYYYMMDD-short-name
npm run cli -- verify gate --id peto-verify-YYYYMMDD-short-name
npm run cli -- verify report --id peto-verify-YYYYMMDD-short-name
```

## Expert Evaluation

The Symphony loop is the right pattern for PETO verification because PETO verification has multiple independent but tightly gated tasks: sampling, routing, counterfactual execution, judging, metrics, reporting, and policy update. A single agent would either carry too much context or blur evidence boundaries.

The main risk is over-automation. PETO cannot let the same loop that wants savings also decide that quality is acceptable without auditability. The quality judge and metrics auditor must be separate roles, and low-confidence labels must go to human review.

The second risk is false precision. If the counterfactual executor does not run real xhigh comparisons, the report must not claim exact savings.

The third risk is profile leakage. Verification must evaluate per profile segment. Aggregated wins can hide regressions for a specific user segment.

Recommended implementation order:

1. Add ticket schema and run directory scaffolding.
2. Add deterministic dataset curator.
3. Add dispatcher runner and route JSON validator.
4. Add metrics auditor using existing `peto eval` logic.
5. Add report builder.
6. Add ship gate.
7. Add counterfactual executor.
8. Add quality judge with human-review queue.
9. Add RouteLLM comparator only after effort-only verification is stable.
