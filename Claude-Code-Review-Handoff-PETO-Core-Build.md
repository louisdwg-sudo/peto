# Claude Code Review Handoff: PETO Core Build

Please review the PETO core build implemented by Codex on branch `codex/peto-core-build`.

This is a review request only. Do not implement changes unless Louis explicitly asks you to.

## Current Review State

- Branch: `codex/peto-core-build`
- Base commit before the PETO core build: `3da4d3408ac997f1aaf9fde23cf29c58433b596c`
- If this handoff has been committed, review the resulting commit at `HEAD`.
- If the work is still uncommitted in your environment, some files may be untracked, so `git diff --stat` alone will not show the full implementation. Start with:

```bash
git status --short
git diff 3da4d3408ac997f1aaf9fde23cf29c58433b596c..HEAD --stat 2>/dev/null || true
git diff -- docs/evaluation.md package.json packages/gateway/README.md packages/gateway/router-gateway.mjs
```

Then read the new/untracked files directly:

```bash
sed -n '1,260p' packages/cli/peto-cli.mjs
sed -n '1,260p' packages/core/config.mjs
sed -n '1,320p' packages/core/eval.mjs
sed -n '1,220p' packages/core/feedback.mjs
sed -n '1,220p' packages/core/hash.mjs
sed -n '1,220p' packages/core/jsonl.mjs
sed -n '1,260p' packages/core/telemetry.mjs
sed -n '1,380p' packages/core/verify.mjs
sed -n '1,360p' tests/core.test.mjs
```

## Context

PETO means **Personalized Effort and Tokenomics Optimization**.

The V1 product rule is unchanged:

```text
user request
-> cheap effort dispatcher
-> original request forwarded unchanged
-> fixed executor model answers
-> route/outcome telemetry logged
-> verification uses local CLI artifacts
```

Important boundaries:

- PETO is about users, user profiles, or tenants. Do not frame it as one named person.
- RouteLLM is not part of PETO core V1. It may become a later comparator.
- The built Symphony orchestra is not included in PETO core V1. `peto verify` is the core harness.
- No exact savings claim should be made without counterfactual executor data.

## What Codex Changed

Primary implementation files:

- `packages/cli/peto-cli.mjs`
  - Refactored into a thin command shell.
  - Keeps existing `doctor`, `route`, `eval`, and `replay`.
  - Adds `feedback`.
  - Adds `verify create`, `verify run`, `verify gate`, and `verify report`.

- `packages/core/config.mjs`
  - Shared config defaults and config loading.

- `packages/core/jsonl.mjs`
  - Shared JSON/JSONL read/write helpers.

- `packages/core/hash.mjs`
  - Stable JSON and SHA/hash helpers.

- `packages/core/telemetry.mjs`
  - Route event normalization.
  - Schema version `1.0`.
  - Router/executor usage split.
  - Acceptance label normalization.
  - Strict missing-field detection for new-format logs.

- `packages/core/eval.mjs`
  - Shared evaluation logic extracted from the old CLI.
  - Computes acceptance/rejection/underfit/overfit, dispatcher overhead, estimated savings, latency, and `cost_per_accepted_outcome`.

- `packages/core/feedback.mjs`
  - Writes explicit labels:
    `accepted|underfit|overfit|rejected|ambiguous|invalid`.

- `packages/core/verify.mjs`
  - Creates run directories under `memory/verification/runs/<run_id>/`.
  - Writes `run-manifest.json` and `config-snapshot.json`.
  - Curates deterministic samples with a seed.
  - Writes `samples.jsonl`, `sample-summary.json`, `candidate-routes.jsonl`, `baseline-routes.<name>.jsonl`, `metrics.json`, `gates.json`, `verdict.json`, and `report.md`.
  - Runs offline only. It does not execute user requests.

- `packages/gateway/router-gateway.mjs`
  - Adds telemetry schema fields to gateway logs.
  - Request logs now include `route_id`, `schema_version`, `profile_segment`, `risk_tier`, `language`, `request_class`, `router_usage`, `executor_usage: null`, `acceptance_label`, and `annotations`.
  - Response logs now include `executor_usage`, plus legacy `usage` alias.

- `tests/core.test.mjs`
  - Adds Node built-in test coverage.

Docs/scripts touched:

- `package.json`
  - Adds `bin.peto`.
  - Adds `npm run cli`.
  - Adds `npm test`.
  - Extends `npm run check` to syntax-check core modules.

- `docs/evaluation.md`
  - Documents schema v1 telemetry.
  - Documents `feedback` and `verify` commands.
  - States that V1 verification should use `peto verify`; Symphony is later wrapper reference only.

- `packages/gateway/README.md`
  - Documents telemetry shape and CLI inspection commands.

There are pre-existing/related uncommitted docs from the broader PETO workstream:

- `PETO-session-handoff.md`
- `reports/peto-personalized-effort-tokenomics-optimization.md`
- `Claude-Code-Review-Handoff-Symphony-PETO.md`
- `Claude-Code-Review-Response-Symphony-PETO.md`
- `docs/symphony-verification-loop.md`

Please distinguish core-build issues from earlier doc/framing changes.

## Verification Already Run

Fresh commands run by Codex:

```bash
npm test
npm run check
```

Observed result:

- `npm test`: 8/8 passing.
- `npm run check`: passing.

Codex also ran a CLI smoke with a temporary config/log/ticket:

```bash
node packages/cli/peto-cli.mjs feedback --config "$tmp/peto.config.json" --route-id r1 --label accepted --json
node packages/cli/peto-cli.mjs verify create --config "$tmp/peto.config.json" --ticket "$tmp/ticket.yaml" --json
node packages/cli/peto-cli.mjs verify run --config "$tmp/peto.config.json" --id peto-verify-cli-smoke --json
node packages/cli/peto-cli.mjs verify gate --config "$tmp/peto.config.json" --id peto-verify-cli-smoke --json
node packages/cli/peto-cli.mjs verify report --config "$tmp/peto.config.json" --id peto-verify-cli-smoke --json
```

Observed smoke output:

- Verdict: `hold`.
- Report existed.
- Artifact directory contained:
  - `baseline-routes.fixed_xhigh.jsonl`
  - `candidate-routes.jsonl`
  - `config-snapshot.json`
  - `gates.json`
  - `metrics.json`
  - `report.md`
  - `run-manifest.json`
  - `sample-summary.json`
  - `samples.jsonl`
  - `verdict.json`

## Review Focus

Please review as a skeptical implementation reviewer, not as a product brainstorm.

Key questions:

1. Is the CLI architecture clean enough, or did Codex split too much / too little?
2. Does telemetry schema v1 preserve backward compatibility while correctly hard-failing new-format missing fields?
3. Is `cost_per_accepted_outcome` computed in the right place and with the right semantics for V1?
4. Are hard vs soft gates correct?
   - Hard: telemetry preconditions, route JSON validity, underfit delta, human review queue clear.
   - Soft: dispatcher overhead and net savings while counterfactuals are absent.
5. Does `verify run` correctly avoid executing user requests?
6. Are the artifacts stable and machine-readable enough for later agent orchestration?
7. Is the lightweight YAML parser acceptable for tickets, or should this repo use a real YAML dependency before broader use?
8. Are there hidden bugs in explicit feedback labels overriding heuristic acceptance?
9. Is the gateway telemetry split correct for streaming and non-streaming executor responses?
10. Is there any risk that old logs become silently over-trusted?

## Known Limitations / Non-Goals

- No counterfactual executor yet.
- No Quality Judge yet.
- No human review queue file yet; V1 gate currently treats it as clear.
- No RouteLLM comparator.
- No Symphony wrapper.
- No production CI workflow.
- YAML support is intentionally small and ticket-focused, not general YAML.
- `peto route` still requires a reachable local router; tests do not mock live routing.

## Suggested Review Output

Please return:

1. Executive verdict: approve / approve with changes / reject.
2. Findings ordered by severity, with file/line references.
3. Which issues must be fixed before this branch is merged.
4. Which issues can wait for the next PETO slice.
5. Any test cases missing from `tests/core.test.mjs`.
6. Any schema/artifact changes that should be made now before logs accumulate.
