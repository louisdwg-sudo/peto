# PETO Methodology

PETO stands for **Personalized Effort and Tokenomics Optimization**.

## Thesis

Effort routing becomes practical when it is personalized. A task label such as "translation", "research", or "coding" is too coarse to determine the right reasoning effort. The needed effort depends on the user's acceptance threshold, stakes, context, taste, language, retry history, and prior failures.

PETO therefore optimizes for:

```text
lowest cost per answer the user accepts
```

not merely:

```text
lowest cost per answer
```

## V1 Operating Rule

Use a single cheap dispatcher model for every message. It chooses only effort.

```text
user input
-> cheap dispatcher
-> effort decision
-> original input forwarded unchanged
-> fixed executor model answers
-> telemetry is logged
-> executor reviews effort fit
-> durable lesson is written only when useful
```

V1 intentionally does not use a second-stage arbiter, model switching, or human approval loops. Clean data matters more than clever routing.

## Feedback Signals

Strong underfit signal:

- The user explicitly rejects the output.
- The user asks for a retry because quality was inadequate.
- The output required escalation to satisfy the same request.

Strong overfit signal:

- The executor/reviewer says the same quality likely needed lower effort.
- Historical matched requests show a lower effort was accepted.

Weak acceptance signal:

- The user continues the task without complaint.
- The answer is accepted implicitly by follow-up work.

Important: rejection keywords count only when clearly aimed at the output. Quoted material, examples, or unrelated context must not be treated as dissatisfaction.

## Reviewer Behavior

The executor/reviewer should reveal only a five-word effort review line in normal conversation. It may write a full review to memory when useful.

Durable review is warranted for:

- underfit
- overfit
- rejection
- retry or escalation
- cost anomaly
- reusable routing lesson

Routine acceptable turns do not need verbose memory writes.

## Token Savings

PETO may report estimated savings against a default extra-high baseline. Savings should be labeled as estimates unless a real counterfactual extra-high run exists.

Recommended footer field:

```text
Estimated xhigh savings: ~N tokens / ~P%
```

If there is no baseline:

```text
Estimated xhigh savings: baseline pending
```

