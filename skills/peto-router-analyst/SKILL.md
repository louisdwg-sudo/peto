---
name: peto-router-analyst
description: Analyze PETO routing logs, classify effort fit, identify overfit/underfit events, and write durable dispatcher lessons only when there is a reusable routing signal.
---

# PETO Router Analyst

Use this skill when reviewing PETO router events, effort choices, feedback signals, or lesson candidates.

## Workflow

1. Load the relevant route events and response usage.
2. Match request and response phases by event id.
3. Classify the turn:
   - `appropriate`
   - `overfit`
   - `underfit`
   - `unknown`
4. Treat explicit user rejection as underfit only when aimed at the assistant output.
5. Treat reviewer claims of cheaper equivalent quality as overfit only when the request context is specific enough to reuse.
6. Write durable lessons only for reusable signals.

## Lesson Quality Bar

A good lesson names:

- the request pattern
- the chosen effort
- the observed outcome
- the recommended future effort
- the boundary where the lesson should stop applying

Avoid universal task labels such as `coding = high` or `translation = low`.

## Output

Lead with findings. Include counts and representative examples when reviewing multiple events.

