#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const defaultConfigPath = path.resolve("peto.config.json");
const configPath = process.env.PETO_CONFIG
  ? path.resolve(process.env.PETO_CONFIG)
  : defaultConfigPath;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const config = readJson(configPath, {});
const memoryPath = path.resolve(config.memoryPath || "./memory");
const routerLogPath = path.resolve(config.logPath || path.join(memoryPath, "dispatcher/logs/router-events.jsonl"));
const feedbackPath = path.resolve(config.feedbackPath || path.join(memoryPath, "dispatcher/logs/feedback-signals.jsonl"));
const lessonsPath = path.resolve(config.lessonsPath || path.join(memoryPath, "dispatcher/lessons"));

function nowIso() {
  return new Date().toISOString();
}

function appendJsonl(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: nowIso(), ...data })}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function latestRoute() {
  const events = readJsonl(routerLogPath);
  const requests = events.filter(event => event.phase === "request");
  const responses = events.filter(event => event.phase === "response");
  const request = requests.at(-1) || null;
  const response = request ? responses.findLast(event => event.id === request.id) || null : null;
  return { request, response };
}

function slugify(text) {
  return String(text || "lesson")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "lesson";
}

function estimateSavings(args = {}) {
  const actualTokens = Number(args.actual_tokens ?? args.actualTokens ?? 0);
  const xhighBaselineTokens = Number(args.xhigh_baseline_tokens ?? args.xhighBaselineTokens ?? 0);
  if (!actualTokens || !xhighBaselineTokens) {
    return {
      status: "baseline_pending",
      estimated_tokens_saved: null,
      estimated_percent_saved: null,
      note: "Provide actual_tokens and xhigh_baseline_tokens for an estimate.",
    };
  }
  const saved = Math.max(0, xhighBaselineTokens - actualTokens);
  return {
    status: "estimated",
    estimated_tokens_saved: saved,
    estimated_percent_saved: Number(((saved / xhighBaselineTokens) * 100).toFixed(1)),
  };
}

function writeLesson(args = {}) {
  const title = args.title || args.pattern || "PETO routing lesson";
  const file = path.join(lessonsPath, `${new Date().toISOString().slice(0, 10)}-${slugify(title)}.md`);
  const body = [
    "---",
    "type: dispatcher_lesson",
    `created: ${nowIso()}`,
    `trigger: ${args.trigger || "manual"}`,
    `original_effort: ${args.original_effort || args.originalEffort || "unknown"}`,
    `recommended_future_effort: ${args.recommended_future_effort || args.recommendedFutureEffort || "unknown"}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Pattern",
    "",
    args.pattern || "Describe the request pattern.",
    "",
    "## Outcome",
    "",
    args.outcome || "Describe the observed outcome.",
    "",
    "## Boundary",
    "",
    args.boundary || "Describe where this lesson should stop applying.",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { file };
}

const toolDefinitions = [
  {
    name: "peto_health",
    description: "Report PETO MCP config and log paths.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "peto_latest_route",
    description: "Return the latest PETO route request/response pair from the router log.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "peto_log_outcome",
    description: "Append a reviewer outcome signal for a PETO route.",
    inputSchema: {
      type: "object",
      properties: {
        route_id: { type: "string" },
        effort_fit: { type: "string", enum: ["appropriate", "overfit", "underfit", "unknown"] },
        visible_review: { type: "string" },
        lesson_logged: { type: "boolean" },
        notes: { type: "string" }
      },
      required: ["effort_fit"]
    },
  },
  {
    name: "peto_estimate_savings",
    description: "Estimate token savings against an xhigh baseline.",
    inputSchema: {
      type: "object",
      properties: {
        actual_tokens: { type: "number" },
        xhigh_baseline_tokens: { type: "number" }
      }
    },
  },
  {
    name: "peto_write_lesson",
    description: "Write a contextual PETO dispatcher lesson.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        trigger: { type: "string" },
        original_effort: { type: "string" },
        recommended_future_effort: { type: "string" },
        pattern: { type: "string" },
        outcome: { type: "string" },
        boundary: { type: "string" }
      },
      required: ["title", "pattern", "outcome", "boundary"]
    },
  },
];

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function handleToolCall(name, args = {}) {
  if (name === "peto_health") {
    return toolResult({
      ok: true,
      config_path: configPath,
      memory_path: memoryPath,
      router_log_path: routerLogPath,
      feedback_path: feedbackPath,
      lessons_path: lessonsPath,
      gateway_required_for_every_message_routing: true,
    });
  }
  if (name === "peto_latest_route") {
    return toolResult(latestRoute());
  }
  if (name === "peto_log_outcome") {
    const event = {
      route_id: args.route_id || null,
      effort_fit: args.effort_fit || "unknown",
      visible_review: args.visible_review || null,
      lesson_logged: Boolean(args.lesson_logged),
      notes: args.notes || null,
    };
    appendJsonl(feedbackPath, { signal: "reviewer_outcome", ...event });
    return toolResult({ logged: true, event });
  }
  if (name === "peto_estimate_savings") {
    return toolResult(estimateSavings(args));
  }
  if (name === "peto_write_lesson") {
    return toolResult(writeLesson(args));
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(id, result, error = null) {
  const message = error
    ? { jsonrpc: "2.0", id, error: { code: -32000, message: error.message } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  const { id, method, params = {} } = message;
  try {
    if (method === "initialize") {
      send(id, {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "peto-mcp", version: "0.1.0" },
      });
      return;
    }
    if (method === "tools/list") {
      send(id, { tools: toolDefinitions });
      return;
    }
    if (method === "tools/call") {
      const result = handleToolCall(params.name, params.arguments || {});
      send(id, result);
      return;
    }
    if (method === "notifications/initialized") return;
    send(id, null, new Error(`Unsupported method: ${method}`));
  } catch (error) {
    send(id, null, error);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line));
  } catch (error) {
    send(null, null, error);
  }
});

