# Claude Code Review Handoff: PETO Symphony Verification Loop

## Purpose

Please review the proposed PETO Symphony verification plan before implementation. Do not implement yet unless Louis explicitly asks you to. The goal is to critique structure, agent boundaries, gates, artifacts, and sequencing so the next build step is clean.

## Project Context

PETO means **Personalized Effort and Tokenomics Optimization**.

Correct framing:

```text
PETO is about users, user profiles, or tenants.
It is not about one named individual.
```

The product goal is:

```text
lowest accepted output cost per user/profile/tenant
```

not merely:

```text
lowest token cost
```

Current PETO V1 rule:

```text
user request
-> cheap dispatcher
-> choose effort only
-> original request forwarded unchanged
-> fixed executor model answers
-> route/outcome telemetry logged
-> lessons written only when useful
```

## Current Worktree State

Files already changed or added in this branch:

- `PETO-session-handoff.md`
  - Corrected old wording from named-person-specific to user/profile/tenant-specific.
- `reports/peto-personalized-effort-tokenomics-optimization.md`
  - Corrected PETO framing around profile-specific acceptance curves.
- `packages/cli/peto-cli.mjs`
  - New PETO CLI with `doctor`, `route`, `eval`, and `replay`.
- `package.json`
  - Added `bin.peto`, `npm run cli`, and CLI syntax check.
- `docs/evaluation.md`
  - Added CLI evaluation notes and pointer to the Symphony verification loop.
- `docs/symphony-verification-loop.md`
  - New proposed operational spec for automated PETO verification.

Validation already run:

```bash
npm run check
```

Result: passed.

## Main File To Review

Start with:

```text
docs/symphony-verification-loop.md
```

The proposed loop is:

```text
verification ticket
-> conductor
-> isolated workers
-> evaluator and judge
-> report builder
-> ship gate
-> policy or lesson update
```

It defines these agent roles:

1. Conductor
2. Dataset Curator
3. Dispatcher Runner
4. Baseline Runner
5. Counterfactual Executor
6. Quality Judge
7. Metrics Auditor
8. Report Builder
9. Ship Gate
10. Memory Curator

## Review Objective

Please evaluate whether this plan is structurally sound for agents to execute optimally.

Focus on:

1. Agent boundaries
   - Are the roles too many, too few, or incorrectly split?
   - Which roles should be merged for V1?
   - Which roles must stay separate for auditability?

2. Handoff contracts
   - Are required inputs and outputs explicit enough?
   - Are artifact names and schemas sufficient?
   - Is there any hidden dependency that would cause agents to improvise?

3. State machine
   - Are transitions complete?
   - Are there missing blocked/error states?
   - Does the loop avoid ambiguous partial-completion states?

4. Verification gates
   - Are the gates correctly ordered?
   - Are thresholds realistic for early PETO?
   - Which gates should be hard blockers vs warnings?

5. Metrics correctness
   - Does the plan correctly separate:
     - exact savings
     - estimated savings
     - baseline pending
   - Does it correctly include dispatcher overhead?
   - Does it protect against underfit hidden by aggregate savings?

6. RouteLLM integration boundary
   - Does the plan correctly treat RouteLLM as a model-routing baseline/comparator?
   - Is there a cleaner way to compare RouteLLM without confusing effort routing vs model routing?

7. Minimal build order
   - Is the recommended implementation order right?
   - What should be the first CLI implementation slice?
   - What can safely wait?

8. Operational safety
   - Are there sufficient budget, retry, timeout, and rollback controls?
   - Are sensitive prompts/data handled safely enough?
   - Should the loop require human review before memory/policy updates?

## Constraints

Do not change the core PETO V1 rule unless you explicitly argue why:

```text
effort-only routing
fixed executor model
original user request unchanged
mechanical telemetry
lessons only when useful
```

Do not make the plan dependent on RouteLLM. RouteLLM may be a comparator or optional module, not the center of PETO V1.

Do not let savings override quality. The top safety gate is underfit/regression by user/profile segment.

Do not claim exact savings without real counterfactual xhigh runs.

Do not implement the verification CLI yet unless Louis asks.

## Desired Output From You

Please provide:

1. Executive verdict: approve / approve with changes / reject.
2. Top structural risks, ordered by severity.
3. Suggested role merges or splits for V1.
4. Missing schemas or artifacts.
5. Revised minimal implementation order.
6. Any specific edits you recommend to `docs/symphony-verification-loop.md`.

If you recommend edits, keep them scoped to the plan document unless a related docs change is essential.

## Useful Commands

```bash
npm run check
npm run cli -- doctor --json
npm run cli -- eval --json
npm run cli -- replay --limit 20 --json
```

## Important Existing Evidence

Current CLI is offline-capable:

- `peto eval` reads router and feedback JSONL logs.
- It reports route JSON validity, effort distribution, acceptance/rejection estimates, overfit/underfit, dispatcher overhead, latency, and weakest evidence.
- It labels savings as `baseline pending` when usage/counterfactual evidence is missing.

Known limitation:

- The proposed Symphony `verify` subcommands are not implemented yet.
- The quality judge and counterfactual executor are design-level only.
- There is not yet a real ticket parser, sample curator, or run directory scaffold.

## Review Tone

Be critical. The purpose is to catch orchestration mistakes before implementation.
