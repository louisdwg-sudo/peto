# QUICKSTART

## Prerequisites

```sh
node --version
npm --version
python3 --version
```

## Config bootstrap

```sh
cp packages/gateway/peto.config.example.json peto.config.json
# Edit peto.config.json and set three fields:
#   "upstreamBaseUrl": "https://api.example.com"
#   "defaultTargetModel": "your-executor-model"
#   "localRouterUrl": "http://127.0.0.1:8788/route"
```

## Run the gateway

```sh
PETO_CONFIG=./peto.config.json npm run gateway
```

## First eval cycle

```sh
mkdir -p memory/dispatcher/logs
PETO_CONFIG=./peto.config.json npm run dispatcher:qwen > memory/dispatcher/logs/local-qwen-dispatcher.out.log 2>&1 &
PETO_DISPATCHER_PID=$!
sleep 3

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

kill "$PETO_DISPATCHER_PID"
```
