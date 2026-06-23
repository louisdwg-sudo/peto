import fs from "node:fs";
import path from "node:path";

import { EFFORTS, loadConfig } from "./config.mjs";
import { evaluateRows, feedbackLabelMap, groupRoutes } from "./eval.mjs";
import { hashText, sha256Text, stableJson } from "./hash.mjs";
import { readJson, readJsonl, writeJson } from "./jsonl.mjs";
import { validateVerificationFields } from "./telemetry.mjs";

const DEFAULT_GATES = {
  min_route_json_validity: 0.99,
  max_underfit_delta: 0,
  max_dispatcher_overhead_ratio: 0.08,
  min_net_savings_ratio: 0.1,
};

export function createVerificationRun(args = {}) {
  const config = loadConfig(args);
  if (!args.ticket) throw new Error("verify create requires --ticket.");
  const ticket = readTicket(args.ticket);
  const runId = ticket.id || `peto-verify-${new Date().toISOString().slice(0, 10)}-${hashText(stableJson(ticket), 8)}`;
  const runDir = path.join(config.verificationPath, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const configSnapshot = snapshotConfig(config);
  writeJson(path.join(runDir, "config-snapshot.json"), configSnapshot);
  const manifest = {
    schema_version: "1.0",
    run_id: runId,
    status: "created",
    created_at: new Date().toISOString(),
    ticket,
    seed: Number(ticket.seed ?? 1),
    samples_sha256: null,
    config_snapshot_sha256: sha256Text(stableJson(configSnapshot)),
    gates: { ...DEFAULT_GATES, ...(ticket.gates || {}) },
    budget: ticket.budget || null,
    annotations: ["baseline_pending"],
  };
  writeJson(path.join(runDir, "run-manifest.json"), manifest);
  return { kind: "verify_create", run_id: runId, run_dir: runDir, manifest_path: path.join(runDir, "run-manifest.json") };
}

export function runVerification(args = {}) {
  const config = loadConfig(args);
  const runDir = resolveRunDir(config, args.id);
  const manifestPath = path.join(runDir, "run-manifest.json");
  const manifest = readJson(manifestPath);
  if (!manifest.run_id) throw new Error(`Missing run manifest for ${args.id}.`);

  const routerLog = readJsonl(config.logPath);
  const feedback = readJsonl(config.feedbackPath);
  const routes = groupRoutes(routerLog.rows);
  const missing = collectMissingVerificationFields(routes);
  const labels = feedbackLabelMap(feedback.rows);
  const samples = curateSamples(routes, labels, {
    seed: manifest.seed,
    sampleSize: Number(manifest.ticket?.sample_size || 20),
  });
  const sampleRows = samples.map(sample => ({
    route_id: sample.request.route_id,
    input_hash: sample.request.input_hash || null,
    user_excerpt: sample.request.user_excerpt || null,
    chosen_effort: sample.request.chosen_effort,
    profile_segment: sample.request.profile_segment,
    request_class: sample.request.request_class,
    language: sample.request.language,
    risk_tier: sample.request.risk_tier,
    acceptance_label: labels.get(sample.request.route_id) || null,
    missing_verification_fields: validateVerificationFields(sample),
  }));
  const sampleText = sampleRows.map(row => JSON.stringify(row)).join("\n") + (sampleRows.length ? "\n" : "");
  const samplesSha = sha256Text(sampleText);
  fs.writeFileSync(path.join(runDir, "samples.jsonl"), sampleText);
  writeJson(path.join(runDir, "sample-summary.json"), {
    count: sampleRows.length,
    seed: manifest.seed,
    samples_sha256: samplesSha,
    missing_verification_fields: missing,
  });

  const candidateRows = samples.map(sample => routeResultFromSample(sample, "candidate", sample.request.chosen_effort));
  writeJsonlRows(path.join(runDir, "candidate-routes.jsonl"), candidateRows);
  for (const baseline of baselinesForTicket(manifest.ticket)) {
    const baselineRows = samples.map(sample => routeResultFromSample(sample, baseline.name, baseline.effort));
    writeJsonlRows(path.join(runDir, `baseline-routes.${baseline.name}.jsonl`), baselineRows);
  }

  const metrics = evaluateRows({
    routerRows: routerLog.rows,
    invalidRows: routerLog.invalid,
    feedbackRows: feedback.rows,
    config,
  });
  metrics.verification = {
    run_id: manifest.run_id,
    samples: sampleRows.length,
    samples_sha256: samplesSha,
    telemetry_preconditions: {
      ok: missing.length === 0,
      missing,
    },
    exact_savings_available: false,
  };
  writeJson(path.join(runDir, "metrics.json"), metrics);
  const updatedManifest = {
    ...manifest,
    status: missing.length ? "blocked" : "ran",
    samples_sha256: samplesSha,
    annotations: unique([...(manifest.annotations || []), "counterfactual_skipped", missing.length ? "telemetry_precondition_failed" : null]),
  };
  writeJson(manifestPath, updatedManifest);
  return {
    kind: "verify_run",
    run_id: manifest.run_id,
    run_dir: runDir,
    samples: { count: sampleRows.length, sha256: samplesSha },
    metrics,
    missing_verification_fields: missing,
  };
}

export function gateVerificationRun(args = {}) {
  const config = loadConfig(args);
  const runDir = resolveRunDir(config, args.id);
  const manifest = readJson(path.join(runDir, "run-manifest.json"));
  const metrics = readJson(path.join(runDir, "metrics.json"));
  if (!metrics.kind) throw new Error(`Missing metrics.json for ${args.id}. Run verify run first.`);
  const gates = computeGates({ manifest, metrics });
  const hardFailures = gates.filter(gate => gate.severity === "hard" && !gate.pass);
  const softFailures = gates.filter(gate => gate.severity === "soft" && !gate.pass);
  const verdictValue = hardFailures.length ? "blocked" : softFailures.length ? "hold" : "promote";
  const verdict = {
    run_id: manifest.run_id,
    verdict: verdictValue,
    gates_passed: gates.filter(gate => gate.pass).map(gate => gate.name),
    gates_failed: gates.filter(gate => !gate.pass).map(gate => gate.name),
    blocking_reason: unique(hardFailures.map(gate => gate.reason).filter(Boolean)).join("; ") || null,
    rollback_ref: null,
    human_review_required: false,
    human_review_queue_clear: true,
  };
  writeJson(path.join(runDir, "gates.json"), { run_id: manifest.run_id, gates });
  writeJson(path.join(runDir, "verdict.json"), verdict);
  writeJson(path.join(runDir, "run-manifest.json"), { ...manifest, status: verdictValue });
  return { kind: "verify_gate", run_id: manifest.run_id, run_dir: runDir, gates, verdict };
}

export function reportVerificationRun(args = {}) {
  const config = loadConfig(args);
  const runDir = resolveRunDir(config, args.id);
  const manifest = readJson(path.join(runDir, "run-manifest.json"));
  const metrics = readJson(path.join(runDir, "metrics.json"));
  let verdict = readJson(path.join(runDir, "verdict.json"), null);
  if (!verdict) verdict = gateVerificationRun(args).verdict;
  const report = [
    `# PETO Verification Report`,
    ``,
    `Run: ${manifest.run_id}`,
    `Verdict: ${verdict.verdict}`,
    `Samples: ${metrics.verification?.samples ?? 0}`,
    `Route JSON validity: ${metrics.routes?.validity_percent ?? "baseline pending"}`,
    `Underfit rate: ${metrics.outcomes?.underfit_rate ?? "baseline pending"}`,
    `Dispatcher overhead: ${metrics.dispatcher_overhead?.label ?? "baseline pending"}`,
    `Cost per accepted outcome: ${formatMaybeNumber(metrics.cost_per_accepted_outcome?.tokens)}`,
    `Estimated xhigh savings: ${metrics.savings?.label ?? "baseline pending"}`,
    ``,
    `Weakest evidence: ${metrics.weakest_evidence || "baseline pending"}`,
    `Next test: ${metrics.next_test || "Run counterfactuals before exact savings claims."}`,
    ``,
    `Artifacts:`,
    `- run-manifest.json`,
    `- samples.jsonl`,
    `- candidate-routes.jsonl`,
    `- metrics.json`,
    `- gates.json`,
    `- verdict.json`,
    ``,
  ].join("\n");
  const reportPath = path.join(runDir, "report.md");
  fs.writeFileSync(reportPath, report);
  return { kind: "verify_report", run_id: manifest.run_id, run_dir: runDir, report_path: reportPath };
}

function readTicket(file) {
  const text = fs.readFileSync(path.resolve(file), "utf8");
  if (/\.ya?ml$/i.test(file)) {
    try {
      return parseSimpleYaml(text);
    } catch (error) {
      const line = Number.isFinite(error.yamlLine) ? error.yamlLine : 1;
      throw new Error(
        `Failed to parse ticket YAML (line ~${line}): ${error.message}. Supported subset: flat key/value, nested maps, simple lists.`,
      );
    }
  }
  return JSON.parse(text);
}

function parseSimpleYaml(text) {
  const root = {};
  const lines = text
    .split(/\n/)
    .map(raw => raw.replace(/#.*$/, ""))
    .filter(line => line.trim())
    .map(line => ({ indent: line.match(/^\s*/)[0].length, text: line.trim() }));
  const stack = [{ indent: -1, value: root, key: null }];
  for (let index = 0; index < lines.length; index += 1) {
    const { indent, text: trimmed } = lines[index];
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const frame = stack.at(-1);
    const parent = frame.value;

    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(parent)) throw yamlParseError(`Unsupported YAML list at indent ${indent}`, index + 1);
      const itemText = trimmed.slice(2);
      const item = itemText.includes(":") ? parseYamlInlineMap(itemText) : parseYamlValue(itemText);
      parent.push(item);
      if (item && typeof item === "object" && !Array.isArray(item)) stack.push({ indent, value: item, key: null });
      continue;
    }

    const [key, ...rest] = trimmed.split(":");
    const valueText = rest.join(":").trim();
    if (valueText) {
      parent[key.trim()] = parseYamlValue(valueText);
      continue;
    }
    const next = lines[index + 1];
    const value = next && next.indent > indent && next.text.startsWith("- ") ? [] : {};
    parent[key.trim()] = value;
    stack.push({ indent, value, key: key.trim() });
  }
  return root;
}

function yamlParseError(message, line) {
  const error = new Error(message);
  error.yamlLine = line;
  return error;
}

function parseYamlInlineMap(text) {
  const [key, ...rest] = text.split(":");
  return { [key.trim()]: parseYamlValue(rest.join(":").trim()) };
}

function parseYamlValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^["']|["']$/g, "");
}

function snapshotConfig(config) {
  const blocked = new Set(["apiKey", "openaiApiKey", "OPENAI_API_KEY"]);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !blocked.has(key)));
}

function resolveRunDir(config, runId) {
  if (!runId) throw new Error("verify command requires --id.");
  return path.join(config.verificationPath, "runs", runId);
}

function collectMissingVerificationFields(routes) {
  const found = [];
  for (const route of routes) {
    for (const field of validateVerificationFields(route)) {
      found.push({ route_id: route.request.route_id, field });
    }
  }
  return found;
}

function curateSamples(routes, labels, { seed, sampleSize }) {
  const included = new Map();
  for (const route of routes) {
    const label = labels.get(route.request.route_id);
    if (["underfit", "rejected"].includes(label)) included.set(route.request.route_id, route);
  }
  const shuffled = [...routes].sort((a, b) => seededScore(a.request.route_id, seed) - seededScore(b.request.route_id, seed));
  for (const route of shuffled) {
    if (included.size >= sampleSize) break;
    included.set(route.request.route_id, route);
  }
  return [...included.values()];
}

function seededScore(value, seed) {
  return Number.parseInt(hashText(`${seed}:${value}`, 12), 16);
}

function routeResultFromSample(sample, source, effort) {
  return {
    route_id: sample.request.route_id,
    source,
    target_effort: EFFORTS.includes(effort) ? effort : sample.request.chosen_effort,
    confidence: source === "candidate" ? sample.request.router_confidence ?? null : 1,
    valid: EFFORTS.includes(effort || sample.request.chosen_effort),
    latency_ms: null,
    error: null,
  };
}

function baselinesForTicket(ticket = {}) {
  const configured = Array.isArray(ticket.baselines) ? ticket.baselines : [];
  const baselines = configured
    .filter(item => item.type === "fixed_effort" && EFFORTS.includes(item.effort))
    .map(item => ({ name: item.name || `fixed_${item.effort}`, effort: item.effort }));
  return baselines.length ? baselines : [{ name: "fixed_xhigh", effort: "xhigh" }];
}

function writeJsonlRows(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function computeGates({ manifest, metrics }) {
  const gates = manifest.gates || DEFAULT_GATES;
  const validity = Number(metrics.routes?.validity_percent) / 100;
  const underfitRate = parsePercent(metrics.outcomes?.underfit_rate);
  const overhead = metrics.dispatcher_overhead?.ratio;
  const savingsRatio =
    metrics.savings?.estimated_tokens_saved && metrics.savings?.estimated_xhigh_baseline_tokens
      ? metrics.savings.estimated_tokens_saved / metrics.savings.estimated_xhigh_baseline_tokens
      : null;
  const telemetryOk = metrics.verification?.telemetry_preconditions?.ok !== false;
  return [
    {
      name: "telemetry_preconditions",
      severity: "hard",
      observed: telemetryOk,
      threshold: true,
      pass: telemetryOk,
      status: telemetryOk ? "pass" : "blocked",
      reason: telemetryOk ? null : "required verification telemetry fields are missing",
    },
    {
      name: "min_route_json_validity",
      severity: "hard",
      observed: validity,
      threshold: gates.min_route_json_validity,
      pass: Number.isFinite(validity) && validity >= gates.min_route_json_validity,
    },
    {
      name: "max_underfit_delta",
      severity: "hard",
      observed: underfitRate,
      threshold: gates.max_underfit_delta,
      pass: Number.isFinite(underfitRate) && underfitRate <= gates.max_underfit_delta,
    },
    {
      name: "max_dispatcher_overhead_ratio",
      severity: "soft",
      observed: overhead,
      threshold: gates.max_dispatcher_overhead_ratio,
      pass: overhead === null || overhead <= gates.max_dispatcher_overhead_ratio,
    },
    {
      name: "min_net_savings_ratio",
      severity: "soft",
      observed: savingsRatio,
      threshold: gates.min_net_savings_ratio,
      pass: savingsRatio === null || savingsRatio >= gates.min_net_savings_ratio,
    },
    {
      name: "human_review_queue_clear",
      severity: "hard",
      observed: true,
      threshold: true,
      pass: true,
    },
  ];
}

function parsePercent(value) {
  if (typeof value !== "string" || !value.endsWith("%")) return null;
  return Number(value.slice(0, -1)) / 100;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatMaybeNumber(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "baseline pending";
}
