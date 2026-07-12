# Agent Instructions For PETO

This file is the canonical project guide for Codex, Claude Code, Gemini CLI,
Cursor, GitHub Copilot, and other coding agents working in this repository.
Platform-specific files should point back here instead of duplicating policy.

## Project Contract

PETO is an effort intelligence layer for AI agents. The V1 contract is
effort-only routing:

- The dispatcher chooses reasoning effort metadata.
- The gateway forwards the original user request unchanged.
- The gateway keeps the executor model fixed unless a user explicitly asks for
  a separate model-routing experiment.
- PETO is not RouteLLM, not an orchestrator, and not a generic proxy.
- MCP tools are for inspection, outcome logging, savings estimates, and durable
  lessons. They are not the primary every-message dispatch path.

When documenting PETO, use user/profile/tenant language. Do not make the system
about a named individual as the analysis unit.

## Instruction Priority

Follow instructions in this order:

1. Direct user instructions for the current turn.
2. Platform-specific project files such as `CLAUDE.md` or `GEMINI.md`.
3. This `AGENTS.md` file.
4. Package README files and local docs.

If instructions conflict, keep the higher-priority instruction and mention the
conflict in your final note.

## Working Boundary

- Check `git status --short` before edits. The worktree may contain user or
  agent changes. Do not revert changes you did not make.
- Keep changes scoped. PETO routing, telemetry, verification, and docs are easy
  to mix together; do not widen the task unless the user asks.
- Do not edit or commit private traffic logs or generated verification data
  under `memory/` unless the user explicitly asks. The directory is ignored for
  a reason.
- Do not treat example configs as live proof. `packages/gateway/peto.config.example.json`
  is a template, not evidence that execution against a real upstream succeeded.
- If a verification claim depends on execution or judge artifacts, inspect the
  current run artifacts before saying it passed.

## Commands

Use these repository commands unless a package-local README gives a narrower
command:

```bash
npm test
npm run check
npm run cli -- doctor
npm run cli -- eval
npm run cli -- verify create --ticket ticket.json
npm run cli -- verify run --id RUN_ID
npm run cli -- verify gate --id RUN_ID
npm run cli -- verify report --id RUN_ID
```

Run the gateway:

```bash
PETO_CONFIG=./peto.config.json npm run gateway
```

Run the local dispatcher:

```bash
PETO_CONFIG=./peto.config.json QWEN_MODEL_DIR=./models/Qwen3-1.7B-Instruct npm run dispatcher:qwen
```

On this Mac, a detached `screen` session is often more reliable than a
LaunchAgent for local dispatcher work under `Documents/`.

## Testing Expectations

- For code changes, run `npm test` and `npm run check` when feasible.
- For dispatcher/routing changes, add or update focused tests. The existing
  pattern in `tests/dispatcher-routing.test.mjs` can call the Python dispatcher
  from Node tests.
- For verification/gate changes, test exact-savings behavior and missing-artifact
  behavior. Do not promote estimated-only evidence as execution proof.
- If Python bytecode cache permissions cause a transient `PermissionError`,
  rerun or isolate the syntax check before blaming the code.

## Effort And Feedback Protocol

This repo includes PETO skills in `skills/`. Agents with skill support should
load `peto-effort-router` before PETO work and use the cheapest effort tier that
can satisfy the user.

When the platform does not support skills, follow the same behavior manually:

1. Classify the request into `minimal`, `low`, `medium`, `high`, or `xhigh`.
2. Answer at that depth.
3. Review whether the result was appropriate, underfit, or overfit.
4. Log durable lessons only when there is a reusable routing signal.

Every final response to the user should include the effort disclosure requested
by the active user instructions when that policy is in scope.

## Platform Notes

### Codex / OpenAI Agents

Codex should read this file automatically. Use local tools first, keep evidence
concrete, and do not claim a pass without current command or artifact evidence.

### Claude Code

Claude Code should read `CLAUDE.md`, then this file. The project-local Claude
skill adapter lives at `.claude/skills/peto-effort-router/SKILL.md`; the
canonical skill content also lives at `skills/peto-effort-router/SKILL.md`.

### Gemini CLI

Gemini should read `GEMINI.md`, then this file. If skill activation is
available, activate the PETO effort router behavior before answering.

### GitHub Copilot

Copilot should read `.github/copilot-instructions.md`, then this file. Keep
suggestions compatible with the scripts in `package.json`.

### Cursor

Cursor should read `.cursor/rules/peto.mdc`, then this file. Keep rules
always-on for this repo because PETO's product contract affects most edits.

## Safe Defaults

- Prefer backward-compatible shims over breaking public call surfaces.
- Preserve existing CLI entrypoints unless the user explicitly asks for a
  breaking change.
- Keep gateway request forwarding unchanged unless the task is specifically
  about request transformation.
- Treat `optimization_segment` as reporting-only unless the user asks to change
  routing policy.
- Use `other` for uncertain request-shape classification instead of forcing a
  brittle label.
