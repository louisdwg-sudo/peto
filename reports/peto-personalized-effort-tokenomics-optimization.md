# PETO: Personalized Effort and Tokenomics Optimization

## Abstract

Large language model systems increasingly expose a new control surface: how much reasoning effort to spend before answering. The obvious use case is cost optimization. The practical use case is more subtle: spend the least effort that still produces an answer the user accepts.

This report introduces **PETO**, or **Personalized Effort and Tokenomics Optimization**. PETO argues that effort routing should not be governed only by generic task categories such as "translation", "research", or "coding". The same task can require different effort depending on the user's acceptance threshold, stakes, tone sensitivity, prior failures, language context, and tolerance for rework.

PETO is therefore not just an LLM router. It is a personalized feedback system for finding the lowest-cost path to user-accepted work.

## The Problem With Generic Effort Routing

Generic routing assumes that task type is enough to estimate required effort. This is useful but incomplete.

A short translation can be trivial when used for private understanding. The same translation can require higher effort when it is customer-facing, legally sensitive, brand-sensitive, or culturally nuanced. A quick code question can be minimal effort when the user asks for a command, but high effort when the answer changes production architecture.

The flaw is not that task categories are useless. The flaw is treating them as sufficient.

PETO starts from a different objective:

```text
lowest cost per answer the user accepts
```

This objective is personalized by definition. Acceptance depends on the user, not merely the prompt.

## PETO Thesis

Effort and token optimization becomes practical when it is personalized.

Public benchmarks and generic routers optimize for average performance. PETO optimizes for each user profile's actual acceptance curve. It learns from real interactions:

- explicit rejection
- retry requests
- escalation after underfit
- reviewer-identified overfit
- accepted lower-effort outputs
- token usage and latency
- durable user preferences

The dispatcher does not need to be brilliant. It needs to be cheap, consistent, and connected to feedback memory.

## PETO V1 Architecture

The first deployable PETO version should stay deliberately simple.

```text
every message
-> one cheap dispatcher model
-> choose effort only
-> fixed executor model
-> log route and outcome
-> executor/reviewer records lessons when useful
```

V1 should avoid model switching, second-stage arbiters, and complex approval paths. Those can be tested later. The first priority is clean data.

### Dispatcher

The dispatcher receives:

- the latest user request
- a small number of relevant routing lessons
- the allowed effort levels

The dispatcher returns:

```json
{
  "target_effort": "minimal|low|medium|high|xhigh",
  "confidence": 0.84,
  "rationale_short": "Needs synthesis but not production-risk depth.",
  "recording_priority": "normal",
  "needs_review": false
}
```

The dispatcher must not answer the user, rewrite the prompt, change intent, or add hidden requirements.

### Executor And Reviewer

The executor answers the user's original request at the chosen effort. Afterward, it acts as reviewer/logger.

Visible review should be tiny:

```text
Effort review: appropriate, no lesson.
Effort review: overfit, lesson logged.
Effort review: underfit, lesson logged.
Effort review: uncertain, monitor next.
```

Full review should be logged to memory only when useful: underfit, overfit, rejection, retry, escalation, cost anomaly, or reusable routing lesson.

### Memory

PETO memory stores routing outcomes, not generic prompt hacks.

A good durable lesson is contextual:

```text
Short command lookup with no file edits accepted minimal effort.
```

A weak lesson is universal:

```text
All command questions are minimal.
```

The difference matters. PETO should learn user-specific routing boundaries, not brittle global rules.

## Evaluation Method

PETO should be evaluated against user-accepted quality per token.

Core metrics:

- acceptance rate
- explicit rejection rate
- retry/escalation rate
- overfit rate
- underfit rate
- estimated savings versus default xhigh
- dispatcher overhead
- latency impact
- route JSON validity

The most important measurement is underfit risk. Saving tokens is not a win if the user needs a retry.

### Feedback Semantics

Explicit rejection terms such as "shit", "trash", "rubbish", "not right", "you missed", "reject", or "redo" should be treated as underfit only when clearly aimed at the assistant output. Quoted text, examples, unrelated profanity, or descriptions of another model's output should not count.

Silence from the reviewer is not enough. PETO uses a tiny visible review line so the system can remain accountable without wasting response tokens.

### Token Savings

Token savings should be reported honestly:

- exact when an xhigh counterfactual was actually run
- estimated when using matched historical baselines
- baseline pending when no credible baseline exists

For normal operation, estimated savings are acceptable. Fake precision is not.

## Relationship To Existing Work

PETO combines several active directions in LLM systems.

**Cost-aware cascades.** FrugalGPT showed that cascading across models can reduce inference cost while preserving quality for many workloads. PETO borrows the cost-awareness but shifts the target from generic quality to user acceptance. See [FrugalGPT](https://arxiv.org/abs/2305.05176).

**LLM routing.** RouteLLM frames routing as selecting between stronger and weaker models based on preference data and cost-quality tradeoffs. PETO narrows this into a user-personalized, effort-focused loop. See [RouteLLM](https://arxiv.org/abs/2406.18665).

**Adaptive reasoning effort.** Ares studies adaptive reasoning effort selection for agentic tasks, showing that effort can be selected dynamically rather than fixed globally. PETO applies the same spirit to ongoing user interactions. See [Ares](https://arxiv.org/abs/2603.07915).

**Reasoning controls.** OpenAI's reasoning models expose effort controls that influence how many reasoning tokens a model may spend before answering. PETO treats this as a routing surface to be learned from feedback, not a static setting. See OpenAI's [reasoning models guide](https://platform.openai.com/docs/guides/reasoning).

**Local dispatch candidates.** Open models such as Qwen2.5 can be tested as low-cost local dispatchers when JSON reliability, latency, bilingual handling, and underfit risk are acceptable. See the [Qwen2.5 technical report](https://arxiv.org/abs/2412.15115) and [Qwen2.5 model release](https://qwenlm.github.io/blog/qwen2.5/).

## Deployment Shape

PETO should be distributed as a repository with adapters:

```text
peto/
  packages/
    core/
    gateway/
    mcp/
    cli/
  skills/
  docs/
  reports/
  examples/
```

The gateway is the best adapter for clients that can point to an OpenAI-compatible `base_url`. MCP is useful for agents that cannot use a proxy. CLI tools are useful for replay, benchmarking, and diagnostics. Skills help agents follow PETO behavior but should not be the only deployment mechanism because they usually cannot intercept every message.

## Why Personalization Is The Point

The core PETO asset is not the dispatcher model. The core asset is the feedback memory.

A cheap dispatcher with good memory can outperform a stronger generic dispatcher that does not know the target user profile. A static routing taxonomy can only say "coding often needs high effort". PETO can learn that one profile accepts minimal effort for shell commands, another expects high effort for public-facing architecture, and another rejects underbuilt product thinking.

That is the practical difference between ETO and PETO:

```text
ETO: optimize effort and tokens for the task.
PETO: optimize effort and tokens for the target user profile's accepted outcome.
```

## Conclusion

PETO proposes a simple, testable claim: effort routing should be personalized through feedback, not only assigned by task category.

The first implementation should stay boring:

- one cheap dispatcher
- effort-only routing
- fixed executor
- mechanical telemetry
- tiny visible review
- durable lessons only when useful

If PETO works, it should reduce unnecessary high-effort calls without increasing user-visible failure. If it fails, the logs should make the failure obvious: underfit rose, retries increased, or savings were eaten by dispatcher overhead.

That makes PETO useful as both a methodology and an engineering experiment. It does not need to be perfect on day one. It needs to learn from the user faster than a generic router can.
