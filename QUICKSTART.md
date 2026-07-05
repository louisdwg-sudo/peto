# QUICKSTART

Choose your router setup before starting:

- **Option A — Local Qwen3 (private, no API cost):** requires Python + model weights (~1.7GB). Best for privacy-sensitive setups.
- **Option B — Hosted small model (5-minute setup, no download):** uses a cheap API model as the router. Best for getting started fast.

---

## Prerequisites

```sh
node --version   # Node 18+
npm --version
```

Option A only:
```sh
python3 --version  # 3.9+
```

---

## Option A — Local Qwen3 router

### 1. Download the model

```sh
pip install huggingface_hub
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('Qwen/Qwen3-1.7B-Instruct',
  local_dir='./models/Qwen3-1.7B-Instruct',
  local_dir_use_symlinks=False)
"
```

### 2. Config bootstrap

```sh
cp packages/gateway/peto.config.example.json peto.config.json
# Edit peto.config.json and set:
#   "upstreamBaseUrl": "https://api.example.com"
#   "defaultTargetModel": "your-executor-model"
#   "routerBackend": "local_http"
#   "localRouterUrl": "http://127.0.0.1:8788/route"
```

### 3. Run the gateway + dispatcher

```sh
PETO_CONFIG=./peto.config.json QWEN_MODEL_DIR=./models/Qwen3-1.7B-Instruct \
  npm run dispatcher:qwen > /tmp/peto-dispatcher.log 2>&1 &
PETO_DISPATCHER_PID=$!
sleep 5

PETO_CONFIG=./peto.config.json npm run gateway
```

---

## Option B — Hosted small model router (no download)

Uses a cheap, fast API model as the PETO dispatcher. No model weights to download.

### 1. Config bootstrap

```sh
cp packages/gateway/peto.config.example.json peto.config.json
# Edit peto.config.json and set:
#   "upstreamBaseUrl": "https://api.anthropic.com"   (or your provider)
#   "defaultTargetModel": "claude-sonnet-5"           (executor model)
#   "routerBackend": "openai_responses"
#   "routerModel": "claude-haiku-4-5-20251001"        (cheap router model)
#   "routerEffort": "low"
#   "routerMaxOutputTokens": 220
```

Router cost: ~$0.0003 per routing decision at Haiku 4.5 pricing. Negligible vs executor cost.

### 2. Run the gateway

```sh
PETO_CONFIG=./peto.config.json npm run gateway
```

No dispatcher process needed — the gateway calls the hosted router directly.

---

## First eval cycle (both options)

```sh
mkdir -p memory/dispatcher/logs

PETO_CONFIG=./peto.config.json npm run cli -- route "Summarize this request." --json
PETO_CONFIG=./peto.config.json npm run cli -- eval

mkdir -p memory/verification
cat > memory/verification/quickstart-ticket.json <<'JSON'
{
  "id": "quickstart",
  "seed": 1,
  "sample_size": 1
}
JSON

RUN_ID=$(PETO_CONFIG=./peto.config.json npm --silent run cli -- verify create \
  --ticket memory/verification/quickstart-ticket.json --json \
  | node --input-type=module -e "const d=await new Promise(r=>{let b='';process.stdin.on('data',c=>b+=c).on('end',()=>r(b))});console.log(JSON.parse(d).run_id)")
PETO_CONFIG=./peto.config.json npm run cli -- verify run --id "$RUN_ID" --json
PETO_CONFIG=./peto.config.json npm run cli -- verify gate --id "$RUN_ID" --json
PETO_CONFIG=./peto.config.json npm run cli -- verify report --id "$RUN_ID"
```

