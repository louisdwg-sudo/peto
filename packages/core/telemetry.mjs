export const TELEMETRY_SCHEMA_VERSION = "1.0";
export const ACCEPTANCE_LABELS = ["accepted", "underfit", "overfit", "rejected", "ambiguous", "invalid"];

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
    annotations,
  };

  if (normalized.phase === "request") {
    normalized.verification_missing_fields = explicitSchemaVersion
      ? requiredVerificationFields().filter(key => !Object.hasOwn(event, key) || !event[key])
      : [];
    normalized.profile_segment = normalized.profile_segment || "default";
    normalized.risk_tier = normalized.risk_tier || "unknown";
    normalized.language = normalized.language || "unknown";
    normalized.request_class = normalized.request_class || "unknown";
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
