import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatcherPath = path.join(repoRoot, "packages/dispatcher/local-qwen-dispatcher.py");
const allowedEfforts = ["minimal", "low", "medium", "high", "xhigh"];

function probeRoute(userText, incomingEffort = "medium") {
  const script = [
    "import importlib.util, json, pathlib, sys",
    "path = pathlib.Path(sys.argv[1])",
    "text = sys.argv[2]",
    "incoming = sys.argv[3]",
    "allowed = json.loads(sys.argv[4])",
    "spec = importlib.util.spec_from_file_location('local_qwen_dispatcher', path)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps({",
    "  'heuristic': module.heuristic_route(text, allowed),",
    "  'calibrated': module.calibrate_effort(incoming, text, allowed),",
    "}))",
  ].join("\n");

  return JSON.parse(
    execFileSync("python3", ["-c", script, dispatcherPath, userText, incomingEffort, JSON.stringify(allowedEfforts)], {
      encoding: "utf8",
    }),
  );
}

test("local dispatcher applies high floor only to session recovery and local-state diagnostics", () => {
  const recovery = probeRoute(
    "Please restore my missing Codex session from .codex state_5.sqlite and identify the broken file tree.",
    "medium",
  );
  assert.equal(recovery.heuristic.target_effort, "high");
  assert.equal(recovery.calibrated, "high");

  const localDiagnostic = probeRoute("Find my hijacked session list; the local session state looks broken.", "low");
  assert.equal(localDiagnostic.heuristic.target_effort, "high");
  assert.equal(localDiagnostic.calibrated, "high");

  assert.equal(probeRoute("where's my latest session", "medium").calibrated, "medium");
  assert.equal(probeRoute("show me my threads", "low").calibrated, "low");
});
