// Server-side proxy for Arc testnet JSON-RPC reads.
//
// The page could call the RPC directly, but a public RPC is under no obligation to send
// CORS headers and a demo that silently shows "unreachable" in someone else's browser is
// worse than no demo. Proxying also keeps the endpoint swappable without touching the page.
//
// Read-only by construction: only the methods below are forwarded, so this cannot be used
// to relay a transaction.
const RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io'
const ALLOWED = new Set(['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_call', 'eth_getBalance', 'eth_getCode'])

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'public, max-age=5, stale-while-revalidate=30')
  try {
    const url = new URL(req.url, 'http://x')
    const method = url.searchParams.get('method') ?? 'eth_chainId'
    if (!ALLOWED.has(method)) return res.status(400).end(JSON.stringify({ error: `method ${method} not proxied` }))
    const params = JSON.parse(url.searchParams.get('params') ?? '[]')

    const upstream = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    })
    const body = await upstream.json()
    res.status(200).end(JSON.stringify(body))
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'arc rpc unreachable', detail: String(e?.message ?? e) }))
  }
}
