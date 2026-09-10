#!/usr/bin/env bash
# Rehearse live-forward.mjs against a throwaway local chain before it touches Arc.
#
# The Arc run locks real collateral and posts a real oracle print; an argument or ABI
# mistake there costs gas and leaves a position to unwind. Locally it costs nothing, so
# the rehearsal is not optional.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${CHAIN_PORT:-8545}
RPC="http://127.0.0.1:$PORT"
rpc() { curl -sS --max-time 5 -X POST "$RPC" -H 'content-type: application/json' -d "$1" 2>/dev/null; }

stop_chain() {
  local pid
  for pid in $(ps -eo pid,args | grep -E "hardhat node --port $PORT" | grep -v grep | awk '{print $1}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
}
trap stop_chain EXIT
stop_chain
sleep 1
if rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result; then
  echo "ERROR: something is still serving $RPC" >&2; exit 1
fi

npx hardhat node --port "$PORT" > /tmp/rialto-dryrun-chain.log 2>&1 &
for _ in $(seq 1 40); do
  sleep 1
  rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result && break
done
rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result || { echo "chain never came up"; exit 1; }

# Assert the chain is genuinely empty, so a stale node cannot be mistaken for a fresh one.
BLOCK=$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -oE '"result":"[^"]*"' | cut -d'"' -f4)
[ "$BLOCK" = "0x0" ] || { echo "ERROR: chain is at block $BLOCK, not fresh" >&2; exit 1; }
echo "==> clean chain at $RPC"

rm -f deployments/local.json
node scripts/deploy.mjs local
node scripts/deploy-instruments.mjs local
echo
echo "==> rehearsing the forward"
TENOR=${TENOR:-15} node scripts/live-forward.mjs local
