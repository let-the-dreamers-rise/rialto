// Execute the real getRate(pair, maxAge) against the deployed oracle.
//
// This is the page's one genuinely interactive thing, and it is interactive because the
// answer is not knowable from the page: getRate reverts when the feed is older than the
// bound the *caller* names. A visitor choosing 60 seconds and watching it revert is
// executing the design decision, not reading about it.
import { createPublicClient, http, keccak256, stringToBytes } from 'viem'

const RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io'
const ORACLE_ADDR = '0x391c05393778eae959cf16296e308d5538c5754f'
const PAIR = keccak256(stringToBytes('EUR/USD'))
// The custom errors are part of the ABI on purpose: without them a revert comes back as a
// bare selector like 0xec30f4ab, and the whole point of the demo is that the reader sees
// *StaleRate* and understands the contract refused on their terms rather than broke.
const ABI = [
  { type:'function', name:'getRate', inputs:[{type:'bytes32'},{type:'uint256'}],
    outputs:[{type:'uint256'},{type:'uint64'}], stateMutability:'view' },
  { type:'error', name:'StaleRate', inputs:[] },
  { type:'error', name:'NoFeed', inputs:[] },
]

const client = createPublicClient({
  chain: { id: 5042002, name:'Arc Testnet', nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},
           rpcUrls:{ default:{ http:[RPC] } } },
  transport: http(RPC),
})

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  const maxAge = BigInt(Math.max(0, Math.min(2_592_000, Number(new URL(req.url, 'http://x').searchParams.get('maxAge') ?? 900))))
  try {
    const [rate, observedAt] = await client.readContract({
      address: ORACLE_ADDR, abi: ABI, functionName: 'getRate', args: [PAIR, maxAge],
    })
    res.status(200).end(JSON.stringify({
      ok: true, maxAge: maxAge.toString(),
      rate: rate.toString(), rateDecimal: Number(rate) / 1e18, observedAt: observedAt.toString(),
      call: `getRate(keccak256("EUR/USD"), ${maxAge})`,
    }))
  } catch (e) {
    // A revert is the correct answer here, not a failure, so it returns 200 with ok:false.
    const msg = `${e?.shortMessage ?? ''} ${e?.message ?? ''} ${e?.cause?.data?.errorName ?? ''}`
    // viem surfaces a decoded custom error by name; fall back to the raw selector map.
    const SELECTORS = { '0xec30f4ab': 'StaleRate', '0x7e1f7c28': 'NoFeed' }
    const bySelector = Object.entries(SELECTORS).find(([sel]) => msg.includes(sel))?.[1]
    const named = e?.cause?.data?.errorName
      ?? msg.match(/\b(StaleRate|NoFeed)\b/)?.[1]
      ?? bySelector
      ?? 'reverted'
    res.status(200).end(JSON.stringify({
      ok: false, maxAge: maxAge.toString(), revert: named,
      call: `getRate(keccak256("EUR/USD"), ${maxAge})`,
      detail: named === 'StaleRate' ? 'the feed is older than the bound you asked for' : msg.slice(0, 160),
    }))
  }
}
