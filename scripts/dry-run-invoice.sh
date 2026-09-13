#!/usr/bin/env bash
# Rehearse live-invoice.mjs on a throwaway local chain before it seeds a real pool.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${CHAIN_PORT:-8545}
RPC="http://127.0.0.1:$PORT"
rpc() { curl -sS --max-time 5 -X POST "$RPC" -H 'content-type: application/json' -d "$1" 2>/dev/null; }
stop_chain() {
  for pid in $(ps -eo pid,args | grep -E "hardhat node --port $PORT" | grep -v grep | awk '{print $1}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
}
trap stop_chain EXIT
stop_chain; sleep 1
rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result && { echo "ERROR: $RPC still served" >&2; exit 1; }

npx hardhat node --port "$PORT" > /tmp/rialto-invoice-chain.log 2>&1 &
for _ in $(seq 1 40); do sleep 1; rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -q result && break; done
BLOCK=$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -oE '"result":"[^"]*"' | cut -d'"' -f4)
[ "$BLOCK" = "0x0" ] || { echo "ERROR: chain at $BLOCK, not fresh" >&2; exit 1; }
echo "==> clean chain at $RPC"

rm -f deployments/local.json .secrets/payee.json
node scripts/deploy.mjs local
node scripts/deploy-instruments.mjs local
echo
echo "==> posting a rate so the pool can price"
NETWORK=local node scripts/publish-rate.mjs
echo
echo "==> rehearsing seed + invoice"
node scripts/live-invoice.mjs local
