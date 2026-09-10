// Execute the real getRate(pair, maxAge) against the deployed oracle.
//
// The page's one genuinely interactive thing, and it is interactive because the answer is
// not knowable from the page: getRate reverts when the feed is older than the bound the
// *caller* names. Choosing sixty seconds and watching StaleRate come back is executing the
// design decision rather than reading about it.
import { createPublicClient, http, keccak256, stringToBytes } from 'viem'

const RPC = Netlify.env.get('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.io'
const ORACLE_ADDR = '0x391c05393778eae959cf16296e308d5538c5754f'
const PAIR = keccak256(stringToBytes('EUR/USD'))
// The custom errors belong in the ABI: without them a revert returns as a bare 0xec30f4ab
// and the demonstration collapses into looking like a bug, when the contract is in fact
// refusing precisely on the caller's terms.
const ABI = [
  { type:'function', name:'getRate', inputs:[{type:'bytes32'},{type:'uint256'}],
    outputs:[{type:'uint256'},{type:'uint64'}], stateMutability:'view' },
  { type:'error', name:'StaleRate', inputs:[] },
  { type:'error', name:'NoFeed', inputs:[] },
]
const SELECTORS = { '0xec30f4ab': 'StaleRate', '0x7e1f7c28': 'NoFeed' }
const chain = { id: 5042002, name: 'Arc Testnet',
  nativeCurrency: { name:'USDC', symbol:'USDC', decimals:18 }, rpcUrls: { default: { http: [RPC] } } }
const client = createPublicClient({ chain, transport: http(RPC) })

export default async (req) => {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
  const raw = Number(new URL(req.url).searchParams.get('maxAge') ?? 900)
  const maxAge = BigInt(Math.max(0, Math.min(2_592_000, Number.isFinite(raw) ? raw : 900)))
  const call = `getRate(keccak256("EUR/USD"), ${maxAge})`
  try {
    const [rate, observedAt] = await client.readContract({
      address: ORACLE_ADDR, abi: ABI, functionName: 'getRate', args: [PAIR, maxAge] })
    return new Response(JSON.stringify({ ok: true, maxAge: maxAge.toString(), call,
      rate: rate.toString(), rateDecimal: Number(rate) / 1e18, observedAt: observedAt.toString() }), { headers })
  } catch (e) {
    const msg = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`
    const named = e?.cause?.data?.errorName
      ?? msg.match(/\b(StaleRate|NoFeed)\b/)?.[1]
      ?? Object.entries(SELECTORS).find(([s]) => msg.includes(s))?.[1]
      ?? 'reverted'
    // A revert is the correct answer here, not a failure, so this is a 200.
    return new Response(JSON.stringify({ ok: false, maxAge: maxAge.toString(), call, revert: named,
      detail: named === 'StaleRate' ? 'the feed is older than the bound you asked for' : msg.slice(0, 160) }), { headers })
  }
}
export const config = { path: '/api/getRate' }
