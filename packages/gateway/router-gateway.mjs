#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import crypto from "node:crypto";

import { classifyRequestTelemetry } from "../core/telemetry.mjs";
import { parseSseUsage } from "../core/sse.mjs";
import { applyEffortToBody, detectProvider, readIncomingEffort } from "../core/effort.mjs";

const defaultConfigPath = path.resolve("peto.config.json");
const configPath = process.env.PETO_CONFIG
  ? path.resolve(process.env.PETO_CONFIG)
  : defaultConfigPath;

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}. Set PETO_CONFIG or create peto.config.json.`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

const config = loadConfig();
const memoryPath = path.resolve(config.memoryPath || "./memory");

function nowIso() {
  return new Date().toISOString();
}

function appendJsonl(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: nowIso(), ...data })}\n`);
}

function logServer(message, extra = {}) {
  appendJsonl(config.serverLogPath || path.join(memoryPath, "logs/server.jsonl"), { message, ...extra });
}

function hashText(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex").slice(0, 16);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = config.requestBodyLimitBytes || 25_000_000;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`Request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function responseJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function normalizeTextPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.input_text === "string") return part.input_text;
  if (typeof part.output_text === "string") return part.output_text;
  return "";
}

function extractTextFromMessage(message) {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const content = message.content ?? message.input ?? message.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(normalizeTextPart).filter(Boolean).join("\n");
  return normalizeTextPart(content);
}

function extractLatestUserText(body) {
  const input = body?.input ?? body?.messages;
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    const role = item.role ?? item.type;
    if (role === "user" || role === "message") {
      const text = extractTextFromMessage(item).trim();
      if (text) return text;
    }
  }

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const text = extractTextFromMessage(input[index]).trim();
    if (text) return text;
  }

  return "";
}

function words(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter(word => word.length >= 2)
    .slice(0, 120);
}

function listMarkdownFiles(dir) {
  const output = [];
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...listMarkdownFiles(full));
    if (entry.isFile() && entry.name.endsWith(".md")) output.push(full);
  }
  return output;
}

function retrieveMemoryNotes(userText) {
  if (config.enableSimpleMemoryRetrieval === false) return [];

  const terms = new Set(words(userText));
  if (terms.size === 0) return [];

  const roots = config.memorySearchRoots || [
    "dispatcher/lessons",
    "dispatcher/policy",
    "user/preferences",
    "user/mistake-patterns",
  ];

  const scored = [];
  for (const file of roots.map(root => path.join(memoryPath, root)).flatMap(listMarkdownFiles)) {
    const text = fs.readFileSync(file, "utf8");
    const lower = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score += 1;
    }
    if (score > 0) {
      scored.push({
        file: path.relative(memoryPath, file),
        score,
        excerpt: text.replace(/\s+/g, " ").slice(0, config.maxRouterNoteChars || 240),
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxRetrievedNotes || 2);
}

function stripHopByHopHeaders(headers) {
  const next = {};
  const blocked = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase()) && value !== undefined) next[key] = value;
  }
  return next;
}

function upstreamUrl(reqUrl) {
  const upstream = new URL(config.upstreamBaseUrl);
  const incoming = new URL(reqUrl, "http://localhost");
  const cleanBase = upstream.pathname.replace(/\/+$/, "");
  const cleanIncoming = incoming.pathname.startsWith("/") ? incoming.pathname : `/${incoming.pathname}`;
  upstream.pathname = `${cleanBase}${cleanIncoming}`;
  upstream.search = incoming.search;
  return upstream;
}

function buildRouterPrompt(userText, notes) {
  return [
    "Effort router. Do not answer or rewrite the user request.",
    "Pick the cheapest effort likely to satisfy the user. Use high/xhigh only when avoided rework justifies it.",
    "V1 is effort-only: do not switch executor models, call an arbiter, or add hidden requirements.",
    'Return only JSON: {"target_effort":"minimal|low|medium|high|xhigh","confidence":0.0,"rationale_short":"short reason","recording_priority":"skip|normal|watch|lesson_candidate","needs_review":false}',
    "Notes:",
    notes.length ? JSON.stringify(notes, null, 2) : "[]",
    "User:",
    userText.slice(0, config.maxRouterUserTextChars || 3000),
  ].join("\n");
}

function parseRouterJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Router returned no JSON object");
  return JSON.parse(match[0]);
}

function extractResponseText(responseBody) {
  if (typeof responseBody?.output_text === "string") return responseBody.output_text;
  const output = responseBody?.output;
  if (!Array.isArray(output)) return "";
  const parts = [];
  for (const item of output) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = part?.text ?? part?.output_text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

async function callHostedRouter({ headers, userText, notes }) {
  const body = {
    model: config.routerModel,
    input: buildRouterPrompt(userText, notes),
    reasoning: { effort: config.routerEffort || "low" },
    max_output_tokens: config.routerMaxOutputTokens || 220,
  };

  const url = new URL("/v1/responses", config.upstreamBaseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...stripHopByHopHeaders(headers),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Router call failed with ${response.status}: ${raw.slice(0, 500)}`);
  }

  const parsed = JSON.parse(raw);
  const text = extractResponseText(parsed);
  const route = parseRouterJson(text);
  const effort = String(route.target_effort || "").toLowerCase();
  if (!(config.allowedEfforts || ["minimal", "low", "medium", "high", "xhigh"]).includes(effort)) {
    throw new Error(`Router chose disallowed effort: ${route.target_effort}`);
  }

  return {
    route: {
      target_effort: effort,
      confidence: Number(route.confidence ?? 0),
      rationale_short: String(route.rationale_short || "No rationale returned.").slice(0, 240),
      recording_priority: String(route.recording_priority || "normal"),
      needs_review: Boolean(route.needs_review),
    },
    usage: parsed.usage ?? null,
    sourceDetail: "openai_responses",
  };
}

async function callLocalRouter({ userText, notes }) {
  const url = config.localRouterUrl || "http://127.0.0.1:8788/route";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.localRouterTimeoutMs || 8000);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    signal: controller.signal,
    body: JSON.stringify({
      user_text: userText,
      notes,
      allowed_efforts: config.allowedEfforts || ["minimal", "low", "medium", "high", "xhigh"],
      max_user_text_chars: config.maxRouterUserTextChars || 3000,
    }),
  }).finally(() => clearTimeout(timeout));

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Local router call failed with ${response.status}: ${raw.slice(0, 500)}`);
  }

  const route = JSON.parse(raw);
  const effort = String(route.target_effort || "").toLowerCase();
  if (!(config.allowedEfforts || ["minimal", "low", "medium", "high", "xhigh"]).includes(effort)) {
    throw new Error(`Local router chose disallowed effort: ${route.target_effort}`);
  }

  return {
    route: {
      target_effort: effort,
      confidence: Number(route.confidence ?? 0),
      rationale_short: String(route.rationale_short || "No rationale returned.").slice(0, 240),
      recording_priority: String(route.recording_priority || "normal"),
      needs_review: Boolean(route.needs_review),
      source: String(route.source || "local_http"),
    },
    usage: route.usage ?? null,
    sourceDetail: String(route.source || "local_http"),
  };
}

async function callRouter({ headers, userText, notes }) {
  if ((config.routerBackend || "openai_responses") === "local_http") {
    return callLocalRouter({ userText, notes });
  }
  return callHostedRouter({ headers, userText, notes });
}

function applyRoute(body, route, provider) {
  const withModel = structuredClone(body);
  const incomingModel = typeof withModel.model === "string" ? withModel.model : config.defaultTargetModel;
  withModel.model = config.mode === "effort_only" ? incomingModel : config.defaultTargetModel;
  // Translate the chosen effort tier into the detected provider's native field
  // (OpenAI reasoning.effort / Anthropic thinking.budget_tokens / Gemini
  // thinkingConfig.thinkingBudget).
  const effort = route.target_effort || config.defaultEffort || "medium";
  return applyEffortToBody(withModel, effort, provider, config);
}

function detectDispleasure(text) {
  const lowered = text.toLowerCase();
  const aimedAtAssistant = [
    /\byour (answer|output|response|reply|work)\b/i,
    /\byou (missed|failed|got|made|did|are)\b/i,
    /\bthis (answer|output|response|reply|is|was)\b/i,
    /\bthat (answer|output|response|reply|is|was)\b/i,
    /\bnot what i (want|asked|asked for)\b/i,
    /\btry again\b/i,
    /\bredo\b/i,
    /你/,
    /回答/,
    /输出/,
    /重来/,
  ];
  const isLikelyQuoted = /```|^>|"[^"]*(shit|sucks|trash|rubbish|reject|redo)[^"]*"/ims.test(text);
  if (isLikelyQuoted && !aimedAtAssistant.some(pattern => pattern.test(text))) return false;
  const patterns = [
    /\bshit\b/i,
    /\bsucks?\b/i,
    /\btrash\b/i,
    /\bthrash\b/i,
    /\brubbish\b/i,
    /\breject\b/i,
    /\bredo\b/i,
    /not\s+right/i,
    /not\s+what\s+i\s+(want|asked|asked for)/i,
    /没理解/,
    /不对/,
    /重来/,
    /垃圾/,
    /烂/,
    /不满意/,
  ];
  return patterns.some(pattern => pattern.test(lowered)) && aimedAtAssistant.some(pattern => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Effort footer — appended to every response so the UI shows routing metadata.
// Disable with "enableEffortFooter": false in peto.config.json.
// ---------------------------------------------------------------------------

function estimateSavings(chosen, incoming) {
  const levels = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
  const chosenLevel = levels[chosen] ?? 2;
  const incomingLevel = levels[incoming] ?? 4;
  if (chosenLevel >= incomingLevel) return "none (pass-through)";
  const map = { 0: "~75%", 1: "~60%", 2: "~40%", 3: "~20%", 4: "~5%" };
  return map[chosenLevel] ?? "baseline pending";
}

function buildEffortFooter(route, incomingEffort) {
  if (config.enableEffortFooter === false) return null;
  const chosen = route.target_effort || "unknown";
  const confidence = route.confidence ?? 0;
  const fit = confidence >= 0.7 ? "appropriate" : confidence >= 0.5 ? "uncertain" : "low confidence";
  const savings = estimateSavings(chosen, incomingEffort || "xhigh");
  const review = route.needs_review
    ? "flagged for review"
    : confidence >= 0.7
    ? "appropriate, no lesson."
    : "uncertain routing — monitor.";
  return [
    `Effort: ${chosen}`,
    `Effort fit: ${fit}`,
    `Estimated xhigh savings: ${savings}`,
    `Effort review: ${review}`,
  ].join("\n");
}

function injectFooterIntoJsonResponse(body, footer) {
  const next = structuredClone(body);
  const output = next?.output;
  if (!Array.isArray(output)) return next;
  for (let i = output.length - 1; i >= 0; i -= 1) {
    const content = output[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const part = content[j];
      if (part?.type === "output_text" && typeof part.text === "string") {
        part.text = `${part.text}\n\n${footer}`;
        return next;
      }
    }
  }
  return next;
}

function logRouteStart({ id, userText, incomingBody, route, routeSource, routeSourceDetail, routeUsage, notes, provider, incomingEffort }) {
  const logPath = config.logPath || path.join(memoryPath, "dispatcher/logs/router-events.jsonl");
  const requestTelemetry = classifyRequestTelemetry({
    request_class: config.defaultRequestClass,
    user_excerpt: userText,
  });
  appendJsonl(logPath, {
    id,
    route_id: id,
    schema_version: "1.0",
    phase: "request",
    route_source: routeSource,
    route_source_detail: routeSourceDetail ?? route.source ?? null,
    router_backend: config.routerBackend || "openai_responses",
    input_hash: hashText(userText),
    user_excerpt: userText.slice(0, 500),
    incoming_model: incomingBody.model ?? null,
    incoming_effort: incomingEffort ?? incomingBody.reasoning?.effort ?? null,
    upstream_provider: provider ?? null,
    chosen_model: incomingBody.model ?? config.defaultTargetModel,
    chosen_effort: route.target_effort,
    router_model: config.routerModel,
    router_effort: config.routerEffort || "low",
    router_confidence: route.confidence ?? null,
    router_rationale: route.rationale_short ?? null,
    router_usage: routeUsage,
    executor_usage: null,
    usage: routeUsage,
    profile_segment: config.defaultProfileSegment || "default",
    risk_tier: config.defaultRiskTier || "unknown",
    language: config.defaultLanguage || "unknown",
    request_class: requestTelemetry.request_class,
    connected_app_required: requestTelemetry.connected_app_required,
    memory_lookup_needed: requestTelemetry.memory_lookup_needed,
    acceptance_label: null,
    annotations: [],
    retrieved_notes: notes.map(note => note.file),
    feedback_signal: detectDispleasure(userText),
  });

  if (detectDispleasure(userText)) {
    appendJsonl(config.feedbackPath || path.join(memoryPath, "dispatcher/logs/feedback-signals.jsonl"), {
      id,
      input_hash: hashText(userText),
      user_excerpt: userText.slice(0, 500),
      signal: "explicit_displeasure",
    });
  }
}

function logRouteComplete({ id, status, statusCode, latencyMs, usage, error }) {
  appendJsonl(config.logPath || path.join(memoryPath, "dispatcher/logs/router-events.jsonl"), {
    id,
    route_id: id,
    schema_version: "1.0",
    phase: "response",
    status,
    status_code: statusCode ?? null,
    latency_ms: latencyMs,
    router_usage: null,
    executor_usage: usage ?? null,
    usage: usage ?? null,
    acceptance_label: null,
    annotations: [],
    error: error ? String(error).slice(0, 800) : null,
  });
}

async function forwardToUpstream(req, res, body, { footer } = {}) {
  const started = Date.now();
  const url = upstreamUrl(req.url);
  const upstreamHeaders = {
    ...stripHopByHopHeaders(req.headers),
    "content-type": "application/json",
  };

  const response = await fetch(url, {
    method: req.method,
    headers: upstreamHeaders,
    body: JSON.stringify(body),
  });

  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  });
  res.writeHead(response.status, responseHeaders);

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") && response.body) {
    let streamText = "";
    // Track the last item_id and sequence_number seen in the stream so we can
    // inject a footer delta event after the upstream stream finishes.
    let lastItemId = null;
    let lastSeqNum = 0;

    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      const chunkText = buffer.toString("utf8");
      streamText += chunkText;
      // Best-effort parse of each SSE data line to track stream metadata.
      for (const line of chunkText.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (typeof event.item_id === "string") lastItemId = event.item_id;
          if (typeof event.sequence_number === "number") lastSeqNum = event.sequence_number;
        } catch {
          // Ignore non-JSON or partial data lines.
        }
      }
      res.write(buffer);
    }

    // Append the effort footer as a final text delta before closing the stream.
    if (footer && lastItemId) {
      const deltaEvent = {
        type: "response.output_text.delta",
        sequence_number: lastSeqNum + 1,
        item_id: lastItemId,
        output_index: 0,
        content_index: 0,
        delta: `\n\n${footer}`,
      };
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
    }

    res.end();
    return {
      statusCode: response.status,
      latencyMs: Date.now() - started,
      usage: parseSseUsage(streamText),
    };
  }

  const raw = await response.text();
  let usage = null;
  try {
    const parsed = JSON.parse(raw);
    usage = parsed?.usage ?? null;
    // Inject footer into the response body text before sending.
    if (footer && parsed) {
      res.end(JSON.stringify(injectFooterIntoJsonResponse(parsed, footer)));
    } else {
      res.end(raw);
    }
  } catch {
    // Non-JSON response — forward as-is.
    res.end(raw);
  }
  return {
    statusCode: response.status,
    latencyMs: Date.now() - started,
    usage,
  };
}

async function handleResponses(req, res) {
  const id = crypto.randomUUID();
  let raw;
  let originalBody;
  try {
    raw = await readRequestBody(req);
    originalBody = JSON.parse(raw || "{}");
  } catch (error) {
    responseJson(res, 400, { error: { message: error.message } });
    return;
  }

  const userText = extractLatestUserText(originalBody);
  const notes = retrieveMemoryNotes(userText);
  let route;
  let routeUsage = null;
  let routeSource = "router";
  let routeSourceDetail = null;

  try {
    const routed = await callRouter({ headers: req.headers, userText, notes });
    route = routed.route;
    routeUsage = routed.usage;
    routeSourceDetail = routed.sourceDetail ?? routed.route?.source ?? null;
  } catch (error) {
    routeSource = "fallback";
    routeSourceDetail = "gateway_default";
    route = {
      target_effort: config.defaultEffort || "medium",
      confidence: 0,
      rationale_short: `Router unavailable; used default ${config.defaultEffort || "medium"}.`,
      recording_priority: "watch",
      needs_review: true,
    };
    logServer("router call failed", { id, error: error.message });
  }

  const provider = detectProvider(config, originalBody);
  const routedBody = applyRoute(originalBody, route, provider);
  const incomingEffort = readIncomingEffort(originalBody, provider);
  // Footer injection is built on the OpenAI SSE/JSON response shape. For other
  // providers it would risk corrupting the stream, so only build it for OpenAI.
  const footer = provider === "openai" ? buildEffortFooter(route, incomingEffort) : null;
  logRouteStart({ id, userText, incomingBody: originalBody, route, routeSource, routeSourceDetail, routeUsage, notes, provider, incomingEffort });

  try {
    const complete = await forwardToUpstream(req, res, routedBody, { footer });
    logRouteComplete({ id, status: "success", ...complete });
  } catch (error) {
    logRouteComplete({ id, status: "error", latencyMs: null, error: error.message });
    if (!res.headersSent) {
      responseJson(res, 502, { error: { message: error.message } });
    } else {
      res.end();
    }
  }
}

async function handleDryRun(req, res) {
  const raw = await readRequestBody(req);
  const body = JSON.parse(raw || "{}");
  const userText = extractLatestUserText(body);
  const notes = retrieveMemoryNotes(userText);
  const route = {
    target_effort: config.defaultEffort || "medium",
    confidence: 0,
    rationale_short: "Dry run does not call router.",
    recording_priority: "normal",
    needs_review: false,
  };
  responseJson(res, 200, {
    user_excerpt: userText.slice(0, 500),
    retrieved_notes: notes.map(note => note.file),
    would_apply: applyRoute(body, route),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      responseJson(res, 200, {
        ok: true,
        router_backend: config.routerBackend || "openai_responses",
        router_model: config.routerModel,
        router_effort: config.routerEffort || "low",
        local_router_url: config.localRouterUrl || null,
        default_effort: config.defaultEffort || "medium",
        upstream: config.upstreamBaseUrl,
      });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/dry-run")) {
      await handleDryRun(req, res);
      return;
    }

    if (req.method === "POST" && (req.url?.startsWith("/v1/responses") || req.url?.startsWith("/responses"))) {
      await handleResponses(req, res);
      return;
    }

    responseJson(res, 404, { error: { message: `Unsupported route: ${req.method} ${req.url}` } });
  } catch (error) {
    logServer("unhandled request error", { error: error.stack || error.message });
    if (!res.headersSent) responseJson(res, 500, { error: { message: error.message } });
  }
});

server.on("clientError", (error, socket) => {
  logServer("client error", { error: error.message });
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

server.listen(config.port || 8787, config.host || "127.0.0.1", () => {
  logServer("router gateway started", {
    port: config.port || 8787,
    router_backend: config.routerBackend || "openai_responses",
    router_model: config.routerModel,
    router_effort: config.routerEffort || "low",
    upstream: config.upstreamBaseUrl,
  });
  console.log(`PETO router gateway listening on http://${config.host || "127.0.0.1"}:${config.port || 8787}`);
});
