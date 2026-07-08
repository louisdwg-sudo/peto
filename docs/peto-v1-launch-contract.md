## What PETO V1 claims

On bounded, proof-eligible, answerable effort-sensitive traffic, PETO V1 delivers approximately 17.6% exact token savings versus a fixed-xhigh baseline.

Proof reference:

- Run: peto-v1-effort-sensitive-final-claim
- Date: 2026-07-04
- Sample: 30 matched-pair representative routes
- Savings: 30,865 tokens / 17.6%
- Verdict: promote
- All gates passed

## What is outside the proof (not outside PETO)

PETO V1 makes no *measured* savings or quality claim for the request types below. This is a measurement limitation, not a capability limitation — these tasks can't be faithfully replayed offline, so matched-pair proof isn't possible. PETO likely still saves on them (often more, since they are the expensive tasks); we simply cannot prove it with this method yet.

- capability_sensitive traffic (codex_suggestions + connected_app_required)
- action_or_recovery_required prompts
- local_artifact_required prompts
- tool_execution_required or workspace_action_required tasks

Model selection is genuinely out of scope — that is RouteLLM's job, not PETO's.

## Proof-eligible slice definition

A route is proof-eligible (i.e. measurable with matched-pair counterfactuals) if:

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
