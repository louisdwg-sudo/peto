# PETO — Codex Direction Brief
*Issued: 2026-06-22 | Authority: Louis*

## What PETO Is

**PETO = Personalized Effort and Tokenomics Optimization.**

It is a **routing-level effort decision determinant — nothing more.**

Given a user request, PETO determines the cheapest effort level that produces output satisfactory to the user, then routes accordingly. That is the complete scope.

```
user request → effort dispatcher → [minimal | low | medium | high | xhigh] → executor (unchanged)
```

## What PETO Is Not

PETO is **not**:
- An agent orchestrator
- A multi-step workflow engine
- A user-intent interrogator
- A model selector (that is RouteLLM's job)
- A quality judge (that is a future measurement tool, not core routing)
- An "orchestra" of any kind

The V2 orchestra direction explored in docs like `docs/symphony-verification-loop.md` and `Claude-Code-Review-Handoff-Symphony-PETO.md` was a mistake and is **cancelled**. Those files are historical artifacts — do not implement them.

## Ultimate Aim

PETO will eventually be coupled with **RouteLLM** to answer:

> "Which model at which effort level is most token-effective for output satisfactory for user perusal?"

- **PETO owns:** effort dimension (minimal → xhigh)
- **RouteLLM owns:** model selection dimension
- **Together:** optimal (model, effort) pair per request

Build toward this coupling. Do not conflate the two.

## Current State (as of 2026-06-22)

The V1 core build is merged to main. What exists:

| Component | Status |
|---|---|
| `peto verify create/run/gate/report` | ✅ Merged |
| Telemetry schema v1 | ✅ Merged |
| `cost_per_accepted_outcome` metric | ✅ Merged |
| Hard/soft gate framework | ✅ Merged |
| Counterfactual executor runs | ❌ Not built |
| RouteLLM comparator | ❌ Not built |
| Quality Judge | ❌ Not built (deferred) |
| Human review queue | ❌ Not built (gate hardcoded clear) |

## Next Slice Priorities

1. **Counterfactual runs** — matched pairs: same request, xhigh baseline vs PETO's chosen effort. This is the only way to replace estimated savings with real savings.
2. **RouteLLM comparator stub** — wire RouteLLM as a named baseline in `peto verify`, even if it's initially just a config flag pointing at a RouteLLM endpoint.
3. **Fix known issues from review** — YAML error handling, schema migration docs, `acceptance_label` write semantics documented.

## Scope Test

Before building any feature, apply this test:

> "Does this directly improve the **effort routing decision** or its **measurement**?"

If no → it's out of scope. Do not build it.
