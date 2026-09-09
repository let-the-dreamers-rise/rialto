#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${CHAIN_PORT:-8545}
RPC="http://127.0.0.1:$PORT"
rpc() { curl -sS --max-time 5 -X POST "$RPC" -H 'content-type: application/json' -d "$1" 2>/dev/null; }
cleanup() {
  for pid in $(ps -eo pid,args | grep -E "node scripts/simulate" | grep -v grep | awk '{print $1}'); do kill -9 "$pid" 2>/dev/null || true; done
  for pid in $(ps -eo pid,args | grep -E "hardhat node --port $PORT" | grep -v grep | awk '{print $1}'); do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
cleanup; sleep 2
npx hardhat node --port "$PORT" > /tmp/corridor-chain.log 2>&1 &
for _ in $(seq 1 40); do sleep 1; rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result && break; done
BLOCK=$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -oE '"result":"0x[0-9a-f]+"' | cut -d'"' -f4)
[ "$BLOCK" = "0x0" ] || { echo "chain not fresh ($BLOCK)"; exit 1; }
node scripts/compile.mjs > /dev/null
node scripts/simulate-corridors.mjs "$@"
