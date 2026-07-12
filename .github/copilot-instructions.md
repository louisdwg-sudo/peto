# GitHub Copilot Instructions

Use `AGENTS.md` as the canonical project guide.

Important PETO constraints:

- V1 is effort-only routing.
- The gateway must forward the original user request unchanged.
- Do not switch executor models unless the user explicitly asks for a separate
  model-routing experiment.
- Keep CLI and public config compatibility when possible.
- For code changes, prefer `npm test` and `npm run check` as the default checks.
