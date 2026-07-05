import fs from "node:fs";
import path from "node:path";

import { EFFORTS, loadConfig } from "./config.mjs";
import { evaluateRows, feedbackLabelMap, groupRoutes, percent, sumUsageTokens } from "./eval.mjs";
import { hashText, sha256Text, stableJson } from "./hash.mjs";
import { judgeModelForConfig, judgeRoute } from "./judge.mjs";
import { readJson, readJsonl, writeJson } from "./jsonl.mjs";
import {
  OPTIMIZATION_SEGMENTS,
  classifyOptimizationSegment,
  classifyRequestTelemetry,
  validateVerificationFields,
} from "./telemetry.mjs";

const DEFAULT_GATES = {
  min_route_json_validity: 0.99,
  max_underfit_delta: 0,
  max_dispatcher_overhead_ratio: 0.08,
  min_net_savings_ratio: 0.1,
};

const EXECUTION_SAMPLE_LIMIT = 50;
const RATE_LIMIT_ATTEMPTS = 3;
const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000;
const SEGMENT_FILTERS = ["all", ...OPTIMIZATION_SEGMENTS];
const SAMPLE_MODES = ["representative", "stress"];

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
    segment_filter: normalizeSegmentFilter(ticket.segment_filter),
    sample_mode: normalizeSampleMode(ticket.sample_mode),
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
  const qualityLabels = readQualityLabels(runDir);
  const feedbackRows = [...feedback.rows, ...qualityLabels.rows];
  const routes = groupRoutes(routerLog.rows);
  const missing = collectMissingVerificationFields(routes);
  const labels = feedbackLabelMap(feedbackRows);
  const samples = curateSamples(routes, labels, {
    seed: manifest.seed,
    sampleSize: Number(manifest.ticket?.sample_size || 20),
    segmentFilter: manifest.segment_filter,
    sampleMode: manifest.sample_mode,
  });
  const sampleRows = samples.map(sample => {
    const requestTelemetry = classifyRequestTelemetry(sample.request);
    const optimizationSegment = classifyOptimizationSegment(requestTelemetry);
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
      tool_execution_required: requestTelemetry.tool_execution_required,
      workspace_action_required: requestTelemetry.workspace_action_required,
      action_or_recovery_required: requestTelemetry.action_or_recovery_required,
      local_artifact_required: requestTelemetry.local_artifact_required,
      optimization_segment: optimizationSegment,
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
  const baselineSets = [];
  for (const baseline of baselinesForTicket(manifest.ticket)) {
    const baselineRows = samples.map(sample => routeResultFromSample(sample, baseline.name, baseline.effort));
    baselineSets.push({ name: baseline.name, rows: baselineRows });
    writeJsonlRows(path.join(runDir, `baseline-routes.${baseline.name}.jsonl`), baselineRows);
  }

  let metrics = evaluateRows({
    routerRows: routerLog.rows,
    invalidRows: routerLog.invalid,
    feedbackRows,
    config,
  });
  metrics.verification = {
    run_id: manifest.run_id,
    samples: sampleRows.length,
    samples_sha256: samplesSha,
    segment_filter: manifest.segment_filter,
    sample_mode: manifest.sample_mode,
    sample_grade: sampleGrade(manifest.sample_mode),
    quality_labels_path: qualityLabels.path,
    optimization_segments: sampleOptimizationSegments(sampleRows),
    telemetry_preconditions: {
      ok: missing.length === 0,
      missing,
    },
    exact_savings_available: false,
  };
  const previousResultsPath = path.join(runDir, "execution-results.jsonl");
  if (fs.existsSync(previousResultsPath)) {
    const currentPlan = buildExecutionPlan({ samples: sampleRows, candidateRows, baselineSets, routerRows: routerLog.rows });
    const reusableRows = readReusableExecutionRows(previousResultsPath, currentPlan);
    if (reusableRows) {
      metrics = updateMetricsWithExecution(metrics, reusableRows, {
        resultsPath: previousResultsPath,
        samplesConsidered: sampleRows.length,
        plan: currentPlan,
      });
    }
  }
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

  const resultsPath = path.join(runDir, "execution-results.jsonl");
  preflightExecuteConfig(config);
  const resumePlan = planExecutionResume({ resultsPath, plan });
  const reusedExecutionResults = resumePlan.itemsToExecute.length === 0 && resumePlan.rows.length > 0;
  const resumedExecutionRows = resumePlan.itemsToExecute.map(item => ({
    route_id: item.route_id,
    source: item.source,
    effort: item.effort,
  }));
  let rows = resumePlan.rows;
  if (resumePlan.itemsToExecute.length) {
    writeJsonlRows(resultsPath, rows);
    await executeResumeGroups({
      groups: resumePlan.groupsToExecute,
      config,
      onRow: row => {
        resumePlan.rowMap.set(planItemKey(row), row);
        rows = orderedRowsFromMap(resumePlan.rowMap, plan);
        writeJsonlRows(resultsPath, rows);
      },
    });
    rows = orderedRowsFromMap(resumePlan.rowMap, plan);
  } else if (!fs.existsSync(resultsPath)) {
    writeJsonlRows(resultsPath, rows);
  }
  const qualityLabelsPath =
    config.enableQualityJudge === false ? null : await writeQualityLabels({ runDir, rows, plan, config });

  const metricsPath = path.join(runDir, "metrics.json");
  const metrics = readJson(metricsPath);
  writeJson(
    metricsPath,
    updateMetricsWithQualityLabels(
      updateMetricsWithExecution(metrics, rows, { resultsPath, samplesConsidered: samples.length, plan }),
      runDir,
      qualityLabelsPath,
    ),
  );
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
    reused_execution_results: reusedExecutionResults,
    resumed_execution_rows: resumedExecutionRows,
    skipped_execution_rows: Math.max(0, plan.length - resumedExecutionRows.length),
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
  const evidence = evidenceSummary({ runDir, manifest, metrics, config });
  const gates = computeGates({ manifest, metrics, config, evidence });
  const hardFailures = gates.filter(gate => gate.severity === "hard" && !gate.pass);
  const softFailures = gates.filter(gate => gate.severity === "soft" && !gate.pass);
  const humanReviewGate = gates.find(gate => gate.name === "human_review_queue_clear");
  const verdictValue = hardFailures.length ? "blocked" : softFailures.length ? "hold" : "promote";
  const verdict = {
    run_id: manifest.run_id,
    verdict: verdictValue,
    evidence_status: evidence.evidence_status,
    sample_status: evidence.sample_status,
    claim_status: evidence.claim_status,
    execution_pairing: evidence.execution_pairing,
    execution_pairing_ratio: evidence.execution_pairing_ratio,
    evidence_missing: evidence.missing,
    evidence_reason: evidence.reason,
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
  const pairingLine = executionPairingReportLine(metrics);
  const pairingStatusLine = `Execution pairing status: ${metrics.execution?.execution_pairing ?? verdict.execution_pairing ?? "unknown"}`;
  const contaminatedPairingLines =
    (metrics.execution?.execution_pairing ?? verdict.execution_pairing) === "contaminated"
      ? ["Execution pairing is contaminated; savings are matched-pair-only and the claim is not proven."]
      : [];
  const report = [
    `# PETO Verification Report`,
    ``,
    `Run: ${manifest.run_id}`,
    pairingLine,
    pairingStatusLine,
    ...contaminatedPairingLines,
    `Verdict: ${verdict.verdict}`,
    `Evidence status: ${verdict.evidence_status ?? "unknown"}`,
    `Sample status: ${verdict.sample_status ?? "unknown"}`,
    `Claim status: ${verdict.claim_status ?? "unknown"}`,
    `Reason: ${verdict.evidence_reason || "none"}`,
    `Samples: ${metrics.verification?.samples ?? 0}`,
    `Route JSON validity: ${metrics.routes?.validity_percent ?? "baseline pending"}`,
    `Underfit rate: ${metrics.outcomes?.underfit_rate ?? "baseline pending"}`,
    `Dispatcher overhead: ${metrics.dispatcher_overhead?.label ?? "baseline pending"}`,
    `Cost per accepted outcome: ${formatMaybeNumber(metrics.cost_per_accepted_outcome?.tokens)}`,
    `Estimated xhigh savings: ${metrics.savings?.label ?? "baseline pending"}`,
    `Savings basis: ${savingsBasisLabel(metrics)}`,
    ``,
    `Segment filter: ${metrics.verification?.segment_filter ?? manifest.segment_filter ?? "all"}`,
    `Sample mode: ${metrics.verification?.sample_mode ?? manifest.sample_mode ?? "stress"}`,
    `Sample grade: ${metrics.verification?.sample_grade ?? sampleGrade(metrics.verification?.sample_mode ?? manifest.sample_mode)}`,
    `Quality labels: ${formatQualityLabelSummary(metrics.verification?.quality_labels)}`,
    ...formatAmbiguousReasons(metrics.verification?.quality_labels),
    ``,
    `Optimization segments:`,
    ...formatOptimizationSegments(metrics.verification?.optimization_segments || metrics.optimization_segments),
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

function normalizeSegmentFilter(value) {
  const normalized = String(value || "all").trim();
  return SEGMENT_FILTERS.includes(normalized) ? normalized : "all";
}

function normalizeSampleMode(value) {
  const normalized = String(value || "stress").trim();
  return SAMPLE_MODES.includes(normalized) ? normalized : "stress";
}

function sampleGrade(sampleMode) {
  return normalizeSampleMode(sampleMode) === "representative" ? "claim-grade" : "stress-grade";
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

function curateSamples(routes, labels, { seed, sampleSize, segmentFilter = "all", sampleMode = "stress" }) {
  const eligibleRoutes = routes.filter(route => {
    if (segmentFilter === "all") return true;
    return route.request.optimization_segment === segmentFilter;
  });
  if (sampleMode === "representative") {
    return seededRoutes(eligibleRoutes, seed).slice(0, sampleSize);
  }

  const included = new Map();
  for (const route of eligibleRoutes) {
    const label = labels.get(route.request.route_id);
    if (["underfit", "rejected"].includes(label)) included.set(route.request.route_id, route);
  }
  for (const route of seededRoutes(eligibleRoutes, seed)) {
    if (included.size >= sampleSize) break;
    included.set(route.request.route_id, route);
  }
  return [...included.values()];
}

function seededRoutes(routes, seed) {
  return [...routes].sort((a, b) => seededScore(a.request.route_id, seed) - seededScore(b.request.route_id, seed));
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

function appendJsonlRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function readReusableExecutionRows(resultsPath, plan) {
  if (!fs.existsSync(resultsPath)) return null;
  const parsed = readJsonl(resultsPath);
  if (parsed.invalid || parsed.rows.length !== plan.length) return null;
  for (let index = 0; index < plan.length; index += 1) {
    const row = parsed.rows[index];
    const item = plan[index];
    if (row.route_id !== item.route_id || row.source !== item.source || row.effort !== item.effort) return null;
  }
  return parsed.rows;
}

function planExecutionResume({ resultsPath, plan }) {
  const rowMap = readExecutionRowMap(resultsPath, plan);
  const groupsToExecute = [];
  const seenExecuteKeys = new Set();

  for (const group of executionRouteGroups(plan)) {
    const candidateRow = rowMap.get(planItemKey(group.candidate));
    const candidateSuccess = isMatchedExecutionSuccess(candidateRow);
    const groupItems = [];
    for (const baseline of group.baselines) {
      const baselineRow = rowMap.get(planItemKey(baseline));
      const baselineSuccess = isMatchedExecutionSuccess(baselineRow);
      if (candidateSuccess && baselineSuccess) continue;
      if (!candidateSuccess) addResumeItem(groupItems, seenExecuteKeys, group.candidate);
      if (!baselineSuccess) addResumeItem(groupItems, seenExecuteKeys, baseline);
    }
    if (groupItems.length) groupsToExecute.push({ route_id: group.route_id, items: groupItems });
  }

  return {
    rowMap,
    rows: orderedRowsFromMap(rowMap, plan),
    groupsToExecute,
    itemsToExecute: groupsToExecute.flatMap(group => group.items),
  };
}

function addResumeItem(items, seen, item) {
  const key = planItemKey(item);
  if (seen.has(key)) return;
  seen.add(key);
  items.push(item);
}

function readExecutionRowMap(resultsPath, plan) {
  const planKeys = new Set(plan.map(planItemKey));
  const rowMap = new Map();
  if (!fs.existsSync(resultsPath)) return rowMap;
  const parsed = readJsonl(resultsPath);
  if (parsed.invalid) return rowMap;
  for (const row of parsed.rows) {
    const key = planItemKey(row);
    if (planKeys.has(key)) rowMap.set(key, row);
  }
  return rowMap;
}

function orderedRowsFromMap(rowMap, plan) {
  return plan.map(item => rowMap.get(planItemKey(item))).filter(Boolean);
}

function executionRouteGroups(plan) {
  const groups = new Map();
  for (const item of plan) {
    const group = groups.get(item.route_id) || { route_id: item.route_id, candidate: null, baselines: [] };
    if (item.source === "candidate") group.candidate = item;
    if (item.source.startsWith("baseline_")) group.baselines.push(item);
    groups.set(item.route_id, group);
  }
  return [...groups.values()].filter(group => group.candidate && group.baselines.length);
}

function planItemKey(item) {
  return `${item.route_id}:${item.source}:${item.effort}`;
}

async function executeResumeGroups({ groups, config, onRow }) {
  const concurrency = Math.min(executionConcurrency(config), groups.length || 1);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < groups.length) {
      const group = groups[nextIndex];
      nextIndex += 1;
      for (const item of group.items) {
        onRow(await executePlanItem({ item, config }));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function executionConcurrency(config) {
  const configured = Number(config.verifyExecuteConcurrency);
  if (Number.isFinite(configured) && configured > 0) return Math.min(4, Math.max(2, Math.floor(configured)));
  return 3;
}

function readQualityLabels(runDir) {
  const labelsPath = path.join(runDir, "quality-labels.jsonl");
  if (!fs.existsSync(labelsPath)) return { path: null, rows: [] };
  return { path: labelsPath, rows: readJsonl(labelsPath).rows };
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
      if (isRetryableUpstreamStatus(response.status) && attempt < RATE_LIMIT_ATTEMPTS) {
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
        lastError = enriched;
        if (attempt < 2) {
          await sleep(config.verifyExecuteRetryBaseMs || 250);
          continue;
        }
        enriched.error_type = "timeout_retry_exhausted";
        enriched.message = `Upstream request timed out after ${executionTimeoutMs(config)}ms and retry was exhausted.`;
        throw enriched;
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

function isRetryableUpstreamStatus(status) {
  return status >= 500 && status < 600;
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
    const parts = [];
    collectTextValue(parts, parsed.output_text);
    collectTextValue(parts, parsed.response?.output_text);
    collectTextValue(parts, parsed.message?.content);
    collectTextValue(parts, parsed.choices?.map(choice => choice.message?.content));
    collectOutputText(parts, parsed.output);
    collectOutputText(parts, parsed.response?.output);
    const text = parts.map(part => part.trim()).filter(Boolean).join("\n");
    return text || null;
  } catch {
    throw new Error("Upstream returned non-JSON response.");
  }
}

function collectOutputText(parts, output) {
  if (!Array.isArray(output)) return;
  for (const item of output) {
    collectTextValue(parts, item?.text);
    collectTextValue(parts, item?.content);
  }
}

function collectTextValue(parts, value) {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextValue(parts, item);
    return;
  }
  if (!value || typeof value !== "object") return;
  collectTextValue(parts, value.text);
  collectTextValue(parts, value.value);
  collectTextValue(parts, value.output_text);
  collectTextValue(parts, value.refusal);
}

async function writeQualityLabels({ runDir, rows, plan, config }) {
  const labelsPath = path.join(runDir, "quality-labels.jsonl");
  const candidatePlanByRouteId = new Map(plan.filter(item => item.source === "candidate").map(item => [item.route_id, item]));
  const rowByPlanKey = new Map(rows.map(row => [`${row.source}:${row.route_id}`, row]));
  const candidatePlan = plan.filter(item => item.source === "candidate");
  const labelRows = [];
  writeJsonlRows(labelsPath, labelRows);
  for (const planItem of candidatePlan) {
    const row = rowByPlanKey.get(`candidate:${planItem.route_id}`);
    if (!row) {
      appendQualityLabel(labelRows, labelsPath, unjudgeableQualityLabel({
        routeId: planItem.route_id,
        judgeModel: judgeModelForConfig(config),
        reason: "candidate execution row missing",
        judgeError: "missing execution row",
      }));
      continue;
    }
    if (row.error) {
      appendQualityLabel(labelRows, labelsPath, unjudgeableQualityLabel({
        routeId: row.route_id,
        judgeModel: judgeModelForConfig(config),
        reason: "candidate execution error prevented judging",
        judgeError: `execution_error: ${row.error_type || "unknown"}${row.error ? `: ${row.error}` : ""}`,
      }));
      continue;
    }
    if (!row.response_text) {
      appendQualityLabel(labelRows, labelsPath, unjudgeableQualityLabel({
        routeId: row.route_id,
        judgeModel: judgeModelForConfig(config),
        reason: "candidate response text missing",
        judgeError: "missing response text",
      }));
      continue;
    }
    const sourcePlanItem = candidatePlanByRouteId.get(row.route_id) || planItem;
    const result = await judgeRoute({
      userExcerpt: sourcePlanItem?.user_excerpt || null,
      responseText: row.response_text,
      chosenEffort: row.effort,
      config,
    });
    appendQualityLabel(labelRows, labelsPath, {
      route_id: row.route_id,
      acceptance_label: result.label,
      signal: "quality_judge",
      reason: result.reason,
      judge_model: judgeModelForConfig(config),
      judge_usage: result.usage,
      judge_error: result.error,
    });
  }
  return labelsPath;
}

function appendQualityLabel(labelRows, labelsPath, row) {
  labelRows.push(row);
  appendJsonlRow(labelsPath, row);
}

function unjudgeableQualityLabel({ routeId, judgeModel, reason, judgeError }) {
  return {
    route_id: routeId,
    acceptance_label: "ambiguous",
    signal: "quality_judge",
    reason,
    judge_model: judgeModel,
    judge_usage: null,
    judge_error: judgeError,
  };
}

function updateMetricsWithQualityLabels(metrics, runDir, qualityLabelsPath = null) {
  const labelsPath = qualityLabelsPath || readQualityLabels(runDir).path;
  if (!labelsPath) return metrics;
  const samplesPath = path.join(runDir, "samples.jsonl");
  if (!fs.existsSync(samplesPath)) return metrics;
  const qualityLabels = readJsonl(labelsPath).rows;
  const labelMap = feedbackLabelMap(qualityLabels);
  const samples = readJsonl(samplesPath).rows.map(row => ({
    ...row,
    acceptance_label: labelMap.get(row.route_id) || "ambiguous",
  }));
  return {
    ...metrics,
    verification: {
      ...(metrics.verification || {}),
      quality_labels_path: labelsPath,
      quality_labels: qualityLabelSummary(qualityLabels),
      optimization_segments: sampleOptimizationSegments(samples),
    },
  };
}

function qualityLabelSummary(rows = []) {
  const summary = {
    total: rows.length,
    accepted: 0,
    underfit: 0,
    rejected: 0,
    ambiguous: 0,
    ambiguous_reasons: {},
  };
  for (const row of rows) {
    if (row.acceptance_label === "accepted") summary.accepted += 1;
    if (row.acceptance_label === "underfit") summary.underfit += 1;
    if (row.acceptance_label === "rejected") summary.rejected += 1;
    if (row.acceptance_label === "ambiguous") {
      summary.ambiguous += 1;
      const reason = normalizeAmbiguousReason(row);
      summary.ambiguous_reasons[reason] = (summary.ambiguous_reasons[reason] || 0) + 1;
    }
  }
  return summary;
}

function normalizeAmbiguousReason(row) {
  const text = String(row.judge_error || row.reason || "ambiguous").trim();
  const executionMatch = text.match(/^execution_error:\s*([^:]+)/);
  if (executionMatch) return `execution_error: ${executionMatch[1].trim() || "unknown"}`;
  return text || "ambiguous";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateMetricsWithExecution(metrics, rows, { resultsPath, samplesConsidered, plan = null }) {
  const pairing = executionPairingSummary({ rows, plan });
  const errorSummary = executionErrorSummary(rows);
  const actualCandidateTokens = sumUsageTokens(pairing.matched_pairs.map(pair => pair.candidate.executor_usage));
  const actualBaselineTokens = sumUsageTokens(pairing.matched_pairs.map(pair => pair.baseline.executor_usage));
  const exact = pairing.matched_success_pairs > 0 && actualCandidateTokens !== null && actualBaselineTokens !== null;
  const saved = exact ? Math.max(0, actualBaselineTokens - actualCandidateTokens) : null;
  const baselineSources = pairing.baseline_sources;
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
      execution_pairing: pairing.execution_pairing,
      total_planned_pairs: pairing.total_planned_pairs,
      matched_success_pairs: pairing.matched_success_pairs,
      candidate_only_rows: pairing.candidate_only_rows,
      baseline_only_rows: pairing.baseline_only_rows,
      missing_usage_rows: pairing.missing_usage_rows,
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
    updated.weakest_evidence = pairing.execution_pairing === "contaminated"
      ? `Exact savings limited to matched-success execution pairs (${pairing.matched_success_pairs}/${pairing.total_planned_pairs}); pairing is contaminated.`
      : "Exact savings available for sampled counterfactual executor calls.";
  }
  return updated;
}

function executionPairingSummary({ rows, plan = null }) {
  const rowMap = new Map();
  for (const row of rows) rowMap.set(planItemKey(row), row);
  const pairs = plan ? executionPlanPairs(plan) : executionRowsPairs(rows);
  let candidateOnlyRows = 0;
  let baselineOnlyRows = 0;
  let missingUsageRows = 0;
  const matchedPairs = [];
  const baselineSources = new Set();

  for (const pair of pairs) {
    baselineSources.add(pair.baseline.source);
    const candidate = rowMap.get(planItemKey(pair.candidate));
    const baseline = rowMap.get(planItemKey(pair.baseline));
    const candidateSuccess = isMatchedExecutionSuccess(candidate);
    const baselineSuccess = isMatchedExecutionSuccess(baseline);
    if (hasMissingUsage(candidate)) missingUsageRows += 1;
    if (hasMissingUsage(baseline)) missingUsageRows += 1;
    if (candidateSuccess && baselineSuccess) {
      matchedPairs.push({ candidate, baseline });
      continue;
    }
    if (candidateSuccess && !baselineSuccess) candidateOnlyRows += 1;
    if (!candidateSuccess && baselineSuccess) baselineOnlyRows += 1;
  }

  const totalPlannedPairs = pairs.length;
  const matchedSuccessPairs = matchedPairs.length;
  return {
    total_planned_pairs: totalPlannedPairs,
    matched_success_pairs: matchedSuccessPairs,
    candidate_only_rows: candidateOnlyRows,
    baseline_only_rows: baselineOnlyRows,
    missing_usage_rows: missingUsageRows,
    execution_pairing: totalPlannedPairs > 0 && matchedSuccessPairs === totalPlannedPairs ? "complete" : "contaminated",
    baseline_sources: [...baselineSources].sort(),
    matched_pairs: matchedPairs,
  };
}

function executionPlanPairs(plan) {
  return executionRouteGroups(plan).flatMap(group =>
    group.baselines.map(baseline => ({
      candidate: group.candidate,
      baseline,
    })),
  );
}

function executionRowsPairs(rows) {
  const byRoute = new Map();
  for (const row of rows) {
    const group = byRoute.get(row.route_id) || { candidate: null, baselines: [] };
    if (row.source === "candidate") group.candidate = row;
    if (row.source?.startsWith("baseline_")) group.baselines.push(row);
    byRoute.set(row.route_id, group);
  }
  return [...byRoute.values()]
    .filter(group => group.candidate && group.baselines.length)
    .flatMap(group => group.baselines.map(baseline => ({ candidate: group.candidate, baseline })));
}

function isMatchedExecutionSuccess(row) {
  if (!row || row.error) return false;
  if (!Number.isFinite(row.status_code) || row.status_code < 200 || row.status_code >= 300) return false;
  return usageTotalTokens(row.executor_usage) > 0;
}

function hasMissingUsage(row) {
  if (!row || row.error) return false;
  if (!Number.isFinite(row.status_code) || row.status_code < 200 || row.status_code >= 300) return false;
  return !(usageTotalTokens(row.executor_usage) > 0);
}

function usageTotalTokens(usage) {
  if (!usage) return null;
  const value =
    usage.total_tokens ??
    usage.totalTokens ??
    (Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens)
      ? (usage.input_tokens || 0) + (usage.output_tokens || 0)
      : undefined);
  return Number.isFinite(value) ? value : null;
}

function exactSavingsLabel(saved, baseline) {
  return saved !== null && baseline ? `${saved} tokens / ${((saved / baseline) * 100).toFixed(1)}%` : "baseline pending";
}

function evidenceSummary({ runDir, manifest, metrics, config }) {
  const samples = Number(metrics.verification?.samples ?? 0);
  const sampleStatus = samples > 0 ? "ready" : "empty";
  const missing = [];
  const executionPath = path.join(runDir, "execution-results.jsonl");
  const qualityLabelsPath = path.join(runDir, "quality-labels.jsonl");
  if (!fs.existsSync(executionPath) || !metrics.execution) missing.push("execution_missing");
  if (expectsQualityJudge({ config, metrics }) && (!fs.existsSync(qualityLabelsPath) || !qualityLabelsCoverSamples(runDir))) {
    missing.push("judge_missing");
  }
  const pairingRatio = executionPairingRatio(metrics.execution);
  const pairingContaminated = metrics.execution && pairingRatio !== null && pairingRatio < 0.8;
  const evidenceStatus = missing.length ? "incomplete" : pairingContaminated ? "partial" : "complete";
  const claimStatus = evidenceStatus === "complete" && metrics.savings?.exact === true ? "proven" : "not_proven";
  const pairingMissing = pairingContaminated ? ["execution_pairing_contaminated"] : [];
  return {
    evidence_status: evidenceStatus,
    sample_status: sampleStatus,
    claim_status: claimStatus,
    execution_pairing: metrics.execution?.execution_pairing ?? null,
    execution_pairing_ratio: pairingRatio,
    missing: [...missing, ...pairingMissing],
    reason: evidenceReason([...missing, ...pairingMissing], metrics),
  };
}

function expectsQualityJudge({ config, metrics }) {
  if (config.enableQualityJudge === false) return false;
  return Number(metrics.verification?.samples ?? 0) > 0;
}

function qualityLabelsCoverSamples(runDir) {
  const samplesPath = path.join(runDir, "samples.jsonl");
  const labelsPath = path.join(runDir, "quality-labels.jsonl");
  if (!fs.existsSync(samplesPath) || !fs.existsSync(labelsPath)) return false;
  const samples = readJsonl(samplesPath).rows;
  const labels = readJsonl(labelsPath).rows;
  const labeledRouteIds = new Set(labels.map(row => row.route_id).filter(Boolean));
  return samples.every(row => labeledRouteIds.has(row.route_id));
}

function evidenceReason(missing, metrics) {
  if (missing.includes("execution_pairing_contaminated")) {
    return `execution pairing contaminated; exact savings limited to ${metrics.execution?.matched_success_pairs ?? 0}/${metrics.execution?.total_planned_pairs ?? 0} matched-success pairs`;
  }
  const hasExecution = !missing.includes("execution_missing");
  const hasJudge = !missing.includes("judge_missing");
  if (hasExecution && hasJudge) {
    return metrics.savings?.exact === true ? "exact execution and judge labels available" : "evidence available but exact savings not proven";
  }
  if (!hasExecution && !hasJudge) return "execution preflight failed; no exact execution or judge labels available";
  if (!hasExecution) return "execution preflight failed; no exact execution available";
  return "judge labels unavailable";
}

function executionPairingRatio(execution) {
  if (!execution) return null;
  const matched = Number(execution.matched_success_pairs);
  const total = Number(execution.total_planned_pairs);
  if (!Number.isFinite(matched) || !Number.isFinite(total) || total <= 0) return null;
  return matched / total;
}

function computeGates({ manifest, metrics, config, evidence = null }) {
  const gates = manifest.gates || DEFAULT_GATES;
  const validity = Number(metrics.routes?.validity_percent) / 100;
  const underfitRate = parsePercent(metrics.outcomes?.underfit_rate);
  const overhead = metrics.dispatcher_overhead?.ratio;
  const executionAttempted = Boolean(metrics.execution);
  const exactSavingsAvailable = metrics.savings?.exact === true;
  const savingsRatio = executionAttempted && !exactSavingsAvailable ? null : savingsGateRatio(metrics);
  const telemetryOk = metrics.verification?.telemetry_preconditions?.ok !== false;
  const evidenceState = evidence || {
    evidence_status: "unknown",
    missing: [],
    reason: null,
  };
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
    {
      name: "evidence_complete",
      severity: "soft",
      observed: evidenceState.evidence_status,
      threshold: "complete",
      pass: evidenceState.evidence_status === "complete",
      missing: evidenceState.missing,
      reason: evidenceState.evidence_status === "complete" ? null : evidenceState.reason,
    },
    humanReviewQueueGate(config),
  ];
}

function savingsGateRatio(metrics) {
  if (metrics.savings?.estimated_tokens_saved == null || metrics.savings?.estimated_xhigh_baseline_tokens == null) return null;
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

function executionPairingReportLine(metrics) {
  const execution = metrics.execution || {};
  if (!Number.isFinite(execution.matched_success_pairs) || !Number.isFinite(execution.total_planned_pairs)) {
    return "Execution pairing: baseline pending";
  }
  return `Execution pairing: ${execution.matched_success_pairs} matched-success pairs / ${execution.total_planned_pairs} total planned`;
}

function savingsBasisLabel(metrics) {
  const execution = metrics.execution || {};
  if (!metrics.savings?.exact) return "baseline pending";
  if (!Number.isFinite(execution.matched_success_pairs) || !Number.isFinite(execution.total_planned_pairs)) {
    return "matched-success pairs only";
  }
  return `matched-success pairs only (${execution.matched_success_pairs}/${execution.total_planned_pairs})`;
}

function formatOptimizationSegments(segments = {}) {
  return OPTIMIZATION_SEGMENTS.map(name => {
    const segment = segments[name] || {};
    return `- ${name}: count ${segment.count ?? 0}, underfit ${segment.underfit_rate ?? "baseline pending"}, rejection ${segment.rejection_rate ?? "baseline pending"}, acceptance ${segment.acceptance_rate ?? "baseline pending"}`;
  });
}

function formatQualityLabelSummary(summary) {
  if (!summary) return "baseline pending";
  return `accepted ${summary.accepted ?? 0}, underfit ${summary.underfit ?? 0}, rejected ${summary.rejected ?? 0}, ambiguous ${summary.ambiguous ?? 0}`;
}

function formatAmbiguousReasons(summary) {
  const reasons = summary?.ambiguous_reasons || {};
  const entries = Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return [];
  return [
    `Ambiguous reasons:`,
    ...entries.map(([reason, count]) => `- ${reason}: ${count}`),
  ];
}

function sampleOptimizationSegments(rows = []) {
  const segments = Object.fromEntries(
    OPTIMIZATION_SEGMENTS.map(segment => [
      segment,
      {
        count: 0,
        accepted: 0,
        underfit: 0,
        rejected: 0,
        ambiguous: 0,
        underfit_rate: "baseline pending",
        rejection_rate: "baseline pending",
        acceptance_rate: "baseline pending",
      },
    ]),
  );

  for (const row of rows) {
    const segmentName = classifyOptimizationSegment(row);
    const segment = segments[segmentName] || segments.effort_sensitive;
    const label = row.acceptance_label;
    segment.count += 1;
    if (label === "accepted") segment.accepted += 1;
    if (label === "underfit") segment.underfit += 1;
    if (label === "rejected") segment.rejected += 1;
    if (label === "ambiguous") segment.ambiguous += 1;
  }

  for (const segment of Object.values(segments)) {
    segment.underfit_rate = percent(segment.underfit, segment.count);
    segment.rejection_rate = percent(segment.rejected + segment.ambiguous, segment.count);
    segment.acceptance_rate = percent(segment.accepted, segment.count);
  }
  return segments;
}
