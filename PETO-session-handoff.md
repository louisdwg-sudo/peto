# PETO Session Handoff

## Working Name

**PETO: Personalized Effort and Tokenomics Optimization via LLMWiki**

## Core Idea

PETO is a personalized dispatcher system that optimizes LLM reasoning effort and token spend based on user-specific satisfaction, retry history, output acceptance standards, and structured long-term memory.

The purpose is not generic model routing. The purpose is:

> Optimize user-accepted output quality per token spent.

## Main Thesis

Public benchmarks and generic model routers optimize for average users. PETO optimizes for each user's or tenant's observed acceptance threshold.

A simple question may only need a cheap, low-effort response. A high-stakes or quality-sensitive task may need higher effort. The system should learn this from long-term feedback rather than fixed task categories.

## Proposed Architecture

```text
User input in Codex
-> mini dispatcher at low effort
-> dispatcher chooses model + effort
-> original user input is forwarded unchanged
-> main model executes
-> telemetry is logged
-> feedback/retry/satisfaction signals update LLMWiki
-> future similar requests use retrieved lessons to adjust effort
```

## Dispatcher Role

Dispatcher should be a cheap model, likely `gpt-5.4-mini` at `low` effort initially.

Dispatcher has one job only:

```text
Choose target model and reasoning effort.
```

It must not:

- Rewrite the user's original request.
- Summarize the user request for execution.
- Add hidden requirements.
- Answer the user.
- Recursively route itself.

Suggested dispatcher output:

```json
{
  "target_model": "gpt-5.5",
  "target_effort": "medium",
  "confidence": 0.82,
  "rationale_short": "Needs multi-step reasoning but not a high-risk long task.",
  "recording_priority": "normal"
}
```

## Reviewer / Logger Role

Codex / main assistant remains the reviewer, logger, and LLMWiki maintainer.

Recommended effort:

```text
Default reviewer/logger effort: medium
Use high for failure postmortems, explicit user dissatisfaction, or when Codex recommends lowering future effort standards.
Avoid xhigh for routine logging.
```

## Feedback Rules

Dispatcher RAG records every dispatch decision in logs.

Only write durable feedback analysis into LLMWiki when:

1. The user explicitly expresses dissatisfaction with quality or effort.
2. Codex decides the same quality could have been achieved with lower effort.
3. A retry/escalation materially changes the future best effort.
4. The user or operator manually says to record it.

If Codex recommends a lower future effort for a similar situation, that lower effort becomes the suggested future standard unless the relevant user profile later rejects that output quality.

If the user rejects output with terms like "shit", "sucks", "trash", "rubbish", "not right", "you missed", "reject", or equivalent, mark the prior route as failed/questionable and update the lesson.

## LLMWiki Structure

Three separate LLMWiki knowledge banks were created conceptually:

```text
dispatcher/
  logs/
  lessons/
  model-registry/
  policy/

louis-dev/
  preferences/
  uiux/
  product-logic/
  mistake-patterns/
  glossary/
  inbox/

corporate-ai-automation/
  sources/
  company-cases/
  workflows/
  playbooks/
  vendor-notes/
  consulting-frameworks/
  inbox/
```

The three wikis should remain separate:

- `dispatcher`: effort/model/token routing.
- `user-dev`: user, tenant, or operator product/dev/UIUX/cost preferences.
- `corporate-ai-automation`: knowledge base for future corporate AI consulting business.

## Existing Local Vault Path

A first Markdown LLMWiki scaffold was created at:

```text
/Users/louis/Documents/LLMWiki
```

Important files created:

```text
/Users/louis/Documents/LLMWiki/README.md
/Users/louis/Documents/LLMWiki/dispatcher/policy/dispatch-policy.md
/Users/louis/Documents/LLMWiki/dispatcher/policy/router-contract.md
/Users/louis/Documents/LLMWiki/dispatcher/model-registry/initial-router-candidates.md
/Users/louis/Documents/LLMWiki/louis-dev/preferences/cost-and-scope.md
/Users/louis/Documents/LLMWiki/louis-dev/preferences/codex-as-primary-workspace.md
/Users/louis/Documents/LLMWiki/louis-dev/product-logic/mvp-standards.md
/Users/louis/Documents/LLMWiki/louis-dev/uiux/design-preferences.md
/Users/louis/Documents/LLMWiki/corporate-ai-automation/consulting-frameworks/ai-automation-opportunity-map.md
```

Lightweight scripts created:

```text
/Users/louis/Documents/LLMWiki/scripts/append-routing-event.mjs
/Users/louis/Documents/LLMWiki/scripts/new-note.mjs
```

## Research Context

This specific PETO framing is not a mature standard product category yet, but it combines existing research/engineering directions:

- Adaptive reasoning effort.
- Personalized LLM routing.
- Cost-aware routing/cascades.
- User preference learning.
- RAG-based long-term memory.
- Contextual bandit feedback.

Relevant terms to search:

```text
personalized LLM routing
adaptive reasoning effort
reasoning token optimization
RAG-assisted effort calibration
preference-aware LLM routing
contextual bandit LLM routing
personalized RAG
tokenomics optimization
```

Related systems/papers/ideas discussed:

- Ares: Adaptive Reasoning Effort Selection.
- PersonalizedRouter.
- GMTRouter.
- PRELUDE / CIPHER.
- Personalized RAG / CFRAG.
- LLM Routing with Dueling Feedback.
- FrugalGPT.
- RouteLLM.
- Azure retrieval reasoning effort.
- NVIDIA RAG reasoning controls.

## Key Design Decision

PETO should not start by building a huge taxonomy of task types.

Instead:

```text
Use minimal safety/policy guardrails
+ cheap dispatcher
+ honest telemetry
+ user-specific feedback
+ LLMWiki lessons
+ periodic review
```

The core asset is not the dispatcher model. The core asset is the feedback-rich LLMWiki.

## Suggested Next Build Step

Create a local OpenAI-compatible router gateway:

```text
Codex
-> local gateway
-> gpt-5.4-mini low-effort dispatcher
-> rewrite only model/reasoning.effort
-> forward original request unchanged
-> log telemetry
-> return response to Codex
```

Codex config would eventually point to:

```toml
[model_providers.router]
name = "Local PETO Router"
base_url = "http://127.0.0.1:8787"
wire_api = "responses"
```

The gateway must be safe to fail open or fall back to default routing.
