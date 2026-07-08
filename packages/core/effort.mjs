// ---------------------------------------------------------------------------
// Provider-aware effort translation.
//
// PETO chooses a single effort tier (minimal..max). Each upstream provider
// expresses reasoning depth with a different request field:
//
//   OpenAI (Responses API) : reasoning.effort = "<tier>"        (enum)
//   Anthropic (Messages)   : thinking.budget_tokens = <int>     (token budget)
//   Gemini (generateContent): generationConfig.thinkingConfig.thinkingBudget
//                                                    = <int|-1>  (token budget)
//
// This module maps the PETO tier onto whichever field the detected provider
// understands, so the same routing decision takes effect regardless of client.
// ---------------------------------------------------------------------------

// Ordered cheapest -> deepest. `max` sits above `xhigh` because Claude's
// reasoning scale extends past OpenAI's ceiling.
export const EFFORT_TIERS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Default thinking-token budgets for budget-based providers (Anthropic, Gemini).
// Override per-deployment with config.effortBudgets. A budget of 0 means
// "disable extended thinking" for that tier.
export const DEFAULT_EFFORT_BUDGETS = {
  minimal: 0,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 63999,
};

// OpenAI's Responses API has no tier above `high` in the base spec; some
// gateways accept `xhigh`. There is no `max`, so it clamps down to `xhigh`.
const OPENAI_TIER_CLAMP = { max: "xhigh" };

export function detectProvider(config = {}, body = {}) {
  if (config.upstreamProvider) return String(config.upstreamProvider).toLowerCase();
  const url = String(config.upstreamBaseUrl || "").toLowerCase();
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("generativelanguage") || url.includes("googleapis") || url.includes("gemini")) {
    return "gemini";
  }
  // Body-shape hints for gateways that proxy multiple providers behind one URL.
  if (body && typeof body === "object") {
    if (Array.isArray(body.contents)) return "gemini";
    if (body.system !== undefined && Array.isArray(body.messages)) return "anthropic";
  }
  return "openai";
}

export function budgetForTier(tier, config = {}) {
  const budgets = { ...DEFAULT_EFFORT_BUDGETS, ...(config.effortBudgets || {}) };
  return budgets[tier] ?? budgets.medium;
}

// Returns a NEW body with the chosen effort expressed in the provider's field.
// Does not mutate the input.
export function applyEffortToBody(body, tier, provider, config = {}) {
  const next = structuredClone(body ?? {});
  const effort = EFFORT_TIERS.includes(tier) ? tier : config.defaultEffort || "medium";

  switch (provider) {
    case "anthropic": {
      const budget = budgetForTier(effort, config);
      if (budget <= 0) {
        delete next.thinking;
      } else {
        next.thinking = { ...(next.thinking || {}), type: "enabled", budget_tokens: budget };
      }
      return next;
    }
    case "gemini": {
      const budget = budgetForTier(effort, config);
      next.generationConfig = next.generationConfig || {};
      next.generationConfig.thinkingConfig = {
        ...(next.generationConfig.thinkingConfig || {}),
        // -1 tells Gemini to size the thinking budget dynamically (its ceiling).
        thinkingBudget: effort === "max" ? -1 : budget,
      };
      return next;
    }
    case "openai":
    default: {
      const openaiEffort = OPENAI_TIER_CLAMP[effort] || effort;
      next.reasoning = { ...(next.reasoning || {}), effort: openaiEffort };
      return next;
    }
  }
}

// Best-effort read of the effort already present on an incoming request, used
// for logging and savings estimates. Returns null when it cannot be inferred.
export function readIncomingEffort(body, provider) {
  if (!body || typeof body !== "object") return null;
  switch (provider) {
    case "anthropic":
      return typeof body.thinking?.budget_tokens === "number"
        ? `budget:${body.thinking.budget_tokens}`
        : null;
    case "gemini": {
      const b = body.generationConfig?.thinkingConfig?.thinkingBudget;
      return typeof b === "number" ? `budget:${b}` : null;
    }
    case "openai":
    default:
      return typeof body.reasoning?.effort === "string" ? body.reasoning.effort : null;
  }
}
