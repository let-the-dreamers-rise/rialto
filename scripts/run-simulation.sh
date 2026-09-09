#!/usr/bin/env bash
# Run the comparison from a verified-clean chain.
#
# Each run advances the chain clock by a year and deploys a fresh set of contracts, so a
# node reused across runs carries state that has nothing to do with the experiment. Worse,
# a failed kill is silent: the new node cannot bind the port, exits, and every subsequent
# run quietly talks to the old chain. So the chain is not merely restarted here, it is
# asserted fresh before anything is deployed.
set -euo pipefail
cd "$(dirname "$0")/.."

SCENARIO=${1:-equal-value}
DAYS=${2:-}
PORT=${CHAIN_PORT:-8545}
RPC="http://127.0.0.1:$PORT"

rpc() { curl -sS --max-time 5 -X POST "$RPC" -H 'content-type: application/json' -d "$1" 2>/dev/null; }

# A simulation left running from an earlier attempt will happily connect to the *next*
# run's chain and send transactions from the same accounts, which shows up as nonce
# collisions and a chain that is mysteriously not empty. Clear those out too.
stop_stragglers() {
  local pid
  for pid in $(ps -eo pid,args | grep -E "node scripts/simulate\.mjs" | grep -v grep | awk '{print $1}'); do
    [ "$pid" = "$$" ] && continue
    kill -9 "$pid" 2>/dev/null || true
  done
}

stop_chain() {
  # By listening socket, then by command line — ss does not always report the pid.
  local pid
  pid=$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  for pid in $(ps -eo pid,args | grep -E "hardhat node --port $PORT" | grep -v grep | awk '{print $1}'); do
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do
    rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result || return 0
    sleep 1
  done
}
trap stop_chain EXIT

echo "==> stopping any existing chain and stray simulations"
stop_stragglers
stop_chain
if rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result; then
  echo "ERROR: something is still serving $RPC and would not stop." >&2
  exit 1
fi

echo "==> starting a clean chain"
npx hardhat node --port "$PORT" > "/tmp/rialto-chain-$SCENARIO.log" 2>&1 &
CHAIN_PID=$!
for _ in $(seq 1 40); do
  sleep 1
  rpc '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result && break
done

# Freshness assertion: a reused chain is the difference between a result and an artefact.
BLOCK=$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -oE '"result":"0x[0-9a-f]+"' | cut -d'"' -f4)
NONCE=$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionCount","params":["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","latest"]}' | grep -oE '"result":"0x[0-9a-f]+"' | cut -d'"' -f4)
if [ "$BLOCK" != "0x0" ] || [ "$NONCE" != "0x0" ]; then
  echo "ERROR: chain is not fresh (block=$BLOCK nonce=$NONCE). Refusing to run." >&2
  exit 1
fi
echo "    chain is fresh (block 0, nonce 0), pid $CHAIN_PID"

echo "==> compiling"
node scripts/compile.mjs > /dev/null

echo "==> simulating ($SCENARIO)"
node scripts/simulate.mjs "$SCENARIO" $DAYS
