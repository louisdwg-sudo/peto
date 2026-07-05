# PETO Effort Router

Apply this skill when you want Claude to route each request to the cheapest reasoning level that satisfies the user, log acceptance signals, and flag underfit or overfit automatically.

## When to apply

Always — on every turn, before answering. This skill is a pre-inference calibration layer, not a one-off command.

## Effort tiers

| Tier | Use when |
|---|---|
| `minimal` | One-word or one-line answer, lookup, yes/no |
| `low` | Short factual answer, simple clarification, status check |
| `medium` | Multi-step explanation, moderate coding task, analysis |
| `high` | Complex reasoning, architecture review, non-trivial debugging |
| `xhigh` | Deep research, large refactor, multi-file reasoning, creative synthesis |

## Pre-inference routing (do this before every response)

1. Read the user request.
2. Classify the effort tier needed — pick the cheapest tier that will satisfy the user.
3. Calibrate your response depth to that tier. Do not over-explain at `minimal`. Do not under-deliver at `high`.
4. If you are unsure between two tiers, pick the lower one and check after answering.

## Post-inference review (do this after every response)

After answering, add a one-line effort review at the end:

```
Effort review: <tier used> — <accepted | underfit | overfit | uncertain>
```

Examples:
```
Effort review: medium — accepted
Effort review: low — underfit (user asked to actually run the command, not just explain)
Effort review: high — overfit (a medium answer would have sufficed)
Effort review: medium — uncertain (user did not confirm)
```

If the result is `underfit`, escalate on the next turn without being asked.
If the result is `overfit`, note it so future similar requests can be routed lower.

## Acceptance signal logging

When using the PETO gateway, explicit feedback can be logged:

```bash
peto feedback --route-id <id> --label accepted|underfit|overfit|rejected
```

When not using the gateway, the effort review line itself is the signal. Keep it consistent — it trains the flywheel.

## What counts as underfit

- User asked to do the work; you explained or outlined instead
- User asked for concrete output; you asked clarifying questions that weren't necessary
- Response was too shallow for the complexity of the request
- User had to ask again or escalate

## What counts as overfit

- You wrote a five-paragraph explanation for a one-liner question
- You refactored code the user didn't ask to refactor
- You added caveats, alternatives, and edge cases for a simple lookup

## What counts as accepted

- User proceeded with your output without correction
- User explicitly confirmed or approved
- No follow-up asking for more depth or correction

## PETO gateway integration (optional)

If a PETO gateway is running at `http://127.0.0.1:8787`, point your client `base_url` there. The gateway will:
- Route each request to the cheapest effort tier automatically
- Log token usage for candidate vs baseline comparison
- Generate proof-grade savings evidence via `peto verify`

You do not need the gateway for this skill to work. The skill operates at the behavior layer. The gateway operates at the infrastructure layer.

## Key principle

Never save tokens at the cost of user satisfaction. The goal is not the cheapest answer — it is the cheapest answer that fully satisfies the user. When in doubt, err toward quality.
