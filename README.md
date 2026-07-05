# PETO

**Effort intelligence layer for AI agents.**

PETO routes every request to the cheapest reasoning level likely to satisfy the user — then measures whether it worked, with proof-grade evidence.

> "PETO makes AI agents economically self-aware: every turn is routed to the cheapest reasoning level likely to satisfy the user, with proof-grade evidence for savings and underfit."

**Proven on real traffic:** ~17.6% exact token savings vs fixed-xhigh baseline. All verification gates passed.

---

## Why PETO

Every AI API request is treated as equally important today. A user typing "try" gets the same `xhigh` reasoning budget as a complex architecture review.

PETO fixes this with a pre-inference effort calibration layer:

```
user request
  → PETO dispatcher (cheap, local or hosted)
  → picks effort: minimal / low / medium / high / xhigh
  → forwards unchanged to your executor model
  → logs usage and outcome
  → learns from acceptance / rejection over time
```

No prompt changes. No model changes. Just point your client at `http://localhost:8787` instead of your upstream API.

## What PETO is not

- Not a model router — PETO owns effort, [RouteLLM](https://github.com/lm-sys/RouteLLM) owns model selection. They compose.
- Not an orchestrator or agent framework
- Not a generic proxy — it adds effort intelligence, not just forwarding

---

## Quick start

See [QUICKSTART.md](QUICKSTART.md) — two paths:

- **Option A** — Local Qwen3-1.7B (private, no API cost, Apple Silicon)
- **Option B** — Hosted small model router (5 minutes, no download)

---

## Architecture

```
Client (Codex, Claude Code, Cursor, any OpenAI-compatible)
  ↓  base_url = http://localhost:8787
PETO Gateway  (OpenAI-compatible proxy)
  → dispatcher classifies effort
  → injects effort into upstream request
  → logs telemetry
  ↓
Upstream model (Claude, GPT, Gemini, local)
```

The dispatcher runs locally (Qwen3-1.7B on Apple Silicon) or via any cheap hosted API. No data leaves your machine unless you configure a hosted router.

---

## Packages

| Package | Purpose |
|---|---|
| `packages/gateway/` | OpenAI-compatible proxy — the main control point |
| `packages/dispatcher/` | Local Qwen3-1.7B effort classifier |
| `packages/core/` | Eval, telemetry, verification, quality judge |
| `packages/cli/` | `peto` CLI: route, eval, feedback, verify |
| `packages/mcp/` | MCP tools for observability |
| `skills/peto-effort-router/` | SKILL.md for Claude Code / Codex |

---

## Verification harness

PETO ships a full offline verification pipeline. Run proof-grade counterfactual comparisons on your own traffic:

```bash
peto verify create --ticket ticket.json
peto verify execute --id my-run
peto verify gate --id my-run
peto verify report --id my-run
```

Savings are only claimed when both candidate and baseline executed successfully (matched-pair integrity enforced).

See [docs/peto-v1-launch-contract.md](docs/peto-v1-launch-contract.md) for the V1 proof methodology and [docs/evaluation.md](docs/evaluation.md) for telemetry schema.

---

## Effort skill (no gateway needed)

Load into Claude Code or Codex for behavior-layer effort routing:

```
skills/peto-effort-router/SKILL.md
```

Teaches the agent to pre-route effort, post-review its own responses, and log acceptance signals.

---

## Requirements

- Node.js 18+
- Python 3.9+ (Option A local dispatcher only)
- An OpenAI-compatible upstream API

---

## License

MIT
