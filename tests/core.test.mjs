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
import { classifyOptimizationSegment, classifyRequestTelemetry, normalizeRouteEvent } from "../packages/core/telemetry.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peto-core-test-"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function writeJsonlRowsForTest(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function executionRowForTest({ routeId, source, effort, tokens = null, statusCode = 200, errorType = null, error = null, responseText = null }) {
  return {
    route_id: routeId,
    source,
    effort,
    model: "mock-executor",
    upstream_url: "http://127.0.0.1:1/v1/responses",
    status_code: statusCode,
    attempts: 1,
    executor_usage: tokens === null ? null : { total_tokens: tokens },
    response_text: responseText,
    latency_ms: 1,
    error_type: errorType,
    error,
  };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function appendVerificationPair(logPath, id, fields = {}) {
  appendJsonl(logPath, {
    id,
    route_id: id,
    schema_version: "1.0",
    phase: "request",
    router_usage: { total_tokens: 5 },
    profile_segment: "default",
    language: "en",
    risk_tier: "low",
    ...fields,
  });
  appendJsonl(logPath, {
    id,
    route_id: id,
    schema_version: "1.0",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 80 },
    latency_ms: 100,
  });
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

test("classifyRequestTelemetry derives compact request labels and prompt-shape flags", () => {
  assert.deepEqual(
    classifyRequestTelemetry({
      user_excerpt: "Generate 0 to 3 hyperpersonalized suggestions of what this user can do with Codex, deeply viewing their connected apps.",
    }),
    {
      request_class: "codex_suggestions",
      connected_app_required: true,
      memory_lookup_needed: false,
      tool_execution_required: false,
      workspace_action_required: false,
      action_or_recovery_required: false,
      local_artifact_required: false,
    },
  );

  assert.deepEqual(
    classifyRequestTelemetry({ user_excerpt: "Please restore my previous Codex session and continue from the last checkpoint." }),
    {
      request_class: "session_restore",
      connected_app_required: false,
      memory_lookup_needed: true,
      tool_execution_required: false,
      workspace_action_required: false,
      action_or_recovery_required: false,
      local_artifact_required: false,
    },
  );

  assert.deepEqual(
    classifyRequestTelemetry({ user_excerpt: "Analyze this rollout_summary jsonl and extract durable memory." }),
    {
      request_class: "memory_extraction",
      connected_app_required: false,
      memory_lookup_needed: true,
      tool_execution_required: false,
      workspace_action_required: false,
      action_or_recovery_required: false,
      local_artifact_required: false,
    },
  );

  assert.deepEqual(classifyRequestTelemetry({ user_excerpt: "Debug the failing npm test in this repo." }), {
    request_class: "coding_help",
    connected_app_required: false,
    memory_lookup_needed: false,
    tool_execution_required: true,
    workspace_action_required: true,
    action_or_recovery_required: false,
    local_artifact_required: false,
  });

  assert.deepEqual(
    classifyRequestTelemetry({
      user_excerpt: "You are a helpful assistant. Generate a concise UI title for this task. The tasks typically have to do with coding-related tasks.",
    }),
    {
      request_class: "other",
      connected_app_required: false,
      memory_lookup_needed: false,
      tool_execution_required: false,
      workspace_action_required: false,
      action_or_recovery_required: false,
      local_artifact_required: false,
    },
  );

  assert.deepEqual(classifyRequestTelemetry({ user_excerpt: "What should I eat for dinner?" }), {
    request_class: "other",
    connected_app_required: false,
    memory_lookup_needed: false,
    tool_execution_required: false,
    workspace_action_required: false,
    action_or_recovery_required: false,
    local_artifact_required: false,
  });

  assert.deepEqual(classifyRequestTelemetry({ user_excerpt: "Run git status and summarize the workspace changes." }), {
    request_class: "coding_help",
    connected_app_required: false,
    memory_lookup_needed: false,
    tool_execution_required: true,
    workspace_action_required: false,
    action_or_recovery_required: false,
    local_artifact_required: false,
  });
});

test("classifyRequestTelemetry separates action and recovery prompts from answerable proof-slice prompts", () => {
  const actionCases = [
    {
      id: "eeb6e616-dc86-4739-ae7b-829efbb4d82b",
      text: "那你那些不是因为等域名的能做的先做了",
    },
    {
      id: "b8d87083-923c-413a-bfb2-a081a8d7011e",
      text: "那你那些不是因为等域名的能做的先做了",
    },
    {
      id: "c9b34c32-cab2-4450-b941-cc6d9dc0d431",
      text: [
        "<codex_internal_context source=\"goal\">",
        "Restore Louis' Codex session access so every non-corrupt thread row in /Users/louis/.codex/state_5.sqlite is accounted for:",
        "produce a verified inventory of all threads, identify which are visible in Codex desktop list/search versus only readable by exact ID, repair/reindex or create desktop links.",
      ].join("\n"),
    },
    {
      id: "7125d69a-ce8d-49bb-8c96-89e4a0188f62",
      text: "sure do whatever u need to revive my codex and my projects",
    },
    {
      id: "93682c54-5bd8-4bb8-b19c-2c556ac55364",
      text: "sure do whatever u need to revive my codex and my projects",
    },
    {
      id: "7efc96bb-14f4-42b4-8919-a48eef01cc28",
      text: [
        "Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug`.",
        "rollout_context:",
        "- rollout_path: /Users/louis/.codex/sessions/2026/06/11/rollout-2026-06-11T06-43-01-019eb3b4-0c9e-7ca3-8212-138fd103baa8.jsonl",
        "rendered conversation (pre-rendered from rollout `.jsonl`; filtered response items):",
        "[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<command-message>c",
      ].join("\n"),
    },
  ];

  for (const item of actionCases) {
    assert.equal(
      classifyRequestTelemetry({ user_excerpt: item.text }).action_or_recovery_required,
      true,
      item.id,
    );
  }

  const answerableCases = [
    {
      id: "cbc2c457-2eb0-4cab-9b38-dd29691200ea",
      text: [
        "Another language model started to solve this problem and produced a summary of its thinking process.",
        "Use this to build on the work that has already been done and avoid duplicating work.",
        "Current task: BRING ALL MY CHAT SESSIONS BACK THEY ARE HIJACKED BY VSCODE.",
      ].join("\n"),
    },
    {
      id: "392671a5-f321-4549-bdef-aac00dc395cd",
      text: [
        "<codex_internal_context source=\"goal\">",
        "Continue working toward the active thread goal.",
        "<objective>",
        "BRING ALKL MY CHATS SESSIONS BACK THEY ARE HIJACKED BY VSCODE",
        "</objective>",
      ].join("\n"),
    },
    {
      id: "96c52da0-03d3-420a-bb05-33af9de55445",
      text: "Another language model started to solve this problem and produced a summary of its thinking process. Current task: BRING ALL MY CHAT SESSIONS BACK THEY ARE HIJACKED BY VSCODE.",
    },
    {
      id: "d02a90be-b689-4a37-b7a2-bb81c543fa6a",
      text: [
        "Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug`.",
        "rollout_context:",
        "- rollout_path: /Users/louis/.codex/sessions/2026/06/08/rollout-2026-06-08T02-19-57-019ea350-1e6f-7310-9ae6-1b1f7b586570.jsonl",
        "rendered conversation (pre-rendered from rollout `.jsonl`; filtered response items):",
        "[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\"",
      ].join("\n"),
    },
    {
      id: "advisory",
      text: "Explain the tradeoffs of smaller model routing for routine support replies.",
    },
  ];

  for (const item of answerableCases) {
    assert.equal(
      classifyRequestTelemetry({ user_excerpt: item.text }).action_or_recovery_required,
      false,
      item.id,
    );
  }
});

test("classifyRequestTelemetry marks local artifact and local workflow prompts as proof-ineligible", () => {
  const localArtifactCases = [
    {
      id: "rollout-local-path",
      text: [
        "Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug`.",
        "rollout_context:",
        "- rollout_path: /Users/louis/.codex/sessions/2026/06/08/rollout-2026-06-08T02-19-57.jsonl",
      ].join("\n"),
    },
    {
      id: "clipboard-image",
      text: [
        "# Files mentioned by the user:",
        "## codex-clipboard-d39fb5ee.png: /var/folders/wh/fzc2d45j0djc0841k8xhwqrm0000gn/T/codex-clipboard-d39fb5ee.png",
        "<image name=[Image #1] path=\"/var/folders/wh/fzc2d45j0djc0841k8xhwqrm0000gn/T/codex-clipboard-d39fb5ee.png\">",
      ].join("\n"),
    },
    {
      id: "tmp-file",
      text: "Read /tmp/peto-local-artifact.json and summarize the failure.",
    },
    {
      id: "deployment-workflow",
      text: "继续帮我部署我的小程序",
    },
    {
      id: "session-index",
      text: "# Files mentioned by the user:\n\n## session_index.jsonl: /Users/louis/.codex/session_index.jsonl\n\ncan u bring back all my sessions n the attached",
    },
    {
      id: "local-db-reindex",
      text: "Restore every non-corrupt thread row in /Users/louis/.codex/state_5.sqlite and repair/reindex the desktop list.",
    },
    {
      id: "ui-work",
      text: "okay 现在，请开始优化工作界面",
    },
  ];

  for (const item of localArtifactCases) {
    assert.equal(
      classifyRequestTelemetry({ user_excerpt: item.text }).local_artifact_required,
      true,
      item.id,
    );
  }

  const answerOnlyCases = [
    "Explain deployment strategies for a small beta product.",
    "Analyze this rollout_summary jsonl and extract durable memory.",
    "Summarize a routine planning tradeoff.",
  ];

  for (const text of answerOnlyCases) {
    assert.equal(classifyRequestTelemetry({ user_excerpt: text }).local_artifact_required, false, text);
  }
});

test("normalizeRouteEvent backfills request telemetry from excerpts", () => {
  const normalized = normalizeRouteEvent({
    id: "route-suggestions",
    schema_version: "1.0",
    phase: "request",
    chosen_effort: "medium",
    profile_segment: "default",
    risk_tier: "low",
    language: "en",
    request_class: "unknown",
    user_excerpt: "Generate 0 to 3 hyperpersonalized suggestions of what this user can do with Codex, deeply viewing their connected apps.",
  });

  assert.equal(normalized.request_class, "codex_suggestions");
  assert.equal(normalized.connected_app_required, true);
  assert.equal(normalized.memory_lookup_needed, false);
  assert.equal(normalized.tool_execution_required, false);
  assert.equal(normalized.workspace_action_required, false);
  assert.equal(normalized.action_or_recovery_required, false);
  assert.equal(normalized.local_artifact_required, false);
  assert.deepEqual(normalized.verification_missing_fields, []);
});

test("classifyOptimizationSegment separates replay-sensitive prompt shapes from effort-sensitive traffic", () => {
  assert.equal(
    classifyOptimizationSegment({ request_class: "coding_help", workspace_action_required: true, tool_execution_required: true }),
    "workspace_action_required",
  );
  assert.equal(
    classifyOptimizationSegment({ request_class: "coding_help", workspace_action_required: false, tool_execution_required: true }),
    "tool_execution_required",
  );
  assert.equal(
    classifyOptimizationSegment({ request_class: "other", action_or_recovery_required: true }),
    "action_or_recovery_required",
  );
  assert.equal(
    classifyOptimizationSegment({ request_class: "other", local_artifact_required: true }),
    "local_artifact_required",
  );
  assert.equal(
    classifyOptimizationSegment({ request_class: "codex_suggestions", connected_app_required: true }),
    "capability_sensitive",
  );
  assert.equal(
    classifyOptimizationSegment({ request_class: "codex_suggestions", connected_app_required: false }),
    "effort_sensitive",
  );
  assert.equal(classifyOptimizationSegment({ request_class: "coding_help" }), "effort_sensitive");
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

test("evalLogs emits effort-sensitive and capability-sensitive outcome segments", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  writeJson(configPath, { memoryPath: root, logPath, feedbackPath, localRouterUrl: "http://127.0.0.1:9/route" });

  appendJsonl(logPath, {
    id: "capability-route",
    phase: "request",
    chosen_effort: "medium",
    request_class: "codex_suggestions",
    connected_app_required: true,
    router_usage: { total_tokens: 4 },
  });
  appendJsonl(logPath, { id: "capability-route", phase: "response", status: "ok", executor_usage: { total_tokens: 50 } });
  appendJsonl(logPath, {
    id: "effort-route",
    phase: "request",
    chosen_effort: "low",
    request_class: "coding_help",
    connected_app_required: false,
    router_usage: { total_tokens: 3 },
  });
  appendJsonl(logPath, { id: "effort-route", phase: "response", status: "ok", executor_usage: { total_tokens: 40 } });
  appendJsonl(feedbackPath, {
    id: "capability-route",
    route_id: "capability-route",
    acceptance_label: "underfit",
    signal: "quality_judge",
  });
  appendJsonl(feedbackPath, {
    id: "effort-route",
    route_id: "effort-route",
    acceptance_label: "accepted",
    signal: "quality_judge",
  });

  const data = evalLogs({ config: configPath });

  assert.equal(data.optimization_segments.capability_sensitive.count, 1);
  assert.equal(data.optimization_segments.capability_sensitive.underfit, 1);
  assert.equal(data.optimization_segments.capability_sensitive.underfit_rate, "100.0%");
  assert.equal(data.optimization_segments.effort_sensitive.count, 1);
  assert.equal(data.optimization_segments.effort_sensitive.accepted, 1);
  assert.equal(data.optimization_segments.effort_sensitive.underfit_rate, "0.0%");
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
  assert.equal(typeof run.metrics.optimization_segments.effort_sensitive, "object");
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
  const reportText = fs.readFileSync(reported.report_path, "utf8");
  assert.match(reportText, /PETO Verification Report/);
  assert.match(reportText, /Optimization segments/);
  assert.match(reportText, /effort_sensitive/);
  assert.match(reportText, /capability_sensitive/);
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

test("verification run backfills request class and prompt-shape telemetry into samples", () => {
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
    id: "peto-verify-classification",
    seed: 5,
    sample_size: 1,
  });
  appendJsonl(logPath, {
    id: "route-classify",
    route_id: "route-classify",
    schema_version: "1.0",
    phase: "request",
    chosen_effort: "medium",
    router_usage: { total_tokens: 8 },
    profile_segment: "default",
    language: "en",
    risk_tier: "low",
    request_class: "unknown",
    user_excerpt: "Generate 0 to 3 hyperpersonalized suggestions of what this user can do with Codex, deeply viewing their connected apps.",
  });
  appendJsonl(logPath, {
    id: "route-classify",
    route_id: "route-classify",
    schema_version: "1.0",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 80 },
    latency_ms: 100,
  });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  const run = runVerification({ config: configPath, id: created.run_id });
  const samples = readJsonl(path.join(created.run_dir, "samples.jsonl")).rows;

  assert.deepEqual(run.missing_verification_fields, []);
  assert.equal(samples[0].request_class, "codex_suggestions");
  assert.equal(samples[0].connected_app_required, true);
  assert.equal(samples[0].memory_lookup_needed, false);
  assert.equal(samples[0].optimization_segment, "capability_sensitive");
});

test("verification run and report segment the current sample with existing quality labels", () => {
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
    id: "peto-verify-quality-segments",
    seed: 3,
    sample_size: 2,
  });
  appendJsonl(logPath, {
    id: "capability-route",
    route_id: "capability-route",
    schema_version: "1.0",
    phase: "request",
    chosen_effort: "medium",
    router_usage: { total_tokens: 4 },
    profile_segment: "default",
    language: "en",
    risk_tier: "low",
    request_class: "unknown",
    user_excerpt: "Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex by deeply viewing connected apps.",
  });
  appendJsonl(logPath, {
    id: "capability-route",
    route_id: "capability-route",
    schema_version: "1.0",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 60 },
  });
  appendJsonl(logPath, {
    id: "effort-route",
    route_id: "effort-route",
    schema_version: "1.0",
    phase: "request",
    chosen_effort: "low",
    router_usage: { total_tokens: 3 },
    profile_segment: "default",
    language: "en",
    risk_tier: "low",
    request_class: "other",
    user_excerpt: "Explain why concise planning replies can still be useful.",
  });
  appendJsonl(logPath, {
    id: "effort-route",
    route_id: "effort-route",
    schema_version: "1.0",
    phase: "response",
    status: "ok",
    executor_usage: { total_tokens: 40 },
  });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  fs.writeFileSync(path.join(created.run_dir, "quality-labels.jsonl"), [
    JSON.stringify({ route_id: "capability-route", acceptance_label: "underfit", signal: "quality_judge" }),
    JSON.stringify({ route_id: "effort-route", acceptance_label: "accepted", signal: "quality_judge" }),
    "",
  ].join("\n"));

  const run = runVerification({ config: configPath, id: created.run_id });
  const report = reportVerificationRun({ config: configPath, id: created.run_id });
  const reportText = fs.readFileSync(report.report_path, "utf8");
  const samples = readJsonl(path.join(created.run_dir, "samples.jsonl")).rows;

  assert.equal(run.metrics.verification.optimization_segments.capability_sensitive.count, 1);
  assert.equal(run.metrics.verification.optimization_segments.capability_sensitive.underfit, 1);
  assert.equal(run.metrics.verification.optimization_segments.capability_sensitive.underfit_rate, "100.0%");
  assert.equal(run.metrics.verification.optimization_segments.effort_sensitive.accepted, 1);
  assert.equal(samples.find(row => row.route_id === "capability-route").acceptance_label, "underfit");
  assert.match(reportText, /capability_sensitive: count 1, underfit 100.0%/);
  assert.match(reportText, /effort_sensitive: count 1, underfit 0.0%/);
});

test("verification representative sample filters effort-sensitive traffic without failure bias", () => {
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
    id: "peto-verify-effort-representative",
    seed: 2,
    sample_size: 2,
    segment_filter: "effort_sensitive",
    sample_mode: "representative",
  });
  appendVerificationPair(logPath, "effort-underfit", {
    chosen_effort: "low",
    request_class: "other",
    user_excerpt: "Explain the tradeoffs of smaller model routing for routine support replies.",
  });
  appendVerificationPair(logPath, "effort-accepted-a", {
    chosen_effort: "medium",
    request_class: "other",
    user_excerpt: "Summarize the benefits of a deterministic router for simple writing tasks.",
  });
  appendVerificationPair(logPath, "effort-accepted-b", {
    chosen_effort: "medium",
    request_class: "other",
    user_excerpt: "Compare concise and detailed answers for a general planning question.",
  });
  appendVerificationPair(logPath, "action-recovery", {
    chosen_effort: "medium",
    request_class: "other",
    user_excerpt: "sure do whatever u need to revive my codex and my projects",
  });
  appendVerificationPair(logPath, "local-artifact", {
    chosen_effort: "medium",
    request_class: "other",
    user_excerpt: "# Files mentioned by the user:\n\n## session_index.jsonl: /Users/louis/.codex/session_index.jsonl\n\ncan u bring back all my sessions n the attached",
  });
  appendVerificationPair(logPath, "capability-underfit", {
    chosen_effort: "medium",
    request_class: "codex_suggestions",
    connected_app_required: true,
    user_excerpt: "Generate 0 to 3 hyperpersonalized suggestions by viewing connected apps.",
  });
  appendVerificationPair(logPath, "workspace-action", {
    chosen_effort: "medium",
    request_class: "coding_help",
    user_excerpt: "Fix the parser bug in this repo and run npm test.",
  });
  appendVerificationPair(logPath, "tool-action", {
    chosen_effort: "medium",
    request_class: "coding_help",
    user_excerpt: "Run git status and summarize the workspace changes.",
  });
  appendJsonl(feedbackPath, { route_id: "effort-underfit", acceptance_label: "underfit", signal: "quality_judge" });
  appendJsonl(feedbackPath, { route_id: "capability-underfit", acceptance_label: "underfit", signal: "quality_judge" });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  const run = runVerification({ config: configPath, id: created.run_id });
  const report = reportVerificationRun({ config: configPath, id: created.run_id });
  const samples = readJsonl(path.join(created.run_dir, "samples.jsonl")).rows;
  const reportText = fs.readFileSync(report.report_path, "utf8");

  assert.equal(run.metrics.verification.segment_filter, "effort_sensitive");
  assert.equal(run.metrics.verification.sample_mode, "representative");
  assert.equal(run.metrics.verification.sample_grade, "claim-grade");
  assert.equal(samples.length, 2);
  assert.equal(samples.every(row => row.optimization_segment === "effort_sensitive"), true);
  assert.equal(samples.every(row => row.tool_execution_required === false), true);
  assert.equal(samples.every(row => row.workspace_action_required === false), true);
  assert.equal(samples.every(row => row.action_or_recovery_required === false), true);
  assert.equal(samples.every(row => row.local_artifact_required === false), true);
  assert.equal(samples.some(row => row.route_id === "action-recovery"), false);
  assert.equal(samples.some(row => row.route_id === "local-artifact"), false);
  assert.equal(samples.some(row => row.route_id === "capability-underfit"), false);
  assert.equal(samples.some(row => row.route_id === "workspace-action"), false);
  assert.equal(samples.some(row => row.route_id === "tool-action"), false);
  assert.deepEqual(samples.map(row => row.route_id), ["effort-accepted-b", "effort-accepted-a"]);
  assert.equal(run.metrics.optimization_segments.workspace_action_required.count, 1);
  assert.equal(run.metrics.optimization_segments.tool_execution_required.count, 1);
  assert.equal(run.metrics.optimization_segments.action_or_recovery_required.count, 1);
  assert.equal(run.metrics.optimization_segments.local_artifact_required.count, 1);
  assert.match(reportText, /Segment filter: effort_sensitive/);
  assert.match(reportText, /Sample mode: representative/);
  assert.match(reportText, /Sample grade: claim-grade/);
  assert.match(reportText, /workspace_action_required: count 0/);
  assert.match(reportText, /tool_execution_required: count 0/);
  assert.match(reportText, /action_or_recovery_required: count 0/);
  assert.match(reportText, /local_artifact_required: count 0/);
});

test("verification stress sample preserves failure-biased sampling", () => {
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
    id: "peto-verify-effort-stress",
    seed: 1,
    sample_size: 1,
    segment_filter: "effort_sensitive",
    sample_mode: "stress",
  });
  appendVerificationPair(logPath, "effort-underfit", {
    chosen_effort: "low",
    request_class: "other",
    user_excerpt: "Explain why concise replies can still be high quality.",
  });
  appendVerificationPair(logPath, "effort-accepted", {
    chosen_effort: "medium",
    request_class: "other",
    user_excerpt: "Summarize a routine planning tradeoff.",
  });
  appendJsonl(feedbackPath, { route_id: "effort-underfit", acceptance_label: "underfit", signal: "quality_judge" });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  const run = runVerification({ config: configPath, id: created.run_id });
  const report = reportVerificationRun({ config: configPath, id: created.run_id });
  const samples = readJsonl(path.join(created.run_dir, "samples.jsonl")).rows;
  const reportText = fs.readFileSync(report.report_path, "utf8");

  assert.equal(run.metrics.verification.segment_filter, "effort_sensitive");
  assert.equal(run.metrics.verification.sample_mode, "stress");
  assert.equal(run.metrics.verification.sample_grade, "stress-grade");
  assert.deepEqual(samples.map(row => row.route_id), ["effort-underfit"]);
  assert.match(reportText, /Sample mode: stress/);
  assert.match(reportText, /Sample grade: stress-grade/);
});

test("verification run ignores stale execution results when the sample plan changes", () => {
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
    id: "peto-verify-stale-execution",
    seed: 1,
    sample_size: 1,
    segment_filter: "effort_sensitive",
    sample_mode: "representative",
    baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
  });
  appendVerificationPair(logPath, "current-effort-route", {
    chosen_effort: "medium",
    request_class: "other",
    user_excerpt: "Explain a routine planning tradeoff.",
  });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  writeJsonlRowsForTest(path.join(created.run_dir, "execution-results.jsonl"), [
    {
      route_id: "stale-route",
      source: "candidate",
      effort: "medium",
      model: "mock-executor",
      upstream_url: "http://127.0.0.1:1/v1/responses",
      status_code: 200,
      attempts: 1,
      executor_usage: { total_tokens: 40 },
      response_text: "stale",
      latency_ms: 1,
      error_type: null,
      error: null,
    },
    {
      route_id: "stale-route",
      source: "baseline_fixed_xhigh",
      effort: "xhigh",
      model: "mock-executor",
      upstream_url: "http://127.0.0.1:1/v1/responses",
      status_code: 200,
      attempts: 1,
      executor_usage: { total_tokens: 100 },
      response_text: null,
      latency_ms: 1,
      error_type: null,
      error: null,
    },
  ]);
  writeJsonlRowsForTest(path.join(created.run_dir, "quality-labels.jsonl"), [
    { route_id: "stale-route", acceptance_label: "accepted", signal: "quality_judge" },
  ]);

  const run = runVerification({ config: configPath, id: created.run_id });
  const gated = gateVerificationRun({ config: configPath, id: created.run_id });

  assert.equal(run.metrics.execution, undefined);
  assert.equal(run.metrics.verification.exact_savings_available, false);
  assert.equal(gated.verdict.evidence_status, "incomplete");
  assert.deepEqual(gated.verdict.evidence_missing, ["execution_missing", "judge_missing"]);
  assert.equal(gated.verdict.claim_status, "not_proven");
});

test("verification metrics compute savings only from matched-success execution pairs", () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  writeJson(configPath, {
    memoryPath: root,
    logPath,
    feedbackPath,
    upstreamBaseUrl: "http://127.0.0.1:1",
    upstreamHeaders: { Authorization: "Bearer test-token" },
    defaultTargetModel: "mock-executor",
    enableQualityJudge: false,
    allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
  });
  writeJson(ticketPath, {
    id: "peto-verify-pairing-savings",
    seed: 1,
    sample_size: 2,
    baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
  });
  for (const id of ["route-paired-a", "route-candidate-only-b"]) {
    appendJsonl(logPath, {
      id,
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "other",
      language: "en",
      risk_tier: "low",
      user_excerpt: `Explain ${id}.`,
    });
    appendJsonl(logPath, { id, phase: "response", status: "ok", executor_usage: { total_tokens: 40 } });
  }

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  runVerification({ config: configPath, id: created.run_id });
  const sampleRows = readJsonl(path.join(created.run_dir, "samples.jsonl")).rows;
  const executionRows = sampleRows.flatMap(sample => {
    if (sample.route_id === "route-paired-a") {
      return [
        executionRowForTest({ routeId: sample.route_id, source: "candidate", effort: "medium", tokens: 40, responseText: "ok" }),
        executionRowForTest({ routeId: sample.route_id, source: "baseline_fixed_xhigh", effort: "xhigh", tokens: 100 }),
      ];
    }
    return [
      executionRowForTest({ routeId: sample.route_id, source: "candidate", effort: "medium", tokens: 40, responseText: "ok" }),
      executionRowForTest({
        routeId: sample.route_id,
        source: "baseline_fixed_xhigh",
        effort: "xhigh",
        statusCode: null,
        errorType: "timeout_retry_exhausted",
        error: "Upstream request timed out after 20ms and retry was exhausted.",
      }),
    ];
  });
  writeJsonlRowsForTest(path.join(created.run_dir, "execution-results.jsonl"), executionRows);

  const run = runVerification({ config: configPath, id: created.run_id });
  const gated = gateVerificationRun({ config: configPath, id: created.run_id });
  const report = reportVerificationRun({ config: configPath, id: created.run_id });
  const reportText = fs.readFileSync(report.report_path, "utf8");

  assert.equal(run.metrics.execution.total_planned_pairs, 2);
  assert.equal(run.metrics.execution.matched_success_pairs, 1);
  assert.equal(run.metrics.execution.candidate_only_rows, 1);
  assert.equal(run.metrics.execution.baseline_only_rows, 0);
  assert.equal(run.metrics.execution.missing_usage_rows, 0);
  assert.equal(run.metrics.execution.execution_pairing, "contaminated");
  assert.equal(run.metrics.execution.actual_candidate_tokens, 40);
  assert.equal(run.metrics.execution.actual_baseline_tokens, 100);
  assert.equal(run.metrics.savings.estimated_tokens_saved, 60);
  assert.equal(gated.verdict.evidence_status, "partial");
  assert.equal(gated.verdict.claim_status, "not_proven");
  assert.equal(gated.verdict.execution_pairing, "contaminated");
  assert.match(reportText, /Execution pairing: 1 matched-success pairs \/ 2 total planned/);
  assert.match(reportText, /Execution pairing status: contaminated/);
  assert.match(reportText, /Savings basis: matched-success pairs only \(1\/2\)/);
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

test("verification execute resumes only missing arms and skips already matched-success pairs", async () => {
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
      res.end(JSON.stringify({ output_text: "resumed baseline", usage: { total_tokens: 120 } }));
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
      enableQualityJudge: false,
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-resume-missing-arms",
      seed: 1,
      sample_size: 2,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    for (const id of ["route-resume-complete", "route-resume-baseline-missing"]) {
      appendJsonl(logPath, {
        id,
        phase: "request",
        chosen_effort: "medium",
        profile_segment: "default",
        request_class: "other",
        language: "en",
        risk_tier: "low",
        user_excerpt: `Explain ${id}.`,
      });
      appendJsonl(logPath, { id, phase: "response", status: "ok", executor_usage: { total_tokens: 40 } });
    }

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const sampleRows = readJsonl(path.join(created.run_dir, "samples.jsonl")).rows;
    const rows = [];
    for (const sample of sampleRows) {
      if (sample.route_id === "route-resume-complete") {
        rows.push(executionRowForTest({ routeId: sample.route_id, source: "candidate", effort: "medium", tokens: 40, responseText: "ok" }));
        rows.push(executionRowForTest({ routeId: sample.route_id, source: "baseline_fixed_xhigh", effort: "xhigh", tokens: 100 }));
      } else {
        rows.push(executionRowForTest({ routeId: sample.route_id, source: "candidate", effort: "medium", tokens: 45, responseText: "ok" }));
      }
    }
    writeJsonlRowsForTest(path.join(created.run_dir, "execution-results.jsonl"), rows);

    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const finalRows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
    const metrics = JSON.parse(fs.readFileSync(path.join(created.run_dir, "metrics.json"), "utf8"));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning.effort, "xhigh");
    assert.equal(result.resumed_execution_rows.length, 1);
    assert.deepEqual(result.resumed_execution_rows[0], {
      route_id: "route-resume-baseline-missing",
      source: "baseline_fixed_xhigh",
      effort: "xhigh",
    });
    assert.equal(finalRows.length, 4);
    assert.equal(metrics.execution.matched_success_pairs, 2);
    assert.equal(metrics.execution.actual_candidate_tokens, 85);
    assert.equal(metrics.execution.actual_baseline_tokens, 220);
  } finally {
    await closeServer(server);
  }
});

test("verification execute respects configured concurrency limit", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((req, res) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    req.resume();
    setTimeout(() => {
      active -= 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: "ok", usage: { total_tokens: 20 } }));
    }, 60);
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
      enableQualityJudge: false,
      verifyExecuteConcurrency: 2,
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-concurrency",
      seed: 1,
      sample_size: 4,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    for (let index = 0; index < 4; index += 1) {
      const id = `route-concurrency-${index}`;
      appendJsonl(logPath, {
        id,
        phase: "request",
        chosen_effort: "medium",
        profile_segment: "default",
        request_class: "other",
        language: "en",
        risk_tier: "low",
        user_excerpt: `Explain ${id}.`,
      });
      appendJsonl(logPath, { id, phase: "response", status: "ok", executor_usage: { total_tokens: 20 } });
    }

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    await executeVerificationRun({ config: configPath, id: created.run_id });

    assert.equal(maxActive, 2);
  } finally {
    await closeServer(server);
  }
});

test("verification execute extracts response text from object-valued response content", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      if (parsed.model === "mock-judge") {
        res.end(JSON.stringify({ output_text: JSON.stringify({ label: "accepted", reason: "ok" }) }));
        return;
      }
      const effort = parsed.reasoning?.effort;
      if (effort === "xhigh") {
        res.end(JSON.stringify({ output_text: "baseline response", usage: { total_tokens: 100 } }));
        return;
      }
      res.end(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: { value: "nested candidate answer" } },
                { type: "refusal", refusal: "" },
              ],
            },
          ],
          usage: { total_tokens: 40 },
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
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-response-text-object-content",
      seed: 3,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-object-content",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "other",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain a routine planning tradeoff.",
    });
    appendJsonl(logPath, { id: "route-object-content", phase: "response", status: "ok", executor_usage: { total_tokens: 40 } });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
    const labels = readJsonl(path.join(created.run_dir, "quality-labels.jsonl")).rows;

    assert.equal(rows.find(row => row.source === "candidate").response_text, "nested candidate answer");
    assert.equal(labels[0].acceptance_label, "accepted");
    assert.equal(labels[0].judge_error, null);
  } finally {
    await closeServer(server);
  }
});

test("verification execute persists completed rows incrementally if a later call is interrupted", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { total_tokens: 40 } }));
      return;
    }
    // Keep the second request open so the test can interrupt execution mid-run.
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
      verifyExecuteTimeoutMs: 100,
      verifyExecuteRetryBaseMs: 1,
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-incremental",
      seed: 3,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-incremental",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain incremental persistence.",
    });
    appendJsonl(logPath, { id: "route-incremental", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const execution = executeVerificationRun({ config: configPath, id: created.run_id });
    await new Promise(resolve => setTimeout(resolve, 80));
    const resultsPath = path.join(created.run_dir, "execution-results.jsonl");
    assert.equal(fs.existsSync(resultsPath), true);
    let rows = readJsonl(resultsPath).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "candidate");
    assert.equal(rows[0].executor_usage.total_tokens, 40);
    await execution;
    rows = readJsonl(resultsPath).rows;

    assert.equal(rows.length, 2);
    assert.equal(rows[1].source, "baseline_fixed_xhigh");
    assert.equal(rows[1].error_type, "timeout_retry_exhausted");
  } finally {
    if (server.listening) await closeServer(server);
  }
});

test("verification execute retries transient 5xx upstream errors before recording failure", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    calls += 1;
    if (calls === 1) {
      res.writeHead(502, { "content-type": "application/json" });
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
      id: "peto-verify-execute-5xx-retry",
      seed: 4,
      sample_size: 1,
      baselines: [],
    });
    appendJsonl(logPath, {
      id: "route-5xx-retry",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain retry.",
    });
    appendJsonl(logPath, { id: "route-5xx-retry", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
    const candidateRow = rows.find(row => row.source === "candidate");

    assert.equal(calls, 3);
    assert.equal(result.errors, 0);
    assert.equal(candidateRow.attempts, 2);
    assert.equal(candidateRow.executor_usage.total_tokens, 10);
  } finally {
    await closeServer(server);
  }
});

test("verification execute retries Cloudflare 520 upstream errors before recording failure", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    calls += 1;
    if (calls === 1) {
      res.writeHead(520, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "cloudflare_unknown" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { total_tokens: 12 } }));
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
      id: "peto-verify-execute-520-retry",
      seed: 4,
      sample_size: 1,
      baselines: [],
    });
    appendJsonl(logPath, {
      id: "route-520-retry",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain retry.",
    });
    appendJsonl(logPath, { id: "route-520-retry", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;
    const candidateRow = rows.find(row => row.source === "candidate");

    assert.equal(calls, 3);
    assert.equal(result.errors, 0);
    assert.equal(candidateRow.attempts, 2);
    assert.equal(candidateRow.executor_usage.total_tokens, 12);
  } finally {
    await closeServer(server);
  }
});

test("verification execute enforces 50 sample limit and records persistent upstream errors", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "persistent" }));
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
      verifyExecuteRetryBaseMs: 1,
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
    assert.equal(rows.filter(row => row.error).length, 100);
    assert.deepEqual(result.errors_by_type, { "500": 100 });
    assert.equal(rows.filter(row => row.executor_usage).length, 0);
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

test("verification gate fails min_net_savings_ratio when exact savings are zero", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const effort = parsed.reasoning?.effort;
      const usage = effort === "xhigh"
        ? { total_tokens: 40 }
        : { total_tokens: 100 };
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
      id: "peto-verify-execute-zero-savings",
      seed: 11,
      sample_size: 1,
      gates: { min_net_savings_ratio: 0.1 },
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-zero-savings",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain zero savings.",
    });
    appendJsonl(logPath, { id: "route-zero-savings", phase: "response", status: "ok", executor_usage: { total_tokens: 100 } });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    await executeVerificationRun({ config: configPath, id: created.run_id });
    const gated = gateVerificationRun({ config: configPath, id: created.run_id });
    const savingsGate = gated.gates.find(gate => gate.name === "min_net_savings_ratio");

    assert.equal(savingsGate.observed, 0);
    assert.equal(savingsGate.pass, false);
    assert.equal(gated.verdict.verdict, "hold");
  } finally {
    await closeServer(server);
  }
});

test("verification gate and report mark missing execution and judge evidence as not proven", () => {
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
    id: "peto-verify-evidence-aware",
    seed: 8,
    sample_size: 2,
    gates: { min_net_savings_ratio: 0.1 },
    baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
  });

  appendVerificationPair(logPath, "route-evidence-a", {
    chosen_effort: "minimal",
    user_excerpt: "Summarize this short note.",
  });
  appendVerificationPair(logPath, "route-evidence-b", {
    chosen_effort: "low",
    user_excerpt: "Draft a tiny changelog.",
  });

  const created = createVerificationRun({ config: configPath, ticket: ticketPath });
  runVerification({ config: configPath, id: created.run_id });
  const gated = gateVerificationRun({ config: configPath, id: created.run_id });
  const reported = reportVerificationRun({ config: configPath, id: created.run_id });
  const reportText = fs.readFileSync(reported.report_path, "utf8");

  assert.equal(gated.verdict.verdict, "hold");
  assert.equal(gated.verdict.evidence_status, "incomplete");
  assert.equal(gated.verdict.sample_status, "ready");
  assert.equal(gated.verdict.claim_status, "not_proven");
  assert.deepEqual(gated.verdict.evidence_missing, ["execution_missing", "judge_missing"]);
  assert.equal(
    gated.verdict.evidence_reason,
    "execution preflight failed; no exact execution or judge labels available",
  );
  const evidenceGate = gated.gates.find(gate => gate.name === "evidence_complete");
  assert.equal(evidenceGate.pass, false);
  assert.equal(evidenceGate.observed, "incomplete");
  assert.deepEqual(evidenceGate.missing, ["execution_missing", "judge_missing"]);
  assert.match(reportText, /Evidence status: incomplete/);
  assert.match(reportText, /Sample status: ready/);
  assert.match(reportText, /Claim status: not_proven/);
  assert.match(reportText, /Reason: execution preflight failed; no exact execution or judge labels available/);
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

test("verification execute retries one timeout before recording success", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const callsByEffort = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const effort = parsed.reasoning?.effort;
      callsByEffort[effort] = (callsByEffort[effort] || 0) + 1;
      if (callsByEffort[effort] === 1) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ usage: { total_tokens: 999 } }));
        }, 100);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: "retry ok", usage: { total_tokens: effort === "xhigh" ? 100 : 40 } }));
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
      enableQualityJudge: false,
      verifyExecuteTimeoutMs: 20,
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-timeout-retry",
      seed: 10,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-timeout-retry",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "other",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain timeout retry.",
    });
    appendJsonl(logPath, { id: "route-timeout-retry", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const rows = readJsonl(path.join(created.run_dir, "execution-results.jsonl")).rows;

    assert.equal(result.errors, 0);
    assert.deepEqual(callsByEffort, { medium: 2, xhigh: 2 });
    assert.ok(rows.every(row => row.attempts === 2));
    assert.ok(rows.every(row => row.error_type === null));
  } finally {
    await closeServer(server);
  }
});

test("verification execute records timeout_retry_exhausted after one retry", async () => {
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
    assert.deepEqual(result.errors_by_type, { timeout_retry_exhausted: 2 });
    assert.ok(rows.every(row => row.error_type === "timeout_retry_exhausted"));
    assert.ok(rows.every(row => row.attempts === 2));
    assert.match(result.distinct_errors[0], /retry was exhausted/i);
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

test("judgeRoute accepts fenced JSON verdicts from slightly drifting judge output", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        output_text: '```json\n{"label":"accepted","reason":"The response satisfied the request."}\n```',
        usage: { total_tokens: 8 },
      }),
    );
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

    assert.equal(result.label, "accepted");
    assert.equal(result.reason, "The response satisfied the request.");
    assert.deepEqual(result.usage, { total_tokens: 8 });
    assert.equal(result.error, null);
  } finally {
    await closeServer(server);
  }
});

test("judgeRoute falls back to defaultTargetModel when judgeModel is not configured", async () => {
  let requestedModel = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      requestedModel = JSON.parse(body).model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: JSON.stringify({ label: "accepted", reason: "ok" }) }));
    });
  });
  const port = await listen(server);
  try {
    const result = await judgeRoute({
      userExcerpt: "Summarize this.",
      responseText: "Summary.",
      chosenEffort: "low",
      config: {
        upstreamBaseUrl: `http://127.0.0.1:${port}`,
        defaultTargetModel: "mock-executor",
      },
    });

    assert.equal(requestedModel, "mock-executor");
    assert.equal(result.label, "accepted");
    assert.equal(result.error, null);
  } finally {
    await closeServer(server);
  }
});

test("judgeRoute returns ambiguous when the judge request exceeds configured timeout", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: JSON.stringify({ label: "accepted", reason: "late" }) }));
    }, 100);
  });
  const port = await listen(server);
  try {
    const started = Date.now();
    const result = await judgeRoute({
      userExcerpt: "Summarize this.",
      responseText: "Summary.",
      chosenEffort: "low",
      config: {
        upstreamBaseUrl: `http://127.0.0.1:${port}`,
        judgeModel: "mock-judge",
        judgeTimeoutMs: 20,
      },
    });

    assert.equal(result.label, "ambiguous");
    assert.equal(result.reason, null);
    assert.equal(result.usage, null);
    assert.match(result.error, /timed out/i);
    assert.ok(Date.now() - started < 90);
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
        "judge_error",
        "judge_model",
        "judge_usage",
        "reason",
        "route_id",
        "signal",
      ]);
      assert.equal(row.signal, "quality_judge");
      assert.equal(row.judge_model, "mock-judge");
    }
    const ambiguousRow = labelRows.find(row => row.acceptance_label === "ambiguous");
    assert.match(ambiguousRow.judge_error, /unparseable JSON/);
    assert.equal(evaluated.outcomes.accepted_estimate, 1);
    assert.ok(manifest.annotations.includes("quality_judge_complete"));
  } finally {
    await closeServer(server);
  }
});

test("verification execute records fallback judge model in quality labels", async () => {
  const root = makeTempDir();
  const logPath = path.join(root, "router-events.jsonl");
  const feedbackPath = path.join(root, "feedback-signals.jsonl");
  const configPath = path.join(root, "peto.config.json");
  const ticketPath = path.join(root, "ticket.json");
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        output_text: JSON.stringify({ label: "accepted", reason: "ok" }),
        usage: { total_tokens: 20 },
      }),
    );
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
      id: "peto-verify-quality-fallback-judge-model",
      seed: 6,
      sample_size: 1,
      baselines: [],
    });
    appendJsonl(logPath, {
      id: "route-quality-fallback-model",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain fallback model.",
    });
    appendJsonl(logPath, { id: "route-quality-fallback-model", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const labelRows = readJsonl(result.quality_labels_path).rows;

    assert.equal(labelRows[0].judge_model, "mock-executor");
  } finally {
    await closeServer(server);
  }
});

test("verification execute persists quality labels incrementally if a later judge call is interrupted", async () => {
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
      res.writeHead(200, { "content-type": "application/json" });
      if (parsed.model === "mock-judge") {
        judgeCalls += 1;
        if (judgeCalls === 1) {
          res.end(JSON.stringify({ output_text: JSON.stringify({ label: "accepted", reason: "ok" }) }));
          return;
        }
        setTimeout(() => {
          res.end(JSON.stringify({ output_text: JSON.stringify({ label: "underfit", reason: "slow" }) }));
        }, 500);
        return;
      }
      res.end(JSON.stringify({ output_text: `executor response for ${parsed.input}`, usage: { total_tokens: 20 } }));
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
      verifyExecuteTimeoutMs: 1000,
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-quality-incremental",
      seed: 6,
      sample_size: 2,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    for (const id of ["route-quality-incremental-a", "route-quality-incremental-b"]) {
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
    const execution = executeVerificationRun({ config: configPath, id: created.run_id });
    await new Promise(resolve => setTimeout(resolve, 120));
    const labelsPath = path.join(created.run_dir, "quality-labels.jsonl");
    assert.equal(fs.existsSync(labelsPath), true);
    const labels = readJsonl(labelsPath).rows;
    assert.equal(labels.length, 1);
    assert.equal(labels[0].acceptance_label, "accepted");
    const result = await execution;
    assert.equal(result.quality_labels_path, labelsPath);
    assert.equal(readJsonl(labelsPath).rows.length, 2);
  } finally {
    if (server.listening) await closeServer(server);
  }
});

test("verification execute reuses complete execution results to fill missing quality labels", async () => {
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
        res.end(JSON.stringify({ output_text: JSON.stringify({ label: "accepted", reason: "ok" }) }));
        return;
      }
      res.end(JSON.stringify({ output_text: "executor should not be called", usage: { total_tokens: 999 } }));
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
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-execute-reuse-results",
      seed: 6,
      sample_size: 1,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    appendJsonl(logPath, {
      id: "route-reuse-results",
      phase: "request",
      chosen_effort: "medium",
      profile_segment: "default",
      request_class: "coding",
      language: "en",
      risk_tier: "low",
      user_excerpt: "Explain reuse results.",
    });
    appendJsonl(logPath, { id: "route-reuse-results", phase: "response", status: "ok" });

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    writeJsonlRowsForTest(path.join(created.run_dir, "execution-results.jsonl"), [
      {
        route_id: "route-reuse-results",
        source: "candidate",
        effort: "medium",
        model: "mock-executor",
        upstream_url: `http://127.0.0.1:${port}/v1/responses`,
        status_code: 200,
        attempts: 1,
        executor_usage: { total_tokens: 40 },
        response_text: "executor response",
        latency_ms: 1,
        error_type: null,
        error: null,
      },
      {
        route_id: "route-reuse-results",
        source: "baseline_fixed_xhigh",
        effort: "xhigh",
        model: "mock-executor",
        upstream_url: `http://127.0.0.1:${port}/v1/responses`,
        status_code: 200,
        attempts: 1,
        executor_usage: { total_tokens: 100 },
        response_text: null,
        latency_ms: 1,
        error_type: null,
        error: null,
      },
    ]);

    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const models = requests.map(request => request.model);

    assert.equal(result.executed, 2);
    assert.deepEqual(models, ["mock-judge"]);
    assert.equal(result.quality_labels_path, path.join(created.run_dir, "quality-labels.jsonl"));
    assert.equal(readJsonl(result.quality_labels_path).rows.length, 1);
  } finally {
    await closeServer(server);
  }
});

test("verification execute labels unjudgeable candidate rows as ambiguous evidence", async () => {
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
      const isExecutor = parsed.model === "mock-executor";
      if (isExecutor && parsed.input.includes("route-timeout-candidate")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "still failed" }));
        return;
      }
      if (isExecutor && parsed.input.includes("route-empty-candidate")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ usage: { total_tokens: 40 } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: JSON.stringify({ label: "accepted", reason: "ok" }) }));
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
      allowedEfforts: DEFAULT_CONFIG.allowedEfforts,
    });
    writeJson(ticketPath, {
      id: "peto-verify-unjudgeable-candidates",
      seed: 6,
      sample_size: 2,
      baselines: [{ name: "fixed_xhigh", type: "fixed_effort", effort: "xhigh" }],
    });
    for (const id of ["route-timeout-candidate", "route-empty-candidate"]) {
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
      appendJsonl(feedbackPath, { route_id: id, acceptance_label: "accepted", signal: "historic_feedback" });
    }

    const created = createVerificationRun({ config: configPath, ticket: ticketPath });
    runVerification({ config: configPath, id: created.run_id });
    writeJsonlRowsForTest(path.join(created.run_dir, "execution-results.jsonl"), [
      {
        route_id: "route-timeout-candidate",
        source: "candidate",
        effort: "medium",
        model: "mock-executor",
        upstream_url: `http://127.0.0.1:${port}/v1/responses`,
        status_code: null,
        attempts: 1,
        executor_usage: null,
        response_text: null,
        latency_ms: 1000,
        error_type: "timeout",
        error: "Upstream request timed out after 1000ms.",
      },
      {
        route_id: "route-timeout-candidate",
        source: "baseline_fixed_xhigh",
        effort: "xhigh",
        model: "mock-executor",
        upstream_url: `http://127.0.0.1:${port}/v1/responses`,
        status_code: 200,
        attempts: 1,
        executor_usage: { total_tokens: 100 },
        response_text: null,
        latency_ms: 1,
        error_type: null,
        error: null,
      },
      {
        route_id: "route-empty-candidate",
        source: "candidate",
        effort: "medium",
        model: "mock-executor",
        upstream_url: `http://127.0.0.1:${port}/v1/responses`,
        status_code: 200,
        attempts: 1,
        executor_usage: { total_tokens: 40 },
        response_text: null,
        latency_ms: 1,
        error_type: null,
        error: null,
      },
      {
        route_id: "route-empty-candidate",
        source: "baseline_fixed_xhigh",
        effort: "xhigh",
        model: "mock-executor",
        upstream_url: `http://127.0.0.1:${port}/v1/responses`,
        status_code: 200,
        attempts: 1,
        executor_usage: { total_tokens: 100 },
        response_text: null,
        latency_ms: 1,
        error_type: null,
        error: null,
      },
    ]);

    const result = await executeVerificationRun({ config: configPath, id: created.run_id });
    const labelRows = readJsonl(result.quality_labels_path).rows;
    const metrics = JSON.parse(fs.readFileSync(path.join(created.run_dir, "metrics.json"), "utf8"));
    const report = reportVerificationRun({ config: configPath, id: created.run_id });
    const reportText = fs.readFileSync(report.report_path, "utf8");

    assert.equal(requests.filter(request => request.model === "mock-judge").length, 0);
    assert.equal(requests.filter(request => request.model === "mock-executor").length, 3);
    assert.equal(labelRows.length, 2);
    assert.deepEqual(labelRows.map(row => row.acceptance_label), ["ambiguous", "ambiguous"]);
    assert.match(labelRows[0].judge_error, /execution_error: 500/);
    assert.match(labelRows[1].judge_error, /missing response text/);
    assert.equal(metrics.verification.optimization_segments.effort_sensitive.ambiguous, 2);
    assert.equal(metrics.verification.optimization_segments.effort_sensitive.accepted, 0);
    assert.deepEqual(metrics.verification.quality_labels, {
      total: 2,
      accepted: 0,
      underfit: 0,
      rejected: 0,
      ambiguous: 2,
      ambiguous_reasons: {
        "execution_error: 500": 1,
        "missing response text": 1,
      },
    });
    assert.match(reportText, /Quality labels: accepted 0, underfit 0, rejected 0, ambiguous 2/);
    assert.match(reportText, /Ambiguous reasons:/);
    assert.match(reportText, /execution_error: 500: 1/);
    assert.match(reportText, /missing response text: 1/);
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
