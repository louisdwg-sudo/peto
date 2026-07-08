import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EFFORT_BUDGETS,
  EFFORT_TIERS,
  applyEffortToBody,
  budgetForTier,
  detectProvider,
  readIncomingEffort,
} from "../packages/core/effort.mjs";

test("EFFORT_TIERS includes max above xhigh", () => {
  assert.deepEqual(EFFORT_TIERS, ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.ok(EFFORT_TIERS.indexOf("max") > EFFORT_TIERS.indexOf("xhigh"));
});

test("detectProvider honors explicit config override", () => {
  assert.equal(detectProvider({ upstreamProvider: "Anthropic" }, {}), "anthropic");
});

test("detectProvider infers provider from upstream URL", () => {
  assert.equal(detectProvider({ upstreamBaseUrl: "https://api.anthropic.com" }, {}), "anthropic");
  assert.equal(
    detectProvider({ upstreamBaseUrl: "https://generativelanguage.googleapis.com" }, {}),
    "gemini",
  );
  assert.equal(detectProvider({ upstreamBaseUrl: "https://api.openai.com" }, {}), "openai");
});

test("detectProvider falls back to body shape then openai", () => {
  assert.equal(detectProvider({}, { contents: [] }), "gemini");
  assert.equal(detectProvider({}, { system: "s", messages: [] }), "anthropic");
  assert.equal(detectProvider({}, { input: "hi" }), "openai");
});

test("openai translation writes reasoning.effort and clamps max to xhigh", () => {
  const high = applyEffortToBody({ model: "gpt-5.5" }, "high", "openai", {});
  assert.equal(high.reasoning.effort, "high");
  const max = applyEffortToBody({ model: "gpt-5.5" }, "max", "openai", {});
  assert.equal(max.reasoning.effort, "xhigh");
});

test("anthropic translation writes thinking.budget_tokens from tier budgets", () => {
  const out = applyEffortToBody({ model: "claude-sonnet-5" }, "high", "anthropic", {});
  assert.equal(out.thinking.type, "enabled");
  assert.equal(out.thinking.budget_tokens, DEFAULT_EFFORT_BUDGETS.high);
  assert.equal(out.reasoning, undefined, "must not leak the OpenAI field");
});

test("anthropic minimal tier disables extended thinking", () => {
  const out = applyEffortToBody({ thinking: { type: "enabled", budget_tokens: 9999 } }, "minimal", "anthropic", {});
  assert.equal(out.thinking, undefined);
});

test("gemini translation writes thinkingBudget and uses -1 for max", () => {
  const high = applyEffortToBody({}, "high", "gemini", {});
  assert.equal(high.generationConfig.thinkingConfig.thinkingBudget, DEFAULT_EFFORT_BUDGETS.high);
  const max = applyEffortToBody({}, "max", "gemini", {});
  assert.equal(max.generationConfig.thinkingConfig.thinkingBudget, -1);
});

test("config.effortBudgets overrides default budgets", () => {
  const config = { effortBudgets: { high: 12345 } };
  assert.equal(budgetForTier("high", config), 12345);
  const out = applyEffortToBody({}, "high", "anthropic", config);
  assert.equal(out.thinking.budget_tokens, 12345);
});

test("applyEffortToBody does not mutate the input body", () => {
  const body = { model: "gpt-5.5", reasoning: { effort: "xhigh" } };
  const out = applyEffortToBody(body, "low", "openai", {});
  assert.equal(body.reasoning.effort, "xhigh", "input untouched");
  assert.equal(out.reasoning.effort, "low");
});

test("unknown tier falls back to config default effort", () => {
  const out = applyEffortToBody({}, "bogus", "openai", { defaultEffort: "medium" });
  assert.equal(out.reasoning.effort, "medium");
});

test("readIncomingEffort reads the right field per provider", () => {
  assert.equal(readIncomingEffort({ reasoning: { effort: "high" } }, "openai"), "high");
  assert.equal(readIncomingEffort({ thinking: { budget_tokens: 8192 } }, "anthropic"), "budget:8192");
  assert.equal(
    readIncomingEffort({ generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } }, "gemini"),
    "budget:4096",
  );
  assert.equal(readIncomingEffort({}, "openai"), null);
});
