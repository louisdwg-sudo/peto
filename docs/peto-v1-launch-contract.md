## What PETO V1 claims

On bounded, proof-eligible, answerable effort-sensitive traffic, PETO V1 delivers approximately 17.6% exact token savings versus a fixed-xhigh baseline.

Proof reference:

- Run: peto-v1-effort-sensitive-final-claim
- Date: 2026-07-04
- Sample: 30 matched-pair representative routes
- Savings: 30,865 tokens / 17.6%
- Verdict: promote
- All gates passed

## What PETO V1 does not claim

PETO V1 makes no savings or quality claim for:

- capability_sensitive traffic (codex_suggestions + connected_app_required)
- action_or_recovery_required prompts
- local_artifact_required prompts
- tool_execution_required or workspace_action_required tasks
- Model selection (that is RouteLLM's scope, not PETO's)

## Proof-eligible slice definition

A route is proof-eligible if:

- optimization_segment = effort_sensitive
- tool_execution_required = false
- workspace_action_required = false
- action_or_recovery_required = false
- local_artifact_required = false

Current eligible pool from the 857-route baseline log: 316 routes (36.9% of total traffic).

## Known limitations in V1

- Underfit rate on the proof-eligible sample: 23.3% (7/30) - routing quality improvement is in progress
- Model selection dimension not yet addressed
- RouteLLM integration is the next product phase
