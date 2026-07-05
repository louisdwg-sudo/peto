# PETO Gateway

This is the OpenAI-compatible PETO dispatch gateway.

It sits between a client and an upstream model provider:

```text
client
-> PETO gateway
-> dispatcher chooses effort
-> original request forwarded unchanged with routed effort
-> upstream executor responds
-> telemetry is logged
```

## Run

Copy the example config:

```bash
cp packages/gateway/peto.config.example.json peto.config.json
```

Edit:

- `upstreamBaseUrl`
- `routerBackend`, `localRouterUrl`, and `routerModel`
- `defaultTargetModel`
- log/memory paths if needed

Start the local Qwen dispatcher first:

```bash
export QWEN_MODEL_DIR="/path/to/Qwen2.5-1.5B-Instruct"
PETO_QWEN_PYTHON="/path/to/python" PETO_QWEN_PORT=8789 \
  packages/dispatcher/start-local-qwen-dispatcher.sh
```

Start:

```bash
PETO_CONFIG=./peto.config.json node packages/gateway/router-gateway.mjs
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Point a compatible client at:

```text
http://127.0.0.1:8787
```

## V1 Constraint

This gateway is effort-only by default. It does not switch executor models, call a second-stage arbiter, or rewrite the user request.

## Telemetry

The gateway logs route events using PETO verification schema `1.0`.

- request events include `route_id`, `profile_segment`, `risk_tier`, `language`, `request_class`, `connected_app_required`, `memory_lookup_needed`, `router_usage`, `executor_usage: null`, `acceptance_label`, and `annotations`
- response events include the same `route_id`, `executor_usage`, and a backward-compatible `usage` alias
- router usage and executor usage stay separate so the CLI can compute dispatcher overhead and cost per accepted outcome

Useful inspection commands:

```bash
npm run cli -- replay --limit 10
npm run cli -- feedback --route-id ROUTE_ID --label accepted
npm run cli -- eval
npm run cli -- verify create --ticket ticket.json
npm run cli -- verify run --id RUN_ID
npm run cli -- verify gate --id RUN_ID
npm run cli -- verify report --id RUN_ID
```

## Dispatcher Backends

Use `routerBackend: "local_http"` when a local dispatcher service is available. The gateway will call `localRouterUrl`, validate the returned effort, apply only `reasoning.effort`, and forward the original request to the upstream executor.

Use `routerBackend: "openai_responses"` when routing through a hosted OpenAI-compatible Responses API model. This is useful for comparison runs, but PETO v1 testing should prefer the local Qwen backend when the goal is stable every-message dispatch without hosted router rate limits.

On macOS, if a LaunchAgent cannot read a model or virtualenv under `Documents`, run the dispatcher in a detached user session instead:

```bash
screen -dmS peto-qwen /bin/zsh -lc 'cd /path/to/peto && \
  export QWEN_MODEL_DIR="/path/to/Qwen2.5-1.5B-Instruct" && \
  export PETO_QWEN_PYTHON="/path/to/python" && \
  export PETO_QWEN_PORT=8789 && \
  packages/dispatcher/start-local-qwen-dispatcher.sh'
```
