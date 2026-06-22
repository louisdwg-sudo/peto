import { EFFORTS, loadConfig } from "./config.mjs";
import { readJsonl } from "./jsonl.mjs";
import { normalizeAcceptanceLabel, normalizeRouteEvent } from "./telemetry.mjs";

export function groupRoutes(events) {
  const normalized = events.map(normalizeRouteEvent);
  const responses = new Map(normalized.filter(event => event.phase === "response").map(event => [event.route_id, event]));
  return normalized
    .filter(event => event.phase === "request")
    .map(request => ({ request, response: responses.get(request.route_id) || null }));
}

export function median(values) {
  const nums = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  return nums[Math.floor(nums.length / 2)];
}

export function sumUsageTokens(usages) {
  let total = 0;
  let seen = false;
  for (const usage of usages) {
    if (!usage) continue;
    const value =
      usage.total_tokens ??
      usage.totalTokens ??
      (Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens)
        ? (usage.input_tokens || 0) + (usage.output_tokens || 0)
        : undefined);
    if (Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

export function percent(part, total) {
  if (!total) return "baseline pending";
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function countFeedback(feedbackRows, names) {
  return feedbackRows.filter(row => {
    const label = normalizeAcceptanceLabel(row.acceptance_label || row.label);
    if (label && names.includes(label)) return true;
    const fields = [row.signal, row.effort_fit, row.visible_review, row.notes, row.event]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return names.some(name => fields.includes(name));
  }).length;
}

export function feedbackLabelMap(feedbackRows) {
  const labels = new Map();
  for (const row of feedbackRows) {
    const routeId = row.route_id || row.id;
    const label = normalizeAcceptanceLabel(row.acceptance_label || row.label);
    if (routeId && label) labels.set(routeId, label);
  }
  return labels;
}

export function isFailedResponse(response) {
  if (!response) return false;
  const status = String(response.status || "").toLowerCase();
  if (response.error) return true;
  return ["error", "failed", "failure"].includes(status);
}

export function effortDistribution(routes) {
  const counts = Object.fromEntries(EFFORTS.map(effort => [effort, 0]));
  for (const { request } of routes) {
    if (request.chosen_effort in counts) counts[request.chosen_effort] += 1;
  }
  return counts;
}

export function estimateXhighBaseline(routes, actualTokens) {
  const multipliers = { minimal: 3.5, low: 3, medium: 2.2, high: 1.45, xhigh: 1 };
  let weighted = 0;
  let totalWeight = 0;
  for (const { request } of routes) {
    const multiplier = multipliers[request.chosen_effort] || 2.2;
    weighted += multiplier;
    totalWeight += 1;
  }
  if (!totalWeight) return null;
  return Math.round(actualTokens * (weighted / totalWeight));
}

export function evalLogs(args = {}) {
  const config = loadConfig(args);
  const routerLog = readJsonl(config.logPath);
  const feedback = readJsonl(config.feedbackPath);
  return evaluateRows({ routerRows: routerLog.rows, invalidRows: routerLog.invalid, feedbackRows: feedback.rows, config });
}

export function evaluateRows({ routerRows, invalidRows = 0, feedbackRows = [], config }) {
  const routes = groupRoutes(routerRows);
  const totalRoutes = routes.length;
  const failedRoutes = routes.filter(pair => isFailedResponse(pair.response)).length;
  const validRouteCount = routes.filter(pair => config.allowedEfforts.includes(pair.request.chosen_effort)).length;
  const labels = feedbackLabelMap(feedbackRows);
  const responseUsage = routes.map(pair => pair.response?.executor_usage ?? pair.response?.usage).filter(Boolean);
  const routerUsage = routes.map(pair => pair.request.router_usage).filter(Boolean);
  const executorTokens = sumUsageTokens(responseUsage);
  const routerTokens = sumUsageTokens(routerUsage);
  const totalTokens = addKnownTokens(executorTokens, routerTokens);
  const explicitDispleasure =
    routerRows.filter(row => row.feedback_signal).length + countFeedback(feedbackRows, ["explicit_displeasure", "rejected"]);
  const labeledUnderfit = countFeedback(feedbackRows, ["underfit"]);
  const labeledOverfit = countFeedback(feedbackRows, ["overfit"]);
  const retryEscalation = countFeedback(feedbackRows, ["retry", "escalation"]);
  const explicitAccepted = Array.from(labels.values()).filter(label => label === "accepted").length;
  const accepted = explicitAccepted || feedbackRows.length
    ? countAcceptedFromLabels(routes, labels, failedRoutes)
    : Math.max(0, totalRoutes - explicitDispleasure - labeledUnderfit - failedRoutes);
  const baselineTokens = totalRoutes && totalTokens ? estimateXhighBaseline(routes, totalTokens) : null;
  const saved = baselineTokens && totalTokens ? Math.max(0, baselineTokens - totalTokens) : null;
  const latencyValues = routes.map(pair => Number(pair.response?.latency_ms)).filter(Number.isFinite);
  const validity = totalRoutes ? ((validRouteCount / totalRoutes) * 100).toFixed(1) : "baseline pending";
  const overheadRatio = routerTokens && totalTokens ? routerTokens / totalTokens : null;
  const overheadLabel =
    routerTokens && totalTokens ? `${routerTokens} tokens / ${(overheadRatio * 100).toFixed(1)}%` : "baseline pending";
  const savingsLabel =
    saved !== null && baselineTokens ? `~${saved} tokens / ~${((saved / baselineTokens) * 100).toFixed(1)}%` : "baseline pending";
  const costPerAccepted = accepted && totalTokens ? totalTokens / accepted : null;

  const weakestEvidence = !totalRoutes
    ? "No route log events yet."
    : !executorTokens
      ? "Executor usage tokens are missing from current logs."
      : !feedbackRows.length
        ? "Acceptance and rejection are mostly implicit because no feedback log exists."
        : "Savings are estimated without real xhigh counterfactual runs.";

  return {
    kind: "eval",
    summary: totalRoutes ? "routing data available; evaluate underfit trend before claiming savings" : "no evaluation data yet",
    config_path: config.configPath,
    routes: {
      total: totalRoutes,
      valid: validRouteCount,
      failed: failedRoutes,
      invalid_jsonl_lines: invalidRows,
      validity_percent: validity,
      effort_distribution: effortDistribution(routes),
    },
    outcomes: {
      accepted_estimate: accepted,
      acceptance_rate: percent(accepted, totalRoutes),
      explicit_rejections: explicitDispleasure,
      rejection_rate: percent(explicitDispleasure, totalRoutes),
      retry_escalations: retryEscalation,
      retry_escalation_rate: percent(retryEscalation, totalRoutes),
      overfit: labeledOverfit,
      overfit_rate: percent(labeledOverfit, totalRoutes),
      underfit: labeledUnderfit,
      underfit_rate: percent(labeledUnderfit, totalRoutes),
    },
    savings: {
      label: savingsLabel,
      actual_tokens: totalTokens,
      estimated_xhigh_baseline_tokens: baselineTokens,
      estimated_tokens_saved: saved,
      exact: false,
    },
    dispatcher_overhead: {
      label: overheadLabel,
      router_tokens: routerTokens,
      executor_tokens: executorTokens,
      response_tokens: executorTokens,
      total_tokens: totalTokens,
      ratio: overheadRatio,
    },
    cost_per_accepted_outcome: {
      tokens: costPerAccepted,
      accepted_count: accepted,
      total_tokens: totalTokens,
    },
    latency: {
      median_ms: median(latencyValues),
      samples: latencyValues.length,
    },
    weakest_evidence: weakestEvidence,
    next_test: totalRoutes
      ? "Run matched xhigh counterfactuals for representative accepted routes."
      : "Run `peto route` or the gateway, then collect reviewer outcomes.",
  };
}

function addKnownTokens(a, b) {
  if (a === null && b === null) return null;
  return (a || 0) + (b || 0);
}

function countAcceptedFromLabels(routes, labels, failedRoutes) {
  let accepted = 0;
  for (const pair of routes) {
    const label = labels.get(pair.request.route_id);
    if (label === "accepted") accepted += 1;
    if (!label && !isFailedResponse(pair.response)) accepted += 1;
  }
  return Math.max(0, accepted - failedRoutes);
}
