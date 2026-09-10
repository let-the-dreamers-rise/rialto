// Live state, read from the deployed contracts on every request.
//
// Decoded server-side rather than shipping an ABI to the browser: the page stays small, and
// there is no cached copy that can drift from what is actually on Arc.
import { createPublicClient, http, keccak256, stringToBytes } from 'viem'

const RPC = Netlify.env.get('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.io'
const D = {
  oracle: '0x391c05393778eae959cf16296e308d5538c5754f',
  rateSource: '0xda0a00a82455d6a28b4695be97e6fdbfb4d18198',
  pool: '0x089879abc2a71e003a71eb9047acd0d63b1f9cfc',
  settlement: '0xd8c925d0f500356bb8f87ac52faf4c9439923899',
  router: '0x978e8fe239ed8c7b669687afa55a6310242a1172',
  forward: '0xf49f0ba2e427ee045755199ebf63dbc64fde0751',
}
const PAIR = keccak256(stringToBytes('EUR/USD'))
const ORACLE = [
  { type:'function', name:'peek', inputs:[{type:'bytes32'}], stateMutability:'view',
    outputs:[{ type:'tuple', components:[{name:'rate',type:'uint256'},{name:'observedAt',type:'uint64'},{name:'postedAt',type:'uint64'}] }] },
  { type:'function', name:'quorum', inputs:[], outputs:[{type:'uint256'}], stateMutability:'view' },
  { type:'function', name:'MAX_DEVIATION_BPS', inputs:[], outputs:[{type:'uint256'}], stateMutability:'view' },
  { type:'function', name:'MAX_ABSOLUTE_DEVIATION_BPS', inputs:[], outputs:[{type:'uint256'}], stateMutability:'view' },
]
const POOL = ['amp','feePpm','protocolSharePpm','reserve0','reserve1'].map((n) =>
  ({ type:'function', name:n, inputs:[], outputs:[{type:'uint256'}], stateMutability:'view' }))

// The settled position is read back off the chain rather than trusted from the file the
// script wrote. If someone re-ran the demo, or it never happened, the page shows what the
// forward actually holds.
const FORWARD = [
  { type:'function', name:'offers', inputs:[], outputs:[{type:'uint256'}], stateMutability:'view' },
  { type:'function', name:'get', inputs:[{type:'uint256'}], stateMutability:'view',
    outputs:[{ type:'tuple', components:[
      {name:'pair',type:'bytes32'},{name:'writer',type:'address'},{name:'taker',type:'address'},
      {name:'notional',type:'uint256'},{name:'strike',type:'uint256'},{name:'maturity',type:'uint64'},
      {name:'writerCollateral',type:'uint256'},{name:'takerCollateral',type:'uint256'},
      {name:'settled',type:'bool'},{name:'cancelled',type:'bool'}] }] },
]

const chain = { id: 5042002, name: 'Arc Testnet',
  nativeCurrency: { name:'USDC', symbol:'USDC', decimals:18 }, rpcUrls: { default: { http: [RPC] } } }
const client = createPublicClient({ chain, transport: http(RPC) })
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))

export default async () => {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
  try {
    const [block, gasPrice, feed, quorum, devFresh, devCeiling] = await Promise.all([
      client.getBlock(), client.getGasPrice(),
      client.readContract({ address: D.oracle, abi: ORACLE, functionName: 'peek', args: [PAIR] }),
      client.readContract({ address: D.oracle, abi: ORACLE, functionName: 'quorum' }),
      client.readContract({ address: D.oracle, abi: ORACLE, functionName: 'MAX_DEVIATION_BPS' }),
      client.readContract({ address: D.oracle, abi: ORACLE, functionName: 'MAX_ABSOLUTE_DEVIATION_BPS' }),
    ])
    const pool = Object.fromEntries(await Promise.all(
      ['amp','feePpm','protocolSharePpm','reserve0','reserve1'].map(async (n) =>
        [n, await client.readContract({ address: D.pool, abi: POOL, functionName: n })])))

    let forward = null
    try {
      const count = await client.readContract({ address: D.forward, abi: FORWARD, functionName: 'offers' })
      forward = { count }
      if (count > 0n) {
        const o = await client.readContract({ address: D.forward, abi: FORWARD, functionName: 'get', args: [count - 1n] })
        forward.latest = { id: count - 1n, notional: o.notional, strike: o.strike, maturity: o.maturity,
                           writer: o.writer, taker: o.taker, settled: o.settled, cancelled: o.cancelled,
                           collateralEachSide: o.settled ? null : o.takerCollateral }
      }
    } catch { /* a forward that will not read is reported as absent, not as an error */ }

    return new Response(j({
      addresses: D, pair: PAIR,
      block: { number: block.number, timestamp: block.timestamp },
      gasPriceGwei: Number(gasPrice) / 1e9,
      oracle: { rate: feed.rate, observedAt: feed.observedAt, postedAt: feed.postedAt,
                ageSeconds: Number(block.timestamp) - Number(feed.observedAt),
                quorum, devFreshBps: devFresh, devCeilingBps: devCeiling },
      pool, forward, asOf: new Date().toISOString(),
    }), { headers })
  } catch (e) {
    return new Response(j({ error: 'read failed', detail: String(e?.shortMessage ?? e?.message ?? e) }),
      { status: 502, headers })
  }
}
export const config = { path: '/api/state' }
