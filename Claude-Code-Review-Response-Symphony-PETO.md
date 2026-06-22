# Claude Code Review Response: PETO Symphony Verification Loop

> Review of `docs/symphony-verification-loop.md` and supporting files, in response to
> `Claude-Code-Review-Handoff-Symphony-PETO.md`. Review-only — no files in the plan were
> changed. Hand this back to Codex to action the edits in §7.

## 1. Executive verdict: Approve with changes

The Symphony spec is structurally sound and respects every constraint in the handoff:
effort-only routing, original request unchanged, savings-include-overhead, no
exact-savings-without-counterfactuals, RouteLLM kept as an optional comparator.

The single most important correct decision is **separating Quality Judge from Metrics
Auditor** — the thing that *wants* savings must never *decide* quality. Protect this.

But the plan would cause agents to improvise in several places, and a few gate/metric
definitions are wrong or unverifiable against the data the CLI actually produces today.
None of the fixes are large. Do not start the build until §2 and §4 are resolved.

**Deeper point:** the plan is over-engineered for the data you have today. Current logs
carry no per-profile segment, no `risk_tier`, no executor usage tokens (CLI `route`
logs the *router's* usage, not the executor's), and no real acceptance label. Several
agents consume fields that do not exist yet. That is the top risk and it is not in the
handoff's list.

## 2. Top structural risks, ordered by severity

### R1 — Agents consume fields the telemetry doesn't produce (highest)
The plan's value prop is *per-profile* verification, but:
- Route events in `packages/cli/peto-cli.mjs` (lines 245-264) and the schema in
  `docs/evaluation.md` have **no `profile_segment`, `risk_tier`, `language`, or
  `request_class`**. The Dataset Curator is told to stratify by all of these (plan
  line 81; ticket schema lines 322-325). They are absent from the log.
- Acceptance is *derived heuristically* in `evalLogs` (`peto-cli.mjs:356`) as
  `total − displeasure − underfit − failed`. There is no stored acceptance label.
  "100% of known underfit/rejection events included" depends on fuzzy feedback-log
  keyword matching.
- **Dispatcher overhead**, the most-cited metric, is `router_tokens / actualTokens`.
  Today `actualTokens` is dominated by the *router's own* usage because the CLI never
  executes the user request and logs no executor tokens. Overhead reads ~100% or
  `baseline pending` for all CLI-sourced data.

**Fix:** Add a "Telemetry Preconditions" Phase 0 to the doc listing the exact fields
every downstream agent requires. Have the **Conductor hard-fail** any stratification key
not present in the log schema rather than letting the Curator silently bucket everything
into `default`. Without this, every "per-profile regression" claim is fiction.

### R2 — `min_net_savings_ratio: 0.10` is the wrong default hard gate (high)
The handoff says "do not let savings override quality" and "the top safety gate is
underfit." Yet the gate list (plan line 247, line 338) makes **positive net savings a
hard pass criterion.** That inverts the stated priority: a candidate that preserves
quality at break-even cost *but eliminates underfit* would be blocked for "insufficient
savings." It is also computed from estimated data before the counterfactual executor
exists, violating the "no false precision" rule.

**Fix:** Make `min_net_savings_ratio` a **soft/warning gate** (or diagnostic-only) until
the counterfactual executor exists. Hard blockers in V1 = underfit delta, JSON validity,
and no critical per-segment regression.

### R3 — Quality Judge influences gates with no enforced human clearance (high)
§6 sends low-confidence cases to a human queue (good), but nothing forces the queue to be
cleared **before the Ship Gate runs.** The Ship Gate (§9) checks "no critical
regressions" but never checks the queue. An LLM judge can mislabel underfit as accepted,
flowing straight into `acceptance_rate`.

**Fix:** Add a hard Ship Gate check: `human_review_queue.length == 0 OR
queue_signed_off == true` before any `promote`. Enforce human review at the Ship Gate,
not the Memory Curator.

### R4 — Partial-completion / error states under-specified (medium)
The state machine (plan lines 348-359) is a happy path. There are no explicit states for
the failure modes the Conductor itself defines: `blocked_config`, `router_unavailable`,
`baseline_pending`, budget-exhausted, counterfactual-skipped. The transition
`counterfactuals -> judging` says "or counterfactuals are marked skipped" but `skipped`
is not a representable state.

**Fix:** Add `error` and `blocked` as states reachable from *every* working state. Make
`baseline_pending` / `counterfactual_skipped` explicit annotations on the run manifest
that the Report Builder must surface.

### R5 — Dispatcher overhead ill-defined against multi-turn reality (medium)
`max_dispatcher_overhead_ratio: 0.08` is measured per-route as router-tokens ÷
total-tokens. But the product claim is cost per *accepted outcome*, which may span
retries. A candidate that picks lower effort and triggers one retry has near-zero
per-route overhead but terrible per-outcome economics. The Metrics Auditor computes
retry rate and overhead **separately and never combines them.**

**Fix:** Add a derived metric **`cost_per_accepted_outcome` = (executor + router + retry
tokens) / accepted count** and name it the primary PETO objective. Its absence is the
metric most likely to let aggregate savings hide underfit.

### R6 — Determinism/isolation claims not enforceable as written (low-medium)
"Use deterministic sampling seeds" and "freeze config snapshots" are good, but no
artifact records the seed or a content hash of the sample set. Two runs of the same
ticket can't be proven identical.

**Fix:** Add `seed` and `samples_sha256` to `run-manifest.json`. This is what makes a
`regression_check` ticket type meaningful.

## 3. Suggested role merges / splits for V1

Ten agents is too many for V1; several boundaries are bookkeeping, not auditability.

**Merge for V1:**
- **Dispatcher Runner + Baseline Runner → "Route Runner."** Identical logic over the same
  samples; only the loaded config differs. Keep outputs separate (one file per config),
  merge the agent.
- **Conductor + Ship Gate.** The Conductor already "stops the run if a critical gate
  fails." One controller owning gating at entry and exit is *more* auditable (gate logic
  in one place). If you want an independent final go/no-go, keep them split — but then the
  Conductor must not also enforce gates mid-run. Pick one owner.

**Keep separate (non-negotiable):**
- **Quality Judge ↔ Metrics Auditor** — integrity of the whole loop.
- **Counterfactual Executor** — the only agent spending real money / touching real
  outputs; isolated budget owner.
- **Memory Curator** — last; the only one writing durable state.

**Net V1 roster: 7 agents** — Conductor(+Gate), Dataset Curator, Route Runner,
Counterfactual Executor, Quality Judge, Metrics Auditor, Report Builder + Memory Curator.

## 4. Missing schemas / artifacts

1. **`route-event` schema with verification fields** — must explicitly include
   `profile_segment`, `risk_tier`, `language`, `request_class`, `route_id` linking
   request↔response, and `executor_usage` vs `router_usage` as distinct fields. Root fix
   for R1. Today `peto-cli.mjs:245` conflates router and executor usage.
2. **`metrics.json` schema** — referenced everywhere, defined nowhere. Report Builder and
   Ship Gate both consume it; pin it or they improvise field names.
3. **`verdict.json` (Ship Gate output)** — §9 lists verdicts but produces no artifact.
   Memory Curator gates on it but has nothing machine-readable to read. Add
   `{verdict, gates_passed[], gates_failed[], blocking_reason, rollback_ref}`.
4. **`run-manifest.json` schema** — Conductor's primary output, unspecified. Must carry
   `seed`, `samples_sha256`, `config_snapshot_sha256`, `budget`, resolved stratification
   keys.
5. **Centralized `gates.json`** — gates are scattered as per-agent "pass criteria."
   Centralize: each gate, threshold, observed value, hard-vs-soft, pass/fail. This is the
   artifact a human actually reviews.

## 5. Revised minimal implementation order

The handoff's order (plan lines 459-468) is close. Two corrections:

0. **Telemetry precondition pass first (new).** Extend the route event + CLI writer to
   emit `profile_segment`, `request_class`, `language`, `risk_tier`, and split
   `executor_usage` / `router_usage`. Backfill is impossible, so this gates everything.
1. Ticket schema + run directory scaffold + `run-manifest.json` (seed/hashes).
2. Deterministic Dataset Curator (emits `samples.jsonl` + `samples_sha256`).
3. Route Runner (merged dispatcher+baseline) + route JSON validator.
4. Metrics Auditor reusing `evalLogs` from `peto-cli.mjs:339` — **factor `evalLogs` into a
   shared module first** so the CLI and verify loop don't drift. It's inline today; the
   loop will fork it. Extract before reuse.
5. Report Builder + `gates.json` + Ship Gate (merged into Conductor authority).
6. Counterfactual Executor (first agent needing a real budget + sensitive-data policy).
7. Quality Judge + human-review queue + the hard gate that the queue must be cleared
   before promote.
8. RouteLLM comparator — last, as in the original.

**First CLI slice:** `peto verify create --ticket` (validate schema, allocate run id,
scaffold directory, write `run-manifest.json`) **plus** the telemetry-field extension.
That slice unblocks everything and ships in a day. Everything model-driven (judge,
counterfactual) waits.

## 6. RouteLLM integration boundary

Handled correctly — RouteLLM is an optional, explicitly-flagged baseline (plan lines 137,
143-144, 154), never a dependency. One sharpening: the doc says "record model decision
separately from effort decision" but not **what metric they're compared on.** Effort
routing and model routing aren't comparable on token count alone. State the comparison
axis explicitly: **both judged on the same `cost_per_accepted_outcome` (R5)**, with model
and effort recorded as the independent variable. That keeps you from confusing effort
routing vs model routing.

## 7. Specific edits to `docs/symphony-verification-loop.md`

Scoped to the plan doc, in priority order:

1. **Add a "Telemetry Preconditions" section** before Agent Roles: required log fields +
   Conductor hard-fails on missing stratification keys. (R1)
2. **Reclassify `min_net_savings_ratio` as a soft/warning gate** in the ticket schema
   (line 338) and Metrics Auditor pass criteria (line 247); keep underfit delta, JSON
   validity, and per-segment regression as the only hard blockers in V1. (R2)
3. **Add a hard Ship Gate check**: human-review queue empty or signed off before any
   `promote`. (R3)
4. **Add `error` and `blocked` states reachable from every state**; make
   `baseline_pending` / `counterfactual_skipped` explicit manifest annotations. (R4)
5. **Add derived metric `cost_per_accepted_outcome`** (executor+router+retry tokens ÷
   accepted) to the Metrics Auditor and name it the primary PETO objective. (R5, R6)
6. **Add schemas** for `metrics.json`, `verdict.json`, `run-manifest.json` (with `seed` +
   `samples_sha256`), and a centralized `gates.json`. (§4)
7. **Merge Dispatcher Runner + Baseline Runner into "Route Runner"**; collapse Ship Gate
   authority into the Conductor (or explicitly split for independence and remove mid-run
   gating from the Conductor). Drop the roster to 7. (§3)

## Constraint check

All handoff constraints respected by this review:
- Core PETO V1 rule unchanged (effort-only, fixed executor, original request unchanged,
  mechanical telemetry, lessons only when useful).
- RouteLLM kept as optional comparator, not a dependency.
- Savings do not override quality — R2/R3/R5 strengthen this.
- No exact-savings claims without real counterfactuals — R2 enforces it at the gate.
- Verification CLI not implemented; this is review-only.
