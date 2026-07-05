#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ALLOWED_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"]
MODEL = None
TOKENIZER = None
TORCH = None
DEVICE = "cpu"
MODEL_DIR = ""
STARTED_AT = time.time()


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Qwen dispatcher for PETO effort routing.")
    parser.add_argument("--host", default=os.getenv("PETO_QWEN_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PETO_QWEN_PORT", "8788")))
    parser.add_argument(
        "--model-dir",
        default=os.getenv(
            "QWEN_MODEL_DIR",
            "/Users/louis/Documents/Project/第二题/Models/qwen/Qwen3-1.7B",
        ),
    )
    args = parser.parse_args()

    print(f"Starting PETO local Qwen dispatcher with model_dir={args.model_dir}", flush=True)
    load_model(Path(args.model_dir))
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"PETO local Qwen dispatcher listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()
    return 0


def load_model(model_dir: Path) -> None:
    global MODEL, TOKENIZER, TORCH, DEVICE, MODEL_DIR

    if not model_dir.exists():
        raise SystemExit(f"Missing Qwen model directory: {model_dir}")

    print("Importing transformers and torch...", flush=True)
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    MODEL_DIR = str(model_dir)
    DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype_name = os.getenv("PETO_QWEN_DTYPE") or ("float16" if DEVICE == "mps" else "float32")
    dtype = getattr(torch, dtype_name)

    print(f"Loading tokenizer on {DEVICE}...", flush=True)
    TOKENIZER = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
    print(f"Loading Qwen model with dtype={dtype_name}...", flush=True)
    MODEL = AutoModelForCausalLM.from_pretrained(
        str(model_dir),
        dtype=dtype,
        device_map=None,
        trust_remote_code=True,
    )
    TORCH = torch
    print(f"Moving Qwen model to {DEVICE}...", flush=True)
    MODEL.to(DEVICE)
    MODEL.eval()
    print("Qwen model loaded.", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "PETOQwenDispatcher/0.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            self.respond(
                200,
                {
                    "ok": True,
                    "model": os.path.basename(MODEL_DIR),
                    "model_dir": MODEL_DIR,
                    "device": DEVICE,
                    "uptime_sec": round(time.time() - STARTED_AT, 3),
                },
            )
            return
        self.respond(404, {"error": f"Unsupported route: GET {self.path}"})

    def do_POST(self) -> None:
        if not self.path.startswith("/route"):
            self.respond(404, {"error": f"Unsupported route: POST {self.path}"})
            return

        try:
            payload = self.read_json()
            user_text = str(payload.get("user_text") or payload.get("userText") or "")
            notes = payload.get("notes") if isinstance(payload.get("notes"), list) else []
            allowed = normalize_allowed(payload.get("allowed_efforts") or payload.get("allowedEfforts"))
            route = route_with_qwen(user_text=user_text, notes=notes, allowed=allowed)
            self.respond(200, route)
        except Exception as exc:
            fallback = heuristic_route("", ALLOWED_EFFORTS)
            fallback.update(
                {
                    "source": "local_qwen_error_fallback",
                    "needs_review": True,
                    "rationale_short": f"Dispatcher error fallback: {str(exc)[:160]}",
                }
            )
            self.respond(200, fallback)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        raw = self.rfile.read(length).decode("utf-8")
        if not raw:
            return {}
        return json.loads(raw)

    def respond(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", flush=True)


def normalize_allowed(value: Any) -> list[str]:
    if not isinstance(value, list):
        return ALLOWED_EFFORTS
    allowed = [str(item).lower() for item in value if str(item).lower() in ALLOWED_EFFORTS]
    return allowed or ALLOWED_EFFORTS


def route_with_qwen(*, user_text: str, notes: list[Any], allowed: list[str]) -> dict[str, Any]:
    prompt = build_prompt(user_text=user_text, notes=notes, allowed=allowed)
    messages = [
        {
            "role": "system",
            "content": "You are PETO's local effort router. Output one effort label only.",
        },
        {"role": "user", "content": prompt},
    ]

    rendered = TOKENIZER.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    inputs = TOKENIZER([rendered], return_tensors="pt").to(DEVICE)
    with TORCH.no_grad():
        generate_kwargs = {
            **inputs,
            "max_new_tokens": int(os.getenv("PETO_QWEN_MAX_NEW_TOKENS", "8")),
            "do_sample": os.getenv("PETO_QWEN_DO_SAMPLE", "0").strip() == "1",
            "repetition_penalty": float(os.getenv("PETO_QWEN_REPETITION_PENALTY", "1.04")),
        }
        if generate_kwargs["do_sample"]:
            generate_kwargs["temperature"] = float(os.getenv("PETO_QWEN_TEMPERATURE", "0.2"))
            generate_kwargs["top_p"] = float(os.getenv("PETO_QWEN_TOP_P", "0.9"))
        outputs = MODEL.generate(**generate_kwargs)
    generated_ids = outputs[:, inputs.input_ids.shape[1] :]
    content = TOKENIZER.batch_decode(generated_ids, skip_special_tokens=True)[0]
    effort = calibrate_effort(parse_effort_label(content, allowed), user_text, allowed)
    route = qwen_label_route(effort, allowed)

    if not route:
        route = heuristic_route(user_text, allowed)
        route["source"] = "local_qwen_label_fallback"
        route["raw_model_output"] = content[:500]
        return route

    heuristic = heuristic_route(user_text, allowed)
    route.setdefault("confidence", 0.62)
    route.setdefault("rationale_short", f"Local Qwen selected {route['target_effort']}.")
    route.setdefault("recording_priority", heuristic["recording_priority"])
    route.setdefault("needs_review", False)
    route["source"] = "local_qwen"
    route["raw_model_output"] = content[:500]
    return route


def build_prompt(*, user_text: str, notes: list[Any], allowed: list[str]) -> str:
    notes_text = ""
    if notes:
        notes_text = "\nRelevant routing notes:\n" + json.dumps(notes[:2], ensure_ascii=False)[:500]
    return (
        "Choose the cheapest reasoning effort likely to satisfy the user.\n"
        f"Allowed labels: {', '.join(allowed)}.\n"
        "minimal/low: simple factual, status, tiny command.\n"
        "medium: normal coding, editing, planning, repo maintenance.\n"
        "high: complex debugging, architecture, research synthesis, evaluation design, high-risk work.\n"
        "xhigh: rare deep multi-step work where rework is very expensive.\n"
        "Reply with exactly one allowed label and no other text."
        f"{notes_text}\n"
        f"User request:\n{user_text[:2200]}\n"
        "Effort label:"
    )


def parse_effort_label(text: str, allowed: list[str]) -> str:
    cleaned = text.lower().strip()
    aliases = {
        "extra-high": "xhigh",
        "extra_high": "xhigh",
        "very high": "xhigh",
        "very_high": "xhigh",
        "med": "medium",
        "mid": "medium",
    }
    for alias, effort in aliases.items():
        if alias in cleaned and effort in allowed:
            return effort
    for effort in allowed:
        if re.search(rf"\b{re.escape(effort)}\b", cleaned):
            return effort
    return ""


def qwen_label_route(effort: str, allowed: list[str]) -> dict[str, Any]:
    if effort not in allowed:
        return {}
    return {
        "target_effort": effort,
        "confidence": 0.62,
        "rationale_short": f"Local Qwen selected {effort}.",
        "recording_priority": "watch" if effort in {"high", "xhigh"} else "normal",
        "needs_review": False,
    }


SIMPLE_SESSION_LOOKUP_PATTERNS = [
    r"\bwhere(?:'s| is) my (?:latest |last |current |previous )?(?:session|thread|chat)s?\b",
    r"\bshow me my (?:threads|sessions|projects)\b",
    r"\blist my (?:threads|sessions|projects)\b",
]

SESSION_ENTITY_TERMS = ["session", "sessions", "thread", "threads", "chat", "chats", "codex"]
SESSION_RECOVERY_INTENT_TERMS = ["restore", "recover", "revive", "bring back", "hijacked"]
SESSION_LOCAL_STATE_TERMS = [
    ".codex",
    "state_",
    "sqlite",
    "file tree",
    "session list",
    "local session",
    "file identification",
]
SESSION_DIAGNOSTIC_TRIGGER_TERMS = [
    "restore",
    "recover",
    "missing",
    "broken",
    "hijacked",
    ".codex",
    "state_",
    "sqlite",
    "file tree",
    "session list",
    "bring back",
    "find my",
    "where is my",
    "where's my",
]
SESSION_HARD_DIAGNOSTIC_TERMS = [
    "restore",
    "recover",
    "missing",
    "broken",
    "hijacked",
    ".codex",
    "state_",
    "sqlite",
    "file tree",
    "session list",
    "bring back",
    "revive",
]


def is_simple_session_lookup(user_text: str) -> bool:
    lowered = user_text.lower()
    if not any(re.search(pattern, lowered) for pattern in SIMPLE_SESSION_LOOKUP_PATTERNS):
        return False
    return not any(term in lowered for term in SESSION_HARD_DIAGNOSTIC_TERMS)


def should_floor_session_diagnostic_to_high(user_text: str) -> bool:
    lowered = user_text.lower()
    if is_simple_session_lookup(lowered):
        return False

    has_trigger = any(term in lowered for term in SESSION_DIAGNOSTIC_TRIGGER_TERMS)
    if not has_trigger:
        return False

    has_session_entity = any(term in lowered for term in SESSION_ENTITY_TERMS)
    has_recovery_intent = any(term in lowered for term in SESSION_RECOVERY_INTENT_TERMS)
    has_local_state = any(term in lowered for term in SESSION_LOCAL_STATE_TERMS)
    has_hard_diagnostic = any(term in lowered for term in SESSION_HARD_DIAGNOSTIC_TERMS)
    has_diagnostic_intent = any(term in lowered for term in ["diagnos", "debug", "identify", "investigate"])

    session_restore = has_session_entity and (has_recovery_intent or has_hard_diagnostic)
    local_state_diagnostic = has_local_state and (has_recovery_intent or has_hard_diagnostic or has_diagnostic_intent)
    return session_restore or local_state_diagnostic


def calibrate_effort(effort: str, user_text: str, allowed: list[str]) -> str:
    heuristic = heuristic_route(user_text, allowed)["target_effort"]
    if effort not in allowed:
        return heuristic

    order = {name: index for index, name in enumerate(ALLOWED_EFFORTS)}
    obvious_high_terms = [
        "critical analysis",
        "evaluation",
        "methodology",
        "research paper",
        "architecture",
        "security",
        "production",
        "migration",
        "postmortem",
        "你 missed",
        "not right",
        "redo",
    ]
    lowered = user_text.lower()
    if should_floor_session_diagnostic_to_high(user_text) and order[effort] < order.get("high", 3):
        return "high" if "high" in allowed else heuristic

    if any(term in lowered for term in obvious_high_terms) and order[effort] < order.get("high", 3):
        return "high" if "high" in allowed else heuristic

    if order[heuristic] > order[effort] + 1:
        return heuristic
    return effort


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", cleaned, flags=re.S)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def normalize_route(parsed: dict[str, Any], allowed: list[str]) -> dict[str, Any]:
    effort = str(parsed.get("target_effort") or parsed.get("effort") or "").lower().strip()
    aliases = {
        "extra-high": "xhigh",
        "extra_high": "xhigh",
        "very_high": "xhigh",
        "very-high": "xhigh",
        "med": "medium",
        "mid": "medium",
    }
    effort = aliases.get(effort, effort)
    if effort not in allowed:
        return {}

    confidence = parsed.get("confidence", 0.62)
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.62

    priority = str(parsed.get("recording_priority") or "normal").lower()
    if priority not in {"skip", "normal", "watch", "lesson_candidate"}:
        priority = "normal"

    return {
        "target_effort": effort,
        "confidence": confidence,
        "rationale_short": str(parsed.get("rationale_short") or "Local Qwen selected effort.")[:240],
        "recording_priority": priority,
        "needs_review": bool(parsed.get("needs_review", False)),
    }


def heuristic_route(user_text: str, allowed: list[str]) -> dict[str, Any]:
    text = user_text.lower()
    words = re.findall(r"[\w\u4e00-\u9fff]+", text)
    word_count = len(words)

    explicit_xhigh = any(token in text for token in ["xhigh", "extra high", "maximum effort", "deepest"])
    explicit_high = any(token in text for token in ["high effort", "critical", "production", "security", "migration"])
    dissatisfaction = any(token in text for token in ["not right", "redo", "trash", "rubbish", "you missed", "不对", "重来"])
    research = any(token in text for token in ["research", "paper", "article", "evaluation", "methodology", "critical analysis"])
    code_work = any(token in text for token in ["fix", "debug", "implement", "commit", "deploy", "dispatcher", "router", "gateway"])
    session_diagnostic_high_floor = should_floor_session_diagnostic_to_high(user_text)
    simple = word_count <= 18 and not any([research, code_work, explicit_high, explicit_xhigh, dissatisfaction])

    if explicit_xhigh:
        effort = "xhigh"
    elif explicit_high or dissatisfaction or session_diagnostic_high_floor:
        effort = "high"
    elif research:
        effort = "high" if word_count > 40 else "medium"
    elif code_work:
        effort = "medium"
    elif simple:
        effort = "low"
    else:
        effort = "medium"

    if effort not in allowed:
        effort = first_allowed_fallback(allowed, effort)

    return {
        "target_effort": effort,
        "confidence": 0.48,
        "rationale_short": (
            "Heuristic route: high matched session/local-state diagnostic."
            if session_diagnostic_high_floor and effort == "high"
            else f"Heuristic route: {effort} matched request shape."
        ),
        "recording_priority": "watch" if effort in {"high", "xhigh"} or dissatisfaction else "normal",
        "needs_review": dissatisfaction,
        "source": "heuristic",
    }


def first_allowed_fallback(allowed: list[str], preferred: str) -> str:
    if preferred in allowed:
        return preferred
    for effort in ["medium", "low", "high", "minimal", "xhigh"]:
        if effort in allowed:
            return effort
    return allowed[0]


if __name__ == "__main__":
    raise SystemExit(main())
