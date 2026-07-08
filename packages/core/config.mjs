import fs from "node:fs";
import path from "node:path";

import { readJson } from "./jsonl.mjs";

// `max` sits above `xhigh` for providers (e.g. Claude) whose reasoning scale
// extends past OpenAI's ceiling. `xhigh` remains the savings baseline.
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_CONFIG = {
  memoryPath: "./memory",
  logPath: "./memory/dispatcher/logs/router-events.jsonl",
  feedbackPath: "./memory/dispatcher/logs/feedback-signals.jsonl",
  serverLogPath: "./memory/dispatcher/logs/router-server.jsonl",
  localRouterUrl: "http://127.0.0.1:8788/route",
  allowedEfforts: EFFORTS,
};

export function resolveConfigPath(args = {}) {
  return path.resolve(
    args.config ||
      process.env.PETO_CONFIG ||
      (fs.existsSync("peto.config.json") ? "peto.config.json" : "packages/gateway/peto.config.example.json"),
  );
}

export function loadConfig(args = {}) {
  const configPath = resolveConfigPath(args);
  const config = { ...DEFAULT_CONFIG, ...readJson(configPath, {}) };
  const memoryPath = path.resolve(config.memoryPath || DEFAULT_CONFIG.memoryPath);
  return {
    ...config,
    configPath,
    memoryPath,
    logPath: path.resolve(args.log || config.logPath || path.join(memoryPath, "dispatcher/logs/router-events.jsonl")),
    feedbackPath: path.resolve(
      args.feedback || config.feedbackPath || path.join(memoryPath, "dispatcher/logs/feedback-signals.jsonl"),
    ),
    serverLogPath: path.resolve(config.serverLogPath || path.join(memoryPath, "dispatcher/logs/router-server.jsonl")),
    verificationPath: path.resolve(config.verificationPath || path.join(memoryPath, "verification")),
    allowedEfforts: Array.isArray(config.allowedEfforts) ? config.allowedEfforts : EFFORTS,
  };
}
