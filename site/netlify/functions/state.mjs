// Live state, read from the deployed contracts on every request.
//
// Decoded server-side rather than shipping an ABI to the browser: the page stays small, and
// there is no cached copy that can drift from what is actually on Arc.
import { createPublicClient, http, keccak256, stringToBytes } from 'viem'

const RPC = Netlify.env.get('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.io'
const D = {
  oracle: '0x391c05393778eae959cf16296e308d5538c5754f',
  rateSource: '0xda0a00a82455d6a28b4695be97e6fdbfb4d18198',
  pool: '0xee754d16908335a13c0c2b938a8c897a9cf694c4',
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
    return new Response(j({
      addresses: D, pair: PAIR,
      block: { number: block.number, timestamp: block.timestamp },
      gasPriceGwei: Number(gasPrice) / 1e9,
      oracle: { rate: feed.rate, observedAt: feed.observedAt, postedAt: feed.postedAt,
                ageSeconds: Number(block.timestamp) - Number(feed.observedAt),
                quorum, devFreshBps: devFresh, devCeilingBps: devCeiling },
      pool, asOf: new Date().toISOString(),
    }), { headers })
  } catch (e) {
    return new Response(j({ error: 'read failed', detail: String(e?.shortMessage ?? e?.message ?? e) }),
      { status: 502, headers })
  }
}
export const config = { path: '/api/state' }
