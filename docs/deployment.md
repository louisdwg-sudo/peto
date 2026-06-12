# Deployment

PETO should be distributed as a repo with multiple adapters, not as a skill alone.

## Why A Repo

A skill can guide agent behavior, but it usually cannot intercept every model call. PETO needs a dispatch point that sees each request before execution. That makes a repo with a gateway, MCP adapter, CLI, schemas, and optional skills the right package shape.

## Recommended V1

```text
client
-> PETO gateway
-> dispatcher model or local dispatcher service
-> executor model
-> telemetry log
```

Configuration:

```yaml
dispatcher:
  backend: local_http
  model: Qwen2.5-1.5B-Instruct-local
  url: http://127.0.0.1:8788/route

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
- call the dispatcher backend
- validate route JSON
- rewrite only effort metadata
- forward the original request unchanged
- log request and response telemetry

The reference gateway lives at:

```text
packages/gateway/router-gateway.mjs
```

### Local Qwen Dispatcher

Best for PETO v1 data testing when the dispatcher must run on every message without depending on a hosted mini model.

Responsibilities:

- load Qwen once and keep it warm
- receive route-only JSON requests from the gateway
- choose `target_effort`
- return strict route metadata
- fall back to deterministic heuristics if the small model emits invalid JSON

The reference local dispatcher lives at:

```text
packages/dispatcher/local-qwen-dispatcher.py
```

Start it before the gateway:

```bash
export QWEN_MODEL_DIR="/path/to/Qwen2.5-1.5B-Instruct"
PETO_QWEN_PYTHON="/path/to/python" PETO_QWEN_PORT=8789 \
  packages/dispatcher/start-local-qwen-dispatcher.sh
```

Then configure the gateway with:

```json
{
  "routerBackend": "local_http",
  "localRouterUrl": "http://127.0.0.1:8789/route",
  "routerModel": "Qwen2.5-1.5B-Instruct-local"
}
```

For local machines that already use port `8788`, use `8789` or any free localhost port and keep `localRouterUrl` aligned with `PETO_QWEN_PORT`.

### MCP Adapter

Best for support tasks: inspection, outcome logging, savings estimates, lesson writing, and offline evaluation. MCP is not the primary every-message dispatcher because a model must already be running before it can choose to call a tool.

Suggested tools:

- `peto_latest_route`
- `peto_log_outcome`
- `peto_estimate_savings`
- `peto_write_lesson`

The reference MCP server lives at:

```text
packages/mcp/peto-mcp-server.mjs
```

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
