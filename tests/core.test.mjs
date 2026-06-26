import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../packages/core/config.mjs";
import { evalLogs } from "../packages/core/eval.mjs";
import { judgeRoute } from "../packages/core/judge.mjs";
import { appendJsonl, readJsonl } from "../packages/core/jsonl.mjs";
import { parseSseUsage } from "../packages/core/sse.mjs";
import {
  createVerificationRun,
  executeVerificationRun,
  gateVerificationRun,
  reportVerificationRun,
  runVerification,
} from "../packages/core/verify.mjs";
import { writeFeedback } from "../packages/core/feedback.mjs";
import { normalizeRouteEvent } from "../packages/core/telemetry.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peto-core-test-"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

test("normalizeRouteEvent preserves legacy usage and adds verification fields", () => {
  const legacy = {
    id: "route-1",
    phase: "response",
    status: "ok",
    usage: { total_tokens: 120 },
  };

  const normalized = normalizeRouteEvent(legacy);

  assert.equal(normalized.schema_version, "1.0");
  assert.equal(normalized.route_id, "route-1");
  assert.deepEqual(normalized.executor_usage, { total_tokens: 120 });
  assert.deepEqual(normalized.usage, { total_tokens: 120 });
  assert.equal(normalized.retry_of, null);
  assert.deepEqual(normalized.annotations, []);
});

test("evalLogs splits router and executor usage and honors explicit feedback labels", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath,
    feedbackPath,
    localRouterUrl: "http://127.0.0.1:9/route",
  });

  appendJsonl(logPath, {
    id: "accepted-route",
    phase: "request",
    chosen_effort: "low",
    router_usage: { total_tokens: 10 },
    profile_segment: "default",
    request_class: "coding",
    language: "en",
    risk_tier: "low",
  });
  appendJsonl(logPath, {
    id: "accepted-route",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 90 },
    latency_ms: 100,
  });
  appendJsonl(logPath, {
    id: "underfit-route",
    phase: "request",
    chosen_effort: "minimal",
    router_usage: { total_tokens: 5 },
    profile_segment: "default",
    request_class: "writing",
    language: "en",
    risk_tier: "medium",
  });
  appendJsonl(logPath, {
    id: "underfit-route",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 45 },
    latency_ms: 120,
  });
  appendJsonl(feedbackPath, {
    id: "underfit-route",
    route_id: "underfit-route",
    acceptance_label: "underfit",
    signal: "explicit_label",
  });

  const data = evalLogs({ config: configPath });

  assert.equal(data.dispatcher_overhead.router_tokens, 15);
  assert.equal(data.dispatcher_overhead.executor_tokens, 135);
  assert.equal(data.dispatcher_overhead.total_tokens, 150);
  assert.equal(data.outcomes.accepted_estimate, 1);
  assert.equal(data.outcomes.underfit, 1);
  assert.equal(data.cost_per_accepted_outcome.tokens, 150);
});

test("evalLogs does not count feedback_signal routes as accepted and emits effort_breakdown and low_minimal_trend", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, { memoryPath: root, logPath, feedbackPath, localRouterUrl: "http://127.0.0.1:9/route" });

  // Route with gateway displeasure signal and no feedback row — was incorrectly counted as accepted before fix
  appendJsonl(logPath, { id: "displeased-route", phase: "request", chosen_effort: "medium", feedback_signal: true });
  appendJsonl(logPath, { id: "displeased-route", phase: "response", status: "ok", executor_usage: { total_tokens: 100 } });
  // Clean unlabeled route — should still count as accepted
  appendJsonl(logPath, { id: "clean-route", phase: "request", chosen_effort: "medium", feedback_signal: false });
  appendJsonl(logPath, { id: "clean-route", phase: "response", status: "ok", executor_usage: { total_tokens: 80 } });

  const data = evalLogs({ config: configPath });

  assert.equal(data.outcomes.accepted_estimate, 1, "feedback_signal route must not be counted as accepted");
  assert.equal(typeof data.effort_breakdown, "object");
  assert.ok(data.effort_breakdown.medium, "effort_breakdown should have a medium entry");
  assert.equal(data.effort_breakdown.medium.count, 2);
  assert.equal(typeof data.low_minimal_trend, "object");
});

test("evalLogs counts explicitly accepted routes even when the response failed", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, { memoryPath: root, logPath, feedbackPath, localRouterUrl: "http://127.0.0.1:9/route" });

  appendJsonl(logPath, { id: "accepted-failed-route", phase: "request", chosen_effort: "medium" });
  appendJsonl(logPath, {
    id: "accepted-failed-route",
    phase: "response",
    status: "error",
    executor_usage: { total_tokens: 100 },
  });
  appendJsonl(feedbackPath, {
    id: "accepted-failed-route",
    route_id: "accepted-failed-route",
    acceptance_label: "accepted",
    signal: "explicit_label",
  });

  const data = evalLogs({ config: configPath });

  assert.equal(data.routes.failed, 1);
  assert.equal(data.outcomes.accepted_estimate, 1);
});

test("writeFeedback records explicit labels for route ids", () => {
  const root = makeTempDir();
  const feedbackPath = path.join(root, "feedback-signals.jsonl");

  const result = writeFeedback({
    feedbackPath,
    routeId: "route-123",
    label: "accepted",
    notes: "user accepted",
  });
  const rows = readJsonl(feedbackPath).rows;

  assert.equal(result.route_id, "route-123");
  assert.equal(rows[0].acceptance_label, "accepted");
  assert.equal(rows[0].signal, "explicit_label");
});

test("verification create writes manifest with config hash and null sample hash", () => {
  const root = makeTempDir();
  const ticketPath = path.join(root, "ticket.json");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath: path.join(root, "router-events.jsonl"),
    feedbackPath: path.join(root, "feedback-signals.jsonl"),
  });
  writeJson(ticketPath, {
    id: "peto-verify-test",
    seed: 42,
    candidate: { type: "replay_current" },
    baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
  });

  const result = createVerificationRun({ config: configPath, ticket: ticketPath });

  assert.equal(result.run_id, "peto-verify-test");
  assert.equal(fs.existsSync(path.join(result.run_dir, "config-snapshot.json")), true);

  const parsedManifest = JSON.parse(fs.readFileSync(path.join(result.run_dir, "run-manifest.json"), "utf8"));
  assert.equal(parsedManifest.seed, 42);
  assert.equal(parsedManifest.samples_sha256, null);
  assert.equal(typeof parsedManifest.config_snapshot_sha256, "string");
});

test("verification create accepts simple YAML tickets", () => {
  const root = makeTempDir();
  const ticketPath = path.join(root, "ticket.yaml");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath: path.join(root, "router-events.jsonl"),
    feedbackPath: path.join(root, "feedback-signals.jsonl"),
  });
  fs.writeFileSync(ticketPath, ["id: peto-verify-yaml", "seed: 9", "sample_size: 3", ""].join("\n"));

  const result = createVerificationRun({ config: configPath, ticket: ticketPath });
  const parsedManifest = JSON.parse(fs.readFileSync(path.join(result.run_dir, "run-manifest.json"), "utf8"));

  assert.equal(result.run_id, "peto-verify-yaml");
  assert.equal(parsedManifest.seed, 9);
  assert.equal(parsedManifest.ticket.sample_size, 3);
});

test("verification create accepts nested YAML gates and baselines", () => {
  const root = makeTempDir();
  const ticketPath = path.join(root, "ticket.yaml");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath: path.join(root, "router-events.jsonl"),
    feedbackPath: path.join(root, "feedback-signals.jsonl"),
  });
  fs.writeFileSync(
    ticketPath,
    [
      "id: peto-verify-nested-yaml",
      "seed: 12",
      "gates:",
      "  min_route_json_validity: 0.95",
      "baselines:",
      "  - name: fixed_medium",
      "    type: fixed_effort",
      "    effort: medium",
      "",
    ].join("\n"),
  );

  const result = createVerificationRun({ config: configPath, ticket: ticketPath });
  const parsedManifest = JSON.parse(fs.readFileSync(path.join(result.run_dir, "run-manifest.json"), "utf8"));

  assert.equal(parsedManifest.gates.min_route_json_validity, 0.95);
  assert.deepEqual(parsedManifest.ticket.baselines, [{ name: "fixed_medium", type: "fixed_effort", effort: "medium" }]);
});

test("verification create reports malformed YAML tickets with a clear parser message", () => {
  const root = makeTempDir();
  const ticketPath = path.join(root, "ticket.yaml");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath: path.join(root, "router-events.jsonl"),
    feedbackPath: path.join(root, "feedback-signals.jsonl"),
  });
  fs.writeFileSync(ticketPath, ["- unsupported", ""].join("\n"));

  assert.throws(
    () => createVerificationRun({ config: configPath, ticket: ticketPath }),
    /Failed to parse ticket YAML \(line ~1\): Unsupported YAML list at indent 0\. Supported subset: flat key\/value, nested maps, simple lists\./,
  );
});

test("verification run produces deterministic samples, metrics, gates, verdict, and report", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath,
    feedbackPath,
    allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
  });
  writeJson(ticketPath, {
    id: "peto-verify-full",
    seed: 7,
    sample_size: 2,
    gates: {
      min_route_json_validity: 0.99,
      max_underfit_delta: 1,
      max_dispatcher_overhead_ratio: 0.2,
      min_net_savings_ratio: 0.99,
    },
    baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
  });
  for (const item of [
    ["route-a", "low", "accepted", 10, 90],
    ["route-b", "minimal", "underfit", 5, 45],
    ["route-c", "medium", "accepted", 12, 120],
  ]) {
    const [id, effort, label, routerTokens, executorTokens] = item;
    appendJsonl(logPath, {
      id,
      phase: "request",
      chosen_effort: effort,
      router_usage: { total_tokens: routerTokens },
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: `sample ${id}`,
    });
    appendJsonl(logPath, {
      id,
      phase: "response",
      status: "ok",
      executor_usage: { total_tokens: executorTokens },
      latency_ms: 100,
    });
    appendJsonl(feedbackPath, {
      id,
      route_id: id,
      acceptance_label: label,
      signal: "explicit_label",
    });
  }

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  const run = runVerification({ config: configPath, id: created.run_id });
  const gated = gateVerificationRun({ config: configPath, id: created.run_id });
  const reported = reportVerificationRun({ config: configPath, id: created.run_id });

  assert.equal(run.samples.count, 2);
  assert.equal(typeof run.samples.sha256, "string");
  assert.equal(fs.existsSync(path.join(created.run_dir, "candidate-routes.jsonl")), true);
  assert.equal(fs.existsSync(path.join(created.run_dir, "baseline-routes.fixed_xhigh.jsonl")), true);
  assert.equal(run.metrics.cost_per_accepted_outcome.tokens > 0, true);
  assert.equal(gated.verdict.verdict, "hold");
  assert.equal(gated.gates.some(gate => gate.name === "min_net_savings_ratio" && gate.severity === "soft"), true);
  const humanReviewGate = gated.gates.find(gate => gate.name === "human_review_queue_clear");
  assert.equal(humanReviewGate.severity, "soft");
  assert.equal(humanReviewGate.pass, true);
  assert.match(humanReviewGate.note, /not configured/);
  assert.equal(gated.verdict.human_review_required, false);
  assert.equal(gated.verdict.human_review_queue_clear, true);
  assert.equal(reported.report_path.endsWith("report.md"), true);
  assert.match(fs.readFileSync(reported.report_path, "utf8"), /PETO Verification Report/);
});

test("verification gate soft-fails when configured human review queue is non-empty", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const queuePath = path.join(root, "human-review-queue.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath,
    feedbackPath,
    humanReviewQueuePath: queuePath,
    allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
  });
  writeJson(ticketPath, {
    id: "peto-verify-human-review-queue",
    seed: 13,
    sample_size: 1,
    gates: { min_net_savings_ratio: 0 },
  });
  fs.writeFileSync(queuePath, `${JSON.stringify({ route_id: "route-review", reason: "needs review" })}\n`);
  appendJsonl(logPath, {
    id: "route-review",
    phase: "request",
    chosen_effort: "medium",
    router_usage: { total_tokens: 5 },
    profile_segment: "default",
    request_class: "coding",
    language: "en",
    risk_tier: "low",
  });
  appendJsonl(logPath, {
    id: "route-review",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 80 },
    latency_ms: 100,
  });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  runVerification({ config: configPath, id: created.run_id });
  const gated = gateVerificationRun({ config: configPath, id: created.run_id });
  const humanReviewGate = gated.gates.find(gate => gate.name === "human_review_queue_clear");

  assert.equal(humanReviewGate.severity, "soft");
  assert.equal(humanReviewGate.pass, false);
  assert.equal(gated.verdict.human_review_required, true);
  assert.equal(gated.verdict.human_review_queue_clear, false);
  assert.equal(gated.verdict.verdict, "hold");
});

test("new-format verification logs block when required stratification fields are missing", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath,
    feedbackPath,
    allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
  });
  writeJson(ticketPath, {
    id: "peto-verify-missing-field",
    seed: 11,
    sample_size: 1,
  });
  appendJsonl(logPath, {
    id: "route-missing",
    route_id: "route-missing",
    schema_version: "1.0",
    phase: "request",
    chosen_effort: "low",
    router_usage: { total_tokens: 8 },
    profile_segment: "default",
    language: "en",
    risk_tier: "low",
  });
  appendJsonl(logPath, {
    id: "route-missing",
    route_id: "route-missing",
    schema_version: "1.0",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 80 },
    latency_ms: 100,
  });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  const run = runVerification({ config: configPath, id: created.run_id });
  const gated = gateVerificationRun({ config: configPath, id: created.run_id });

  assert.deepEqual(run.missing_verification_fields, [{ route_id: "route-missing", field: "request_class" }]);
  assert.equal(gated.verdict.verdict, "blocked");
  assert.equal(gated.verdict.blocking_reason, "required verification telemetry fields are missing");
});

test("parseSseUsage returns usage from final data event and null for malformed streams", () => {
  const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 };
  const stream = [
    "event: response.output_text.delta",
    'data: {"delta":"hello"}',
    "",
    "event: response.completed",
    `data: ${JSON.stringify({ response: { usage } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  assert.deepEqual(parseSseUsage(stream), usage);
  assert.equal(parseSseUsage("data: {not-json}\n\nnot-sse"), null);
});

test("verification execute dry-run prints plan without calling upstream", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { total_tokens: 99 } }));
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      defaultTargetModel: "mock-executor",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-dry-run",
      seed: 2,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-execute-dry-run",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain dry run.",
    });
    appendJsonl(logPath, { id: "route-execute-dry-run", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id, "dry-run": true });

    assert.equal(result.kind, "verify_execute");
    assert.equal(result.dry_run, true);
    assert.equal(result.plan.length, 2);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(created.run_dir, "execution-results.jsonl")), false);
  } finally {
    await closeServer(server);
  }
});

test("verification execute writes execution results and updates metrics with real token comparison", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const effort = parsed.reasoning?.effort;
      const usage = effort === "xhigh"
        ? { input_tokens: 10, output_tokens: 90, total_tokens: 100 }
        : { input_tokens: 10, output_tokens: 30, total_tokens: 40 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage }));
    });
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer test-token" },
      defaultTargetModel: "mock-executor",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute",
      seed: 3,
      sample_size: 2,
      gates: { min_net_savings_ratio: 0.5 },
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    for (const id of ["route-execute-a", "route-execute-b"]) {
      appendJsonl(logPath, {
        id,
        phase: "request",
        chosen_effort: "medium",
        profile_segment: "default",
        request_class: "coding",
        language: "en",
        risk_tier: "low",
        user_excerpt: `Explain ${id}.`,
      });
      appendJsonl(logPath, { id, phase: "response", status: "ok", executor_usage: { total_tokens: 40 } });
    }

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
    const metrics = JSON.parse(fs.readFileSync(path.join(created.run_dir, "metrics.json"), "utf8"));
    const gated = gateVerificationRun({ config: configPath, id: created.run_id });

    assert.equal(result.dry_run, false);
    assert.equal(result.executed, 4);
    assert.equal(requests.length, 4);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map(row => row.source).sort(),
      ["baseline_fixed_xhigh", "baseline_fixed_xhigh", "candidate", "candidate"],
    );
    assert.ok(rows.every(row => row.route_id && row.effort && row.executor_usage && Number.isFinite(row.latency_ms)));
    assert.equal(metrics.verification.exact_savings_available, true);
    assert.equal(metrics.execution.actual_candidate_tokens, 80);
    assert.equal(metrics.execution.actual_baseline_tokens, 200);
    assert.equal(metrics.savings.exact, true);
    assert.equal(metrics.savings.actual_tokens, 80);
    assert.equal(metrics.savings.estimated_xhigh_baseline_tokens, 200);
    assert.equal(metrics.savings.estimated_tokens_saved, 120);
    assert.equal(gated.verdict.verdict, "promote");
  } finally {
    await closeServer(server);
  }
});

test("verification execute enforces 50 sample limit and records upstream errors", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporary" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { total_tokens: 10 } }));
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer test-token" },
      defaultTargetModel: "mock-executor",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-limit",
      seed: 4,
      sample_size: 60,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    for (let index = 0; index < 60; index += 1) {
      const id = `route-limit-${index}`;
      appendJsonl(logPath, {
        id,
        phase: "request",
        chosen_effort: "medium",
        profile_segment: "default",
        request_class: "coding",
        language: "en",
        risk_tier: "low",
        user_excerpt: `Explain ${id}.`,
      });
      appendJsonl(logPath, { id, phase: "response", status: "ok" });
    }

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;

    assert.equal(result.samples_considered, 50);
    assert.equal(rows.length, 100);
    assert.equal(rows.filter(row => row.error).length, 1);
    assert.equal(rows.filter(row => row.executor_usage).length, 99);
  } finally {
    await closeServer(server);
  }
});

test("verification gate does not use estimated savings after failed execution", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath,
    feedbackPath,
    upstreamBaseUrl: "http://127.0.0.1:9",
    upstreamHeaders: { Authorization: "Bearer test-token" },
    defaultTargetModel: "mock-executor",
    allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
  });
  writeJson(ticketPath, {
    id: "peto-verify-execute-failed-gate",
    seed: 5,
    sample_size: 1,
    gates: { min_net_savings_ratio: 0.5 },
    baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
  });
  appendJsonl(logPath, {
    id: "route-failed-execution",
    phase: "request",
    chosen_effort: "medium",
    router_usage: { total_tokens: 1 },
    profile_segment: "default",
    request_class: "coding",
    language: "en",
    risk_tier: "low",
    user_excerpt: "This upstream will fail.",
  });
  appendJsonl(logPath, {
    id: "route-failed-execution",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 100 },
  });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  runVerification({ config: configPath, id: created.run_id });
  await executeVerificationRun({ config: configPath, id: created.run_id });
  const gated = gateVerificationRun({ config: configPath, id: created.run_id });
  const metrics = JSON.parse(fs.readFileSync(path.join(created.run_dir, "metrics.json"), "utf8"));
  const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
  const savingsGate = gated.gates.find(gate => gate.name === "min_net_savings_ratio");

  assert.equal(rows.every(row => row.error_type === "network"), true);
  assert.equal(metrics.execution.exact, false);
  assert.equal(metrics.execution.errors, 2);
  assert.equal(metrics.execution.actual_candidate_tokens, null);
  assert.equal(metrics.execution.actual_baseline_tokens, null);
  assert.equal(savingsGate.pass, false);
  assert.equal(savingsGate.observed, null);
  assert.match(savingsGate.reason, /exact execution savings unavailable/);
  assert.equal(gated.verdict.verdict, "hold");
});

test("verification execute fails preflight before calls when auth is missing", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { total_tokens: 10 } }));
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      defaultTargetModel: "mock-executor",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-missing-auth",
      seed: 6,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-missing-auth",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain missing auth.",
    });
    appendJsonl(logPath, { id: "route-missing-auth", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });

    await assert.rejects(
      () => executeVerificationRun({ config: configPath, id: created.run_id }),
      /preflight.*Authorization/i,
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(created.run_dir, "execution-results.jsonl")), false);
  } finally {
    await closeServer(server);
  }
});

test("verification execute records 401 upstream responses with diagnostic summary", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad api key" }));
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer bad-token" },
      defaultTargetModel: "mock-executor",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-401",
      seed: 7,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-auth-failure",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain auth failure.",
    });
    appendJsonl(logPath, { id: "route-auth-failure", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
    const metrics = JSON.parse(fs.readFileSync(path.join(created.run_dir, "metrics.json"), "utf8"));

    assert.equal(result.executed, 2);
    assert.equal(result.errors, 2);
    assert.deepEqual(result.errors_by_type, { "401": 2 });
    assert.deepEqual(result.distinct_errors, ["Upstream 401 auth failure: {\"error\":\"bad api key\"}"]);
    assert.ok(rows.every(row => row.status_code === 401));
    assert.ok(rows.every(row => row.error_type === "401"));
    assert.ok(rows.every(row => row.model === "mock-executor"));
    assert.ok(rows.every(row => row.upstream_url === `http://127.0.0.1:${port}/v1/responses`));
    assert.equal(metrics.execution.exact, false);
  } finally {
    await closeServer(server);
  }
});

test("verification execute records 404 upstream responses with diagnostic summary", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer test-token" },
      defaultTargetModel: "mock-executor",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-404",
      seed: 8,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-endpoint-mismatch",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain endpoint mismatch.",
    });
    appendJsonl(logPath, { id: "route-endpoint-mismatch", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;

    assert.equal(result.executed, 2);
    assert.equal(result.errors, 2);
    assert.deepEqual(result.errors_by_type, { "404": 2 });
    assert.deepEqual(result.distinct_errors, ["Upstream 404 endpoint mismatch: not found"]);
    assert.ok(rows.every(row => row.status_code === 404));
    assert.ok(rows.every(row => row.error_type === "404"));
  } finally {
    await closeServer(server);
  }
});

test("verification execute records parse failures with status code", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not-json");
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer test-token" },
      defaultTargetModel: "mock-executor",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-parse",
      seed: 9,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-parse-failure",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain parse failure.",
    });
    appendJsonl(logPath, { id: "route-parse-failure", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;

    assert.equal(result.errors, 2);
    assert.deepEqual(result.errors_by_type, { parse: 2 });
    assert.ok(rows.every(row => row.status_code === 200));
    assert.ok(rows.every(row => row.error_type === "parse"));
  } finally {
    await closeServer(server);
  }
});

test("verification execute times out hanging upstream responses", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { total_tokens: 10 } }));
    }, 200);
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer test-token" },
      defaultTargetModel: "mock-executor",
      verifyExecuteTimeoutMs: 20,
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-timeout",
      seed: 10,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-timeout",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain timeout.",
    });
    appendJsonl(logPath, { id: "route-timeout", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;

    assert.equal(result.errors, 2);
    assert.deepEqual(result.errors_by_type, { timeout: 2 });
    assert.ok(rows.every(row => row.error_type === "timeout"));
    assert.ok(rows.every(row => row.attempts === 1));
    assert.match(result.distinct_errors[0], /timed out/i);
  } finally {
    await closeServer(server);
  }
});

test("judgeRoute returns ambiguous on unparseable judge output", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output_text: "not-json", usage: { total_tokens: 4 } }));
  });
  const port = await listen(server);
  try {
    const result = await judgeRoute({
      userExcerpt: "Summarize this.",
      responseText: "Summary.",
      chosenEffort: "low",
      config: {
        upstreamBaseUrl: `http://127.0.0.1:${port}`,
        judgeModel: "mock-judge",
      },
    });

    assert.equal(result.label, "ambiguous");
    assert.equal(result.reason, null);
    assert.equal(result.usage, null);
    assert.match(result.error, /unparseable/i);
  } finally {
    await closeServer(server);
  }
});

test("verification execute writes quality labels for candidate responses only", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      if (parsed.model === "mock-judge") {
        if (parsed.input.includes("route-quality-b")) {
          res.end(JSON.stringify({ output_text: "not-json", usage: { total_tokens: 3 } }));
          return;
        }
        res.end(
          JSON.stringify({
            output_text: JSON.stringify({ label: "accepted", reason: "The answer satisfied the request." }),
            usage: { total_tokens: 7 },
          }),
        );
        return;
      }
      const effort = parsed.reasoning?.effort;
      res.end(
        JSON.stringify({
          output_text: `executor response for ${parsed.input}`,
          usage: effort === "xhigh" ? { total_tokens: 100 } : { total_tokens: 40 },
        }),
      );
    });
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer test-token" },
      defaultTargetModel: "mock-executor",
      judgeModel: "mock-judge",
      judgeEffort: "low",
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-quality-labels",
      seed: 6,
      sample_size: 2,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    for (const id of ["route-quality-a", "route-quality-b"]) {
      appendJsonl(logPath, {
        id,
        phase: "request",
        chosen_effort: "medium",
        profile_segment: "default",
        request_class: "coding",
        language: "en",
        risk_tier: "low",
        user_excerpt: `Explain ${id}.`,
      });
      appendJsonl(logPath, { id, phase: "response", status: "ok", executor_usage: { total_tokens: 40 } });
    }

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const executionRows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
    const labelRows = readJsonl(path.join(created.run_dir, "quality-labels.jsonl")).rows;
    const evaluated = evalLogs({ config: configPath, feedback: result.quality_labels_path });
    const manifest = JSON.parse(fs.readFileSync(path.join(created.run_dir, "run-manifest.json"), "utf8"));

    assert.equal(result.quality_labels_path, path.join(created.run_dir, "quality-labels.jsonl"));
    assert.equal(requests.filter(request => request.model === "mock-judge").length, 2);
    assert.equal(executionRows.filter(row => row.source === "candidate" && row.response_text).length, 2);
    assert.equal(executionRows.filter(row => row.source.startsWith("baseline_") && row.response_text === null).length, 2);
    assert.deepEqual(
      labelRows.map(row => row.acceptance_label).sort(),
      ["accepted", "ambiguous"],
    );
    for (const row of labelRows) {
      assert.deepEqual(Object.keys(row).sort(), [
        "acceptance_label",
        "judge_model",
        "judge_usage",
        "reason",
        "route_id",
        "signal",
      ]);
      assert.equal(row.signal, "quality_judge");
      assert.equal(row.judge_model, "mock-judge");
    }
    assert.equal(evaluated.outcomes.accepted_estimate, 1);
    assert.ok(manifest.annotations.includes("quality_judge_complete"));
  } finally {
    await closeServer(server);
  }
});

test("verification execute skips quality judge when disabled", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let judgeCalls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.model === "mock-judge") judgeCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: "executor response", usage: { total_tokens: 10 } }));
    });
  });
  const port = await listen(server);
  try {
    writeJson(configPath, {
      memoryPath: root,
      logPath,
      feedbackPath,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
      upstreamHeaders: { Authorization: "Bearer test-token" },
      defaultTargetModel: "mock-executor",
      judgeModel: "mock-judge",
      enableQualityJudge: false,
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-quality-disabled",
      seed: 7,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-quality-disabled",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain disabled judge.",
    });
    appendJsonl(logPath, { id: "route-quality-disabled", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });

    assert.equal(result.quality_labels_path, null);
    assert.equal(judgeCalls, 0);
    assert.equal(fs.existsSync(path.join(created.run_dir, "quality-labels.jsonl")), false);
  } finally {
    await closeServer(server);
  }
});
