#!/usr/bin/env node
import { DEFAULT_CONFIG, loadConfig } from "../core/config.mjs";
import { evalLogs, groupRoutes } from "../core/eval.mjs";
import { writeFeedback } from "../core/feedback.mjs";
import { hashText } from "../core/hash.mjs";
import { appendJsonl, readJsonl } from "../core/jsonl.mjs";
import {
  createVerificationRun,
  executeVerificationRun,
  gateVerificationRun,
  reportVerificationRun,
  runVerification,
} from "../core/verify.mjs";

function usage() {
  return `PETO CLI

Usage:
  peto doctor [--config FILE] [--json]
  peto route "user request" [--config FILE] [--json] [--no-log]
  peto feedback --route-id ID --label accepted|underfit|overfit|rejected|ambiguous|invalid [--notes TEXT]
  peto eval [--config FILE] [--log FILE] [--feedback FILE] [--json]
  peto replay [--config FILE] [--log FILE] [--limit N] [--json]
  peto verify create --ticket FILE [--config FILE] [--json]
  peto verify run --id RUN_ID [--config FILE] [--json]
  peto verify execute --id RUN_ID [--config FILE] [--dry-run] [--json]
  peto verify gate --id RUN_ID [--config FILE] [--json]
  peto verify report --id RUN_ID [--config FILE] [--json]

Commands:
  doctor    Check config, memory paths, logs, and local router health.
  route     Ask the configured local dispatcher for an effort route.
  feedback  Record an explicit route acceptance label.
  eval      Summarize PETO routing effectiveness from JSONL logs.
  replay    Print recent route decisions for inspection.
  verify    Run deterministic offline PETO verification artifacts.
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { _: [], command };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (["json", "no-log", "help", "dry-run"].includes(key)) {
      args[key] = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function print(data, json) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  console.log(formatHuman(data));
}

function formatHuman(data) {
  if (data.kind === "doctor") {
    return [
      `PETO doctor: ${data.ok ? "ok" : "needs attention"}`,
      `config: ${data.configPath}`,
      `memory: ${data.memoryPath} (${data.memoryExists ? "exists" : "missing"})`,
      `router log: ${data.logPath} (${data.routerLogEvents} events, ${data.routerLogInvalid} invalid)`,
      `feedback log: ${data.feedbackPath} (${data.feedbackEvents} events, ${data.feedbackInvalid} invalid)`,
      `local router: ${data.localRouter.ok ? "ok" : data.localRouter.error}`,
    ].join("\n");
  }
  if (data.kind === "route") {
    return [
      `effort: ${data.route.target_effort}`,
      `confidence: ${data.route.confidence ?? "unknown"}`,
      `priority: ${data.route.recording_priority ?? "normal"}`,
      `needs_review: ${Boolean(data.route.needs_review)}`,
      `rationale: ${data.route.rationale_short || "none"}`,
      `source: ${data.route.source || "local_http"}`,
      `logged: ${data.logged}`,
    ].join("\n");
  }
  if (data.kind === "feedback") {
    return `feedback logged: ${data.route_id} -> ${data.acceptance_label}`;
  }
  if (data.kind === "eval") {
    return [
      `PETO eval: ${data.summary}`,
      `routes: ${data.routes.total}`,
      `route JSON validity: ${data.routes.validity_percent}%`,
      `acceptance rate: ${data.outcomes.acceptance_rate}`,
      `rejection rate: ${data.outcomes.rejection_rate}`,
      `retry/escalation rate: ${data.outcomes.retry_escalation_rate}`,
      `overfit rate: ${data.outcomes.overfit_rate}`,
      `underfit rate: ${data.outcomes.underfit_rate}`,
      `estimated xhigh savings: ${data.savings.label}`,
      `dispatcher overhead: ${data.dispatcher_overhead.label}`,
      `cost per accepted outcome: ${formatMaybeNumber(data.cost_per_accepted_outcome.tokens)}`,
      `latency median: ${data.latency.median_ms ?? "unknown"} ms`,
      `weakest evidence: ${data.weakest_evidence}`,
      `next test: ${data.next_test}`,
    ].join("\n");
  }
  if (data.kind === "replay") {
    return data.items
      .map(item => {
        const status = item.response?.status || "pending";
        return `${item.timestamp} ${item.route_id} ${item.chosen_effort} ${status} ${item.user_excerpt}`;
      })
      .join("\n") || "No route events found.";
  }
  if (data.kind === "verify_create") return `verify run created: ${data.run_id}\n${data.run_dir}`;
  if (data.kind === "verify_run") return `verify run complete: ${data.run_id}\nsamples: ${data.samples.count}`;
  if (data.kind === "verify_execute") {
    if (data.dry_run) {
      return [
        `verify execution plan: ${data.run_id}`,
        `samples: ${data.samples_considered}`,
        `planned calls: ${data.planned}`,
        ...(data.plan || []).map(item => `${item.route_id} ${item.source} ${item.effort}`),
      ].join("\n");
    }
    return [
      `verify execute complete: ${data.run_id}`,
      `planned calls: ${data.planned}`,
      `executed rows: ${data.executed}`,
      `errors: ${data.errors}`,
      data.results_path,
    ].join("\n");
  }
  if (data.kind === "verify_gate") return `verify verdict: ${data.verdict.verdict}`;
  if (data.kind === "verify_report") return `verify report: ${data.report_path}`;
  return JSON.stringify(data, null, 2);
}

async function checkLocalRouter(config) {
  const url = new URL(config.localRouterUrl || DEFAULT_CONFIG.localRouterUrl);
  url.pathname = "/health";
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    return { ok: response.ok, status: response.status, body: parseMaybeJson(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function doctor(args) {
  const fs = await import("node:fs");
  const config = loadConfig(args);
  const routerLog = readJsonl(config.logPath);
  const feedback = readJsonl(config.feedbackPath);
  const localRouter = await checkLocalRouter(config);
  const result = {
    kind: "doctor",
    ok: fs.existsSync(config.configPath) && fs.existsSync(config.memoryPath) && routerLog.invalid === 0,
    configPath: config.configPath,
    memoryPath: config.memoryPath,
    memoryExists: fs.existsSync(config.memoryPath),
    logPath: config.logPath,
    routerLogEvents: routerLog.rows.length,
    routerLogInvalid: routerLog.invalid,
    feedbackPath: config.feedbackPath,
    feedbackEvents: feedback.rows.length,
    feedbackInvalid: feedback.invalid,
    serverLogPath: config.serverLogPath,
    localRouter,
  };
  print(result, args.json);
}

async function route(args) {
  const crypto = await import("node:crypto");
  const config = loadConfig(args);
  const userText = args._.join(" ").trim();
  if (!userText) throw new Error("route requires a user request string.");

  const started = Date.now();
  const response = await fetch(config.localRouterUrl || DEFAULT_CONFIG.localRouterUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      user_text: userText,
      notes: [],
      allowed_efforts: config.allowedEfforts,
      max_user_text_chars: config.maxRouterUserTextChars || 3000,
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Local router failed with ${response.status}: ${raw.slice(0, 500)}`);
  const routeResult = JSON.parse(raw);
  const effort = String(routeResult.target_effort || "").toLowerCase();
  if (!config.allowedEfforts.includes(effort)) throw new Error(`Router returned disallowed effort: ${effort}`);

  const id = crypto.randomUUID();
  const common = {
    id,
    route_id: id,
    schema_version: "1.0",
    annotations: [],
  };
  const event = {
    ...common,
    phase: "request",
    route_source: "cli",
    route_source_detail: routeResult.source || "local_http",
    router_backend: "local_http",
    input_hash: hashText(userText),
    user_excerpt: userText.slice(0, 500),
    incoming_model: null,
    incoming_effort: null,
    chosen_model: config.defaultTargetModel || null,
    chosen_effort: effort,
    router_model: config.routerModel || null,
    router_effort: config.routerEffort || "local",
    router_confidence: routeResult.confidence ?? null,
    router_rationale: routeResult.rationale_short ?? null,
    router_usage: routeResult.usage ?? null,
    executor_usage: null,
    usage: routeResult.usage ?? null,
    profile_segment: args["profile-segment"] || "default",
    risk_tier: args["risk-tier"] || "unknown",
    language: args.language || "unknown",
    request_class: args["request-class"] || "unknown",
    acceptance_label: null,
    retrieved_notes: [],
    feedback_signal: false,
  };
  const responseEvent = {
    ...common,
    phase: "response",
    status: "ok",
    status_code: response.status,
    latency_ms: Date.now() - started,
    router_usage: null,
    executor_usage: null,
    usage: null,
    acceptance_label: null,
    error: null,
  };

  if (!args["no-log"]) {
    appendJsonl(config.logPath, event);
    appendJsonl(config.logPath, responseEvent);
  }

  print(
    {
      kind: "route",
      id,
      route: { ...routeResult, target_effort: effort },
      latency_ms: responseEvent.latency_ms,
      logged: !args["no-log"],
    },
    args.json,
  );
}

function feedback(args) {
  const config = loadConfig(args);
  const event = writeFeedback({
    feedbackPath: config.feedbackPath,
    routeId: args["route-id"] || args.id,
    label: args.label,
    notes: args.notes || null,
  });
  print({ kind: "feedback", ...event }, args.json);
}

function replay(args) {
  const config = loadConfig(args);
  const routerLog = readJsonl(config.logPath);
  const limit = Number(args.limit || 20);
  const routes = groupRoutes(routerLog.rows)
    .slice(-limit)
    .map(pair => ({
      timestamp: pair.request.timestamp,
      route_id: pair.request.route_id,
      chosen_effort: pair.request.chosen_effort,
      router_confidence: pair.request.router_confidence,
      route_source: pair.request.route_source,
      user_excerpt: pair.request.user_excerpt,
      response: pair.response
        ? {
            status: pair.response.status,
            latency_ms: pair.response.latency_ms,
            executor_usage: pair.response.executor_usage,
            usage: pair.response.usage,
            error: pair.response.error,
          }
        : null,
    }));
  print({ kind: "replay", items: routes }, args.json);
}

async function verify(args) {
  const subcommand = args._.shift();
  if (subcommand === "create") return print(createVerificationRun(args), args.json);
  if (subcommand === "run") return print(runVerification(args), args.json);
  if (subcommand === "execute") return print(await executeVerificationRun(args), args.json);
  if (subcommand === "gate") return print(gateVerificationRun(args), args.json);
  if (subcommand === "report") return print(reportVerificationRun(args), args.json);
  throw new Error("verify requires create, run, execute, gate, or report.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.help || args.command === "help") {
    print(usage(), false);
    return;
  }
  if (args.command === "doctor") return doctor(args);
  if (args.command === "route") return route(args);
  if (args.command === "feedback") return feedback(args);
  if (args.command === "eval") return print(evalLogs(args), args.json);
  if (args.command === "replay") return replay(args);
  if (args.command === "verify") return verify(args);
  throw new Error(`Unknown command: ${args.command}`);
}

function formatMaybeNumber(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "baseline pending";
}

main().catch(error => {
  console.error(`peto: ${error.message}`);
  process.exit(1);
});
