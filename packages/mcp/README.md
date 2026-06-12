# PETO MCP Server

This MCP server is a support layer, not the primary dispatcher.

Use the gateway for every-message pre-inference routing. Use MCP tools for inspection, outcome logging, savings estimates, and durable lessons.

## Run

```bash
PETO_CONFIG=./peto.config.json node packages/mcp/peto-mcp-server.mjs
```

## Tools

- `peto_health` - report config and log paths.
- `peto_latest_route` - return the latest request/response route pair.
- `peto_log_outcome` - append reviewer outcome metadata.
- `peto_estimate_savings` - estimate savings against an xhigh baseline.
- `peto_write_lesson` - write a contextual dispatcher lesson.

## Boundary

An MCP tool cannot guarantee routing for every message because the assistant has to be invoked before it can call a tool. PETO needs the gateway/proxy as the primary dispatch layer when every-message routing is required.

