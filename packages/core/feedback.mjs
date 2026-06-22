import { appendJsonl } from "./jsonl.mjs";
import { normalizeAcceptanceLabel } from "./telemetry.mjs";

export function writeFeedback({ feedbackPath, routeId, label, notes = null }) {
  if (!feedbackPath) throw new Error("feedbackPath is required.");
  if (!routeId) throw new Error("feedback requires --route-id.");
  const acceptanceLabel = normalizeAcceptanceLabel(label);
  if (!acceptanceLabel) throw new Error("feedback --label must be accepted, underfit, overfit, rejected, ambiguous, or invalid.");
  return appendJsonl(feedbackPath, {
    id: routeId,
    route_id: routeId,
    signal: "explicit_label",
    acceptance_label: acceptanceLabel,
    notes,
  });
}
