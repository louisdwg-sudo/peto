import fs from "node:fs";
import path from "node:path";

import { EFFORTS, loadConfig } from "./config.mjs";
import { evaluateRows, feedbackLabelMap, groupRoutes, sumUsageTokens } from "./eval.mjs";
import { hashText, sha256Text, stableJson } from "./hash.mjs";
import { judgeRoute } from "./judge.mjs";
import { readJson, readJsonl, writeJson } from "./jsonl.mjs";
import { classifyRequestTelemetry, validateVerificationFields } from "./telemetry.mjs";

const DEFAULT_GATES = {
  min_route_json_validity: 0.99,
  max_underfit_delta: 0,
  max_dispatcher_overhead_ratio: 0.08,
  min_net_savings_ratio: 0.1,
};

const EXECUTION_SAMPLE_LIMIT = 50;
const RATE_LIMIT_ATTEMPTS = 3;
const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000;

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
  const sampleRows = samples.map(sample => {
    const requestTelemetry = classifyRequestTelemetry(sample.request);
    return {
      route_id: sample.request.route_id,
      input_hash: sample.request.input_hash || null,
      user_excerpt: sample.request.user_excerpt || null,
      chosen_effort: sample.request.chosen_effort,
      profile_segment: sample.request.profile_segment,
      request_class: requestTelemetry.request_class,
      language: sample.request.language,
      risk_tier: sample.request.risk_tier,
      connected_app_required: requestTelemetry.connected_app_required,
      memory_lookup_needed: requestTelemetry.memory_lookup_needed,
      acceptance_label: labels.get(sample.request.route_id) || null,
      missing_verification_fields: validateVerificationFields(sample),
    };
  });
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

export async function executeVerificationRun(args = {}) {
  const config = loadConfig(args);
  const runDir = resolveRunDir(config, args.id);
  const manifestPath = path.join(runDir, "run-manifest.json");
  const manifest = readJson(manifestPath);
  if (!manifest.run_id) throw new Error(`Missing run manifest for ${args.id}.`);

  const samples = readJsonl(path.join(runDir, "samples.jsonl")).rows.slice(0, EXECUTION_SAMPLE_LIMIT);
  const candidateRows = readJsonl(path.join(runDir, "candidate-routes.jsonl")).rows;
  const baselineSets = readBaselineRouteFiles(runDir);
  const routerRows = readJsonl(config.logPath).rows;
  const plan = buildExecutionPlan({ samples, candidateRows, baselineSets, routerRows });
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  const base = {
    kind: "verify_execute",
    run_id: manifest.run_id,
    run_dir: runDir,
    dry_run: dryRun,
    samples_considered: samples.length,
    planned: plan.length,
  };

  if (dryRun) return { ...base, plan };

  preflightExecuteConfig(config);
  const rows = [];
  for (const item of plan) rows.push(await executePlanItem({ item, config }));
  const resultsPath = path.join(runDir, "execution-results.jsonl");
  writeJsonlRows(resultsPath, rows);
  const qualityLabelsPath =
    config.enableQualityJudge === false ? null : await writeQualityLabels({ runDir, rows, plan, config });

  const metricsPath = path.join(runDir, "metrics.json");
  const metrics = readJson(metricsPath);
  writeJson(metricsPath, updateMetricsWithExecution(metrics, rows, { resultsPath, samplesConsidered: samples.length }));
  writeJson(manifestPath, {
    ...manifest,
    status: "executed",
    annotations: unique([
      ...(manifest.annotations || []),
      "counterfactual_executed",
      qualityLabelsPath ? "quality_judge_complete" : null,
    ]),
  });

  return {
    ...base,
    dry_run: false,
    executed: rows.length,
    errors: rows.filter(row => row.error).length,
    ...executionErrorSummary(rows),
    results_path: resultsPath,
    quality_labels_path: qualityLabelsPath,
  };
}

export function gateVerificationRun(args = {}) {
  const config = loadConfig(args);
  const runDir = resolveRunDir(config, args.id);
  const manifest = readJson(path.join(runDir, "run-manifest.json"));
  const metrics = readJson(path.join(runDir, "metrics.json"));
  if (!metrics.kind) throw new Error(`Missing metrics.json for ${args.id}. Run verify run first.`);
  const gates = computeGates({ manifest, metrics, config });
  const hardFailures = gates.filter(gate => gate.severity === "hard" && !gate.pass);
  const softFailures = gates.filter(gate => gate.severity === "soft" && !gate.pass);
  const humanReviewGate = gates.find(gate => gate.name === "human_review_queue_clear");
  const verdictValue = hardFailures.length ? "blocked" : softFailures.length ? "hold" : "promote";
  const verdict = {
    run_id: manifest.run_id,
    verdict: verdictValue,
    gates_passed: gates.filter(gate => gate.pass).map(gate => gate.name),
    gates_failed: gates.filter(gate => !gate.pass).map(gate => gate.name),
    blocking_reason: unique(hardFailures.map(gate => gate.reason).filter(Boolean)).join("; ") || null,
    rollback_ref: null,
    human_review_required: humanReviewGate?.pass === false,
    human_review_queue_clear: humanReviewGate?.pass !== false,
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

function readBaselineRouteFiles(runDir) {
  return fs
    .readdirSync(runDir)
    .filter(file => /^baseline-routes\..+\.jsonl$/.test(file))
    .sort()
    .map(file => ({
      name: file.match(/^baseline-routes\.(.+)\.jsonl$/)[1],
      rows: readJsonl(path.join(runDir, file)).rows,
    }));
}

function buildExecutionPlan({ samples, candidateRows, baselineSets, routerRows }) {
  const candidateById = routeRowsById(candidateRows);
  const routerTextByHash = new Map(routerRows.filter(row => row.input_hash).map(row => [row.input_hash, row.user_excerpt]));
  const routerTextById = new Map(routerRows.map(row => [row.route_id || row.id, row.user_excerpt]).filter(([, text]) => text));
  const baselines = baselineSets.map(set => ({ ...set, byId: routeRowsById(set.rows) }));
  const plan = [];

  for (const sample of samples) {
    const routeId = sample.route_id;
    const requestText = sample.user_excerpt || routerTextByHash.get(sample.input_hash) || routerTextById.get(routeId) || null;
    const candidate = candidateById.get(routeId);
    plan.push({
      route_id: routeId,
      effort: normalizeEffort(candidate?.target_effort || sample.chosen_effort),
      source: "candidate",
      user_excerpt: requestText,
      input_hash: sample.input_hash || null,
    });

    for (const baseline of baselines) {
      const route = baseline.byId.get(routeId);
      plan.push({
        route_id: routeId,
        effort: normalizeEffort(route?.target_effort || baseline.name.replace(/^fixed_/, "")),
        source: `baseline_${baseline.name}`,
        user_excerpt: requestText,
        input_hash: sample.input_hash || null,
      });
    }
  }
  return plan;
}

function routeRowsById(rows) {
  return new Map(rows.map(row => [row.route_id, row]).filter(([routeId]) => routeId));
}

function normalizeEffort(effort) {
  return EFFORTS.includes(effort) ? effort : "medium";
}

async function executePlanItem({ item, config }) {
  const started = Date.now();
  if (!item.user_excerpt) {
    return executionRow(item, {
      model: config.defaultTargetModel || null,
      upstream_url: safeUpstreamResponsesUrl(config),
      status_code: null,
      attempts: 0,
      executor_usage: null,
      response_text: null,
      latency_ms: null,
      error_type: "missing_user_excerpt",
      error: "missing user_excerpt",
    });
  }

  try {
    const result = await callUpstreamExecutor({ item, config });
    return executionRow(item, {
      model: result.model,
      upstream_url: result.upstream_url,
      status_code: result.status_code,
      attempts: result.attempts,
      executor_usage: result.executor_usage,
      response_text: item.source === "candidate" ? result.response_text : null,
      latency_ms: Date.now() - started,
      error_type: null,
      error: null,
    });
  } catch (error) {
    return executionRow(item, {
      model: error.model || config.defaultTargetModel || null,
      upstream_url: error.upstream_url || safeUpstreamResponsesUrl(config),
      status_code: error.status_code ?? null,
      attempts: error.attempts ?? 0,
      executor_usage: null,
      response_text: null,
      latency_ms: Date.now() - started,
      error_type: error.error_type || classifyExecutionError(error),
      error: error.message,
    });
  }
}

function executionRow(item, fields) {
  return {
    route_id: item.route_id,
    source: item.source,
    effort: item.effort,
    model: fields.model ?? null,
    upstream_url: fields.upstream_url ?? null,
    status_code: fields.status_code ?? null,
    attempts: fields.attempts ?? 0,
    executor_usage: fields.executor_usage,
    response_text: fields.response_text ?? null,
    latency_ms: fields.latency_ms,
    error_type: fields.error_type ?? null,
    error: fields.error,
  };
}

async function callUpstreamExecutor({ item, config }) {
  const upstream_url = upstreamResponsesUrl(config).toString();
  const model = config.defaultTargetModel;

  let lastError = null;
  for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(upstream_url, {
        method: "POST",
        headers: upstreamHeaders(config),
        body: JSON.stringify({
          model,
          input: item.user_excerpt,
          reasoning: { effort: item.effort },
        }),
      }, executionTimeoutMs(config));
      const raw = await response.text();
      if (response.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
        await sleep((config.verifyExecuteRetryBaseMs || 250) * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) {
        throw executionError({
          message: `Upstream ${response.status} ${httpStatusDiagnostic(response.status)}: ${raw.slice(0, 500)}`,
          model,
          upstream_url,
          status_code: response.status,
          attempts: attempt,
          error_type: String(response.status),
        });
      }
      let executor_usage = null;
      let response_text = null;
      try {
        executor_usage = extractUsage(raw);
        response_text = extractResponseText(raw);
      } catch (error) {
        throw executionError({
          message: error.message,
          model,
          upstream_url,
          status_code: response.status,
          attempts: attempt,
          error_type: "parse",
        });
      }
      return {
        model,
        upstream_url,
        status_code: response.status,
        attempts: attempt,
        executor_usage,
        response_text,
      };
    } catch (error) {
      const enriched = enrichExecutionError(error, { model, upstream_url, attempts: attempt });
      if (enriched.error_type === "timeout") {
        enriched.message = `Upstream request timed out after ${executionTimeoutMs(config)}ms.`;
      }
      lastError = enriched;
      if (!["network", "429"].includes(enriched.error_type)) throw enriched;
      if (enriched.error_type === "network") break;
    }
  }
  throw lastError;
}

function upstreamResponsesUrl(config) {
  return new URL("/v1/responses", config.upstreamBaseUrl);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function executionTimeoutMs(config) {
  const timeout = Number(config.verifyExecuteTimeoutMs);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_EXECUTE_TIMEOUT_MS;
}

function safeUpstreamResponsesUrl(config) {
  try {
    return config.upstreamBaseUrl ? upstreamResponsesUrl(config).toString() : null;
  } catch {
    return null;
  }
}

function upstreamHeaders(config) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(config.upstreamHeaders || {}),
  };
  const hasAuthorization = Object.keys(headers).some(key => key.toLowerCase() === "authorization");
  const token = config.upstreamApiKey || config.apiKey || config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (token && !hasAuthorization) headers.authorization = `Bearer ${token}`;
  return headers;
}

function preflightExecuteConfig(config) {
  const missing = [];
  if (!config.upstreamBaseUrl) missing.push("upstreamBaseUrl");
  if (!config.defaultTargetModel) missing.push("defaultTargetModel");
  if (!hasUpstreamAuthorization(config)) missing.push("Authorization header or upstreamApiKey/apiKey/openaiApiKey/OPENAI_API_KEY");
  if (!missing.length) return;
  const error = new Error(`verify execute preflight failed: missing ${missing.join(", ")}.`);
  error.error_type = "config";
  throw error;
}

function hasUpstreamAuthorization(config) {
  const headers = config.upstreamHeaders || {};
  const hasAuthorization = Object.keys(headers).some(key => key.toLowerCase() === "authorization");
  return Boolean(
    hasAuthorization ||
      config.upstreamApiKey ||
      config.apiKey ||
      config.openaiApiKey ||
      process.env.OPENAI_API_KEY,
  );
}

function executionError({ message, model, upstream_url, status_code = null, attempts = 0, error_type }) {
  const error = new Error(message);
  error.model = model;
  error.upstream_url = upstream_url;
  error.status_code = status_code;
  error.attempts = attempts;
  error.error_type = error_type;
  return error;
}

function enrichExecutionError(error, { model, upstream_url, attempts }) {
  if (error.error_type) {
    error.model ||= model;
    error.upstream_url ||= upstream_url;
    error.attempts ||= attempts;
    return error;
  }
  return executionError({
    message: error.message,
    model,
    upstream_url,
    attempts,
    error_type: classifyExecutionError(error),
  });
}

function httpStatusDiagnostic(status) {
  if (status === 401) return "auth failure";
  if (status === 404) return "endpoint mismatch";
  if (status === 429) return "rate limit";
  if (status >= 500) return "upstream failure";
  return "upstream failure";
}

function classifyExecutionError(error) {
  if (error.error_type) return error.error_type;
  if (error.status_code) return String(error.status_code);
  if (/AbortError|aborted|abort/i.test(error.name || "") || /AbortError|aborted|abort/i.test(error.message)) return "timeout";
  if (/missing user_excerpt/i.test(error.message)) return "missing_user_excerpt";
  if (/non-JSON|JSON/i.test(error.message)) return "parse";
  if (/fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(error.message)) return "network";
  return "upstream";
}

function executionErrorSummary(rows) {
  const errors = rows.filter(row => row.error);
  const errorsByType = {};
  const distinctErrors = [];
  const seen = new Set();
  for (const row of errors) {
    const type = row.error_type || classifyExecutionError(row);
    errorsByType[type] = (errorsByType[type] || 0) + 1;
    if (!seen.has(row.error)) {
      seen.add(row.error);
      if (distinctErrors.length < 3) distinctErrors.push(row.error);
    }
  }
  return { distinct_errors: distinctErrors, errors_by_type: errorsByType };
}

function extractUsage(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed.usage || parsed.response?.usage || null;
  } catch {
    throw new Error("Upstream returned non-JSON response.");
  }
}

function extractResponseText(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.output_text === "string") return parsed.output_text;
    const outputText = parsed.output
      ?.flatMap(item => item.content || [])
      .map(content => content.text)
      .filter(Boolean)
      .join("\n");
    return outputText || null;
  } catch {
    throw new Error("Upstream returned non-JSON response.");
  }
}

async function writeQualityLabels({ runDir, rows, plan, config }) {
  const labelsPath = path.join(runDir, "quality-labels.jsonl");
  const candidatePlanByRouteId = new Map(plan.filter(item => item.source === "candidate").map(item => [item.route_id, item]));
  const candidateRows = rows.filter(row => row.source === "candidate" && row.response_text && !row.error);
  const labelRows = [];
  for (const row of candidateRows) {
    const planItem = candidatePlanByRouteId.get(row.route_id);
    const result = await judgeRoute({
      userExcerpt: planItem?.user_excerpt || null,
      responseText: row.response_text,
      chosenEffort: row.effort,
      config,
    });
    labelRows.push({
      route_id: row.route_id,
      acceptance_label: result.label,
      signal: "quality_judge",
      reason: result.reason,
      judge_model: config.judgeModel || "claude-haiku-4-5-20251001",
      judge_usage: result.usage,
    });
  }
  writeJsonlRows(labelsPath, labelRows);
  return labelsPath;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateMetricsWithExecution(metrics, rows, { resultsPath, samplesConsidered }) {
  const candidateRows = rows.filter(row => row.source === "candidate" && !row.error);
  const baselineRows = rows.filter(row => row.source.startsWith("baseline_") && !row.error);
  const errorSummary = executionErrorSummary(rows);
  const actualCandidateTokens = sumUsageTokens(candidateRows.map(row => row.executor_usage));
  const actualBaselineTokens = sumUsageTokens(baselineRows.map(row => row.executor_usage));
  const exact = actualCandidateTokens !== null && actualBaselineTokens !== null;
  const saved = exact ? Math.max(0, actualBaselineTokens - actualCandidateTokens) : null;
  const baselineSources = [...new Set(baselineRows.map(row => row.source))].sort();
  const updated = {
    ...metrics,
    verification: {
      ...(metrics.verification || {}),
      exact_savings_available: exact,
    },
    execution: {
      exact,
      results_path: resultsPath,
      samples_considered: samplesConsidered,
      rows: rows.length,
      errors: rows.filter(row => row.error).length,
      baseline_sources: baselineSources,
      actual_candidate_tokens: actualCandidateTokens,
      actual_baseline_tokens: actualBaselineTokens,
      distinct_errors: errorSummary.distinct_errors,
      errors_by_type: errorSummary.errors_by_type,
    },
  };

  updated.savings = {
    ...(metrics.savings || {}),
    label: exact ? exactSavingsLabel(saved, actualBaselineTokens) : "baseline pending",
    actual_tokens: exact ? actualCandidateTokens : metrics.savings?.actual_tokens ?? null,
    estimated_xhigh_baseline_tokens: exact ? actualBaselineTokens : metrics.savings?.estimated_xhigh_baseline_tokens ?? null,
    estimated_tokens_saved: exact ? saved : metrics.savings?.estimated_tokens_saved ?? null,
    exact,
  };
  if (exact) {
    updated.weakest_evidence = rows.some(row => row.error)
      ? "Exact savings available for successful execution rows; some samples failed during counterfactual execution."
      : "Exact savings available for sampled counterfactual executor calls.";
  }
  return updated;
}

function exactSavingsLabel(saved, baseline) {
  return saved !== null && baseline ? `${saved} tokens / ${((saved / baseline) * 100).toFixed(1)}%` : "baseline pending";
}

function computeGates({ manifest, metrics, config }) {
  const gates = manifest.gates || DEFAULT_GATES;
  const validity = Number(metrics.routes?.validity_percent) / 100;
  const underfitRate = parsePercent(metrics.outcomes?.underfit_rate);
  const overhead = metrics.dispatcher_overhead?.ratio;
  const executionAttempted = Boolean(metrics.execution);
  const exactSavingsAvailable = metrics.savings?.exact === true;
  const savingsRatio = executionAttempted && !exactSavingsAvailable ? null : savingsGateRatio(metrics);
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
      pass: executionAttempted && !exactSavingsAvailable ? false : savingsRatio === null || savingsRatio >= gates.min_net_savings_ratio,
      reason: executionAttempted && !exactSavingsAvailable ? "exact execution savings unavailable" : null,
    },
    humanReviewQueueGate(config),
  ];
}

function savingsGateRatio(metrics) {
  if (!metrics.savings?.estimated_tokens_saved || !metrics.savings?.estimated_xhigh_baseline_tokens) return null;
  return metrics.savings.estimated_tokens_saved / metrics.savings.estimated_xhigh_baseline_tokens;
}

function humanReviewQueueGate(config = {}) {
  const queuePath = config.humanReviewQueuePath;
  if (!queuePath) {
    return {
      name: "human_review_queue_clear",
      severity: "soft",
      observed: "not_configured",
      threshold: "empty",
      pass: true,
      note: "humanReviewQueuePath not configured; human review queue check skipped.",
    };
  }

  const resolvedQueuePath = path.resolve(queuePath);
  const text = fs.existsSync(resolvedQueuePath) ? fs.readFileSync(resolvedQueuePath, "utf8") : "";
  const nonEmpty = text.trim().length > 0;
  return {
    name: "human_review_queue_clear",
    severity: "soft",
    observed: nonEmpty ? "non_empty" : "empty",
    threshold: "empty",
    pass: !nonEmpty,
    note: nonEmpty ? `Human review queue is non-empty: ${resolvedQueuePath}` : `Human review queue is empty: ${resolvedQueuePath}`,
  };
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
