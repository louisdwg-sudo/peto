import crypto from "node:crypto";

export function hashText(text, length = 16) {
  return crypto.createHash("sha256").update(text || "").digest("hex").slice(0, length);
}

export function sha256Text(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex");
}

export function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}
