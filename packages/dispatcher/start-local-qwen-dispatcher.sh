#!/usr/bin/env bash
set -euo pipefail

host="${PETO_QWEN_HOST:-127.0.0.1}"
port="${PETO_QWEN_PORT:-8789}"
python_bin="${PETO_QWEN_PYTHON:-python3}"
model_dir="${QWEN_MODEL_DIR:?Set QWEN_MODEL_DIR to a local Qwen instruct model directory.}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export QWEN_MODEL_DIR="$model_dir"
export PETO_QWEN_DTYPE="${PETO_QWEN_DTYPE:-float16}"

exec "$python_bin" "$script_dir/local-qwen-dispatcher.py" --host "$host" --port "$port"
