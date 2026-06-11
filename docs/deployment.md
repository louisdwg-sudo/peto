# Deployment

PETO should be distributed as a repo with multiple adapters, not as a skill alone.

## Why A Repo

A skill can guide agent behavior, but it usually cannot intercept every model call. PETO needs a dispatch point that sees each request before execution. That makes a repo with a gateway, MCP adapter, CLI, schemas, and optional skills the right package shape.

## Recommended V1

```text
client
-> PETO gateway
-> dispatcher model
-> executor model
-> telemetry log
```

Configuration:

```yaml
dispatcher:
  model: gpt-5.4-mini
  effort: low

executor:
  model: gpt-5.5

routing:
  mode: effort_only
  allowed_efforts:
    - minimal
    - low
    - medium
    - high
    - xhigh
```

## Adapters

### Gateway Adapter

Best for clients that can set an OpenAI-compatible `base_url`.

Responsibilities:

- receive the original request
- retrieve a small number of relevant routing lessons
- call the dispatcher
- validate route JSON
- rewrite only effort metadata
- forward the original request unchanged
- log request and response telemetry

### MCP Adapter

Best for agents that cannot use a proxy.

Suggested tools:

- `peto_route`
- `peto_log_outcome`
- `peto_estimate_savings`
- `peto_write_lesson`

### CLI Adapter

Best for local testing and reproducible evaluation.

Suggested commands:

- `peto route`
- `peto eval`
- `peto doctor`
- `peto replay`

### Skill Adapter

Best for Codex behavior and review discipline. A skill should complement the gateway, not replace it.

## Public Config Principle

Do not hardcode personal paths, API keys, or model names. Publish examples with placeholders and allow users to swap in local or hosted dispatcher models.

