# PETO Gateway

This is the OpenAI-compatible PETO dispatch gateway.

It sits between a client and an upstream model provider:

```text
client
-> PETO gateway
-> cheap dispatcher chooses effort
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
- `routerModel`
- `defaultTargetModel`
- log/memory paths if needed

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

