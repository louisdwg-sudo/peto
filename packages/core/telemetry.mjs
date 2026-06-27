export const TELEMETRY_SCHEMA_VERSION = "1.0";
export const ACCEPTANCE_LABELS = ["accepted", "underfit", "overfit", "rejected", "ambiguous", "invalid"];
export const REQUEST_CLASSES = ["codex_suggestions", "session_restore", "memory_extraction", "coding_help", "other"];

export function normalizeRouteEvent(event = {}) {
  const routeId = event.route_id || event.id || null;
  const explicitSchemaVersion = Boolean(event.schema_version);
  const annotations = Array.isArray(event.annotations)
    ? event.annotations
    : event.annotations
      ? [String(event.annotations)]
      : [];
  const normalized = {
    schema_version: event.schema_version || TELEMETRY_SCHEMA_VERSION,
    route_id: routeId,
    ...event,
    route_id: routeId,
    retry_of: event.retry_of || null,
    annotations,
  };

  if (normalized.phase === "request") {
    const requestTelemetry = classifyRequestTelemetry({
      request_class: normalized.request_class,
      user_excerpt: normalized.user_excerpt,
      connected_app_required: normalized.connected_app_required,
      memory_lookup_needed: normalized.memory_lookup_needed,
    });
    normalized.request_class = requestTelemetry.request_class;
    normalized.connected_app_required = requestTelemetry.connected_app_required;
    normalized.memory_lookup_needed = requestTelemetry.memory_lookup_needed;
    normalized.verification_missing_fields = explicitSchemaVersion
      ? requiredVerificationFields().filter(key => {
        if (key === "request_class") return normalized.request_class === "unknown";
        return !Object.hasOwn(event, key) || !event[key];
      })
      : [];
    normalized.profile_segment = normalized.profile_segment || "default";
    normalized.risk_tier = normalized.risk_tier || "unknown";
    normalized.language = normalized.language || "unknown";
    normalized.router_usage = normalized.router_usage ?? normalized.usage ?? null;
    normalized.executor_usage = normalized.executor_usage ?? null;
    normalized.acceptance_label = normalizeAcceptanceLabel(normalized.acceptance_label);
  }

  if (normalized.phase === "response") {
    normalized.router_usage = normalized.router_usage ?? null;
    normalized.executor_usage = normalized.executor_usage ?? normalized.usage ?? null;
    normalized.usage = normalized.usage ?? normalized.executor_usage ?? null;
    normalized.acceptance_label = normalizeAcceptanceLabel(normalized.acceptance_label);
  }

  return normalized;
}

export function normalizeAcceptanceLabel(label) {
  if (!label) return null;
  const value = String(label).toLowerCase();
  return ACCEPTANCE_LABELS.includes(value) ? value : null;
}

export function classifyRequestTelemetry(event = {}) {
  const text = String(event.user_excerpt ?? event.userText ?? event.text ?? "").trim();
  const lower = text.toLowerCase();
  const providedClass = normalizeRequestClass(event.request_class);
  const inferredClass = text ? inferRequestClass(lower, text) : "unknown";
  const requestClass = providedClass !== "unknown" ? providedClass : inferredClass;
  const connectedAppRequired = Boolean(
    event.connected_app_required ?? inferConnectedAppRequired(lower, requestClass),
  );
  const memoryLookupNeeded = Boolean(
    event.memory_lookup_needed ?? inferMemoryLookupNeeded(lower, requestClass),
  );

  return {
    request_class: requestClass,
    connected_app_required: connectedAppRequired,
    memory_lookup_needed: memoryLookupNeeded,
  };
}

export function annotateRouteEvent(event, annotation) {
  const normalized = normalizeRouteEvent(event);
  if (annotation && !normalized.annotations.includes(annotation)) normalized.annotations.push(annotation);
  return normalized;
}

export function validateVerificationFields(routePair) {
  const request = routePair?.request || {};
  if (Array.isArray(request.verification_missing_fields)) return request.verification_missing_fields;
  return [];
}

function requiredVerificationFields() {
  return ["profile_segment", "risk_tier", "language", "request_class"];
}

function normalizeRequestClass(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized || normalized === "unknown") return "unknown";
  if (REQUEST_CLASSES.includes(normalized)) return normalized;
  if (["coding", "code", "debug", "debugging", "implementation", "deployment"].includes(normalized)) {
    return "coding_help";
  }
  if (["memory", "memory_extract", "rollout_memory_extraction"].includes(normalized)) {
    return "memory_extraction";
  }
  if (["session", "session_recovery", "session_resume"].includes(normalized)) return "session_restore";
  return "other";
}

function inferRequestClass(lower, originalText) {
  if (isCodexSuggestions(lower)) return "codex_suggestions";
  if (isSessionRestore(lower)) return "session_restore";
  if (isMemoryExtraction(lower)) return "memory_extraction";
  if (isTitleGeneration(lower)) return "other";
  if (isCodingHelp(lower, originalText)) return "coding_help";
  return "other";
}

function isCodexSuggestions(lower) {
  return (
    lower.includes("generate 0 to 3 hyperpersonalized suggestions") ||
    (lower.includes("hyperpersonalized suggestions") && lower.includes("connected apps")) ||
    lower.includes("what this user can do with codex")
  );
}

function isSessionRestore(lower) {
  return (
    (lower.includes("restore") && (lower.includes("session") || lower.includes("chat"))) ||
    (lower.includes("bring") && lower.includes("chat") && lower.includes("back")) ||
    lower.includes("session restore") ||
    lower.includes("previous codex session") ||
    lower.includes("hijacked by vscode")
  );
}

function isMemoryExtraction(lower) {
  return (
    (lower.includes("rollout_summary") || lower.includes("raw_memory") || lower.includes("memory extraction")) ||
    (lower.includes("analyze this rollout") && lower.includes("memory")) ||
    lower.includes("context checkpoint compaction") ||
    lower.includes("handoff summary")
  );
}

function isTitleGeneration(lower) {
  return lower.includes("generate a concise ui title") || lower.includes("short title for a task");
}

function isCodingHelp(lower, originalText) {
  const codingPatterns = [
    /\bbug\b/,
    /\bbuild\b/,
    /\bcode\b/,
    /\bcoding\b/,
    /\bcommit\b/,
    /\bdebug\b/,
    /\bdeploy\b/,
    /\bfix\b/,
    /\bfunction\b/,
    /\bgit\b/,
    /\bimplement\b/,
    /\bnpm\b/,
    /\bpython\b/,
    /\brepo\b/,
    /\btest\b/,
    /\btypescript\b/,
    /\bjavascript\b/,
    /修复/,
    /调试/,
    /代码/,
    /测试/,
    /部署/,
    /接入/,
    /小程序/,
  ];
  return codingPatterns.some(pattern => pattern.test(lower) || pattern.test(originalText));
}

function inferConnectedAppRequired(lower, requestClass) {
  return (
    requestClass === "codex_suggestions" ||
    lower.includes("connected apps") ||
    lower.includes("deeply viewing their connected apps")
  );
}

function inferMemoryLookupNeeded(lower, requestClass) {
  return (
    requestClass === "session_restore" ||
    requestClass === "memory_extraction" ||
    lower.includes("memory lookup") ||
    lower.includes("rollout_summary") ||
    lower.includes("raw_memory")
  );
}
