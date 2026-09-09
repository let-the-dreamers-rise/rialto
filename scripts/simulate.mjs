// Does centring liquidity on the real FX rate actually pay?
//
// Two pools, identical in every respect except where their liquidity sits:
//   A — rate fixed at 1.00, i.e. an ordinary Curve-style stableswap, which is what the
//       USDC/EURC venues currently on Arc are.
//   B — rate read from RialtoOracle, so the curve re-centres as EUR/USD moves.
// Same invariant, same amplification, same fee, same code path, same trades.
//
// Then 259 real trading days of ECB EUR/USD reference rates. Each day: the rate moves, a
// profit-maximising arbitrageur takes whatever mispricing each pool offers, and identical
// retail flow crosses both. At the end, each pool's reserves are valued at the market rate
// and compared with simply having held the opening basket.
//
// Everything runs on a real EVM against the deployed contracts — the arbitrageur calls
// quote() and swap() like anyone else. Nothing here is a spreadsheet model of the curve.
//
//   node scripts/simulate.mjs [equal-value|a-optimal] [days]
import { createWalletClient, createPublicClient, createTestClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  arcLocal, pairId, toRate, fromRate, parseUnits, formatUnits,
  signAttestationQuorum, valueReserves, bestArb,
} from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const POOL = art('RialtoPool'), TOKEN = art('MockERC20')
const ORACLE = art('RialtoOracle'), FIXED = art('FixedRateSource'), ORACLE_SRC = art('OracleRateSource')

const SCENARIO = process.argv[2] ?? 'equal-value'
const MAX_DAYS = Number(process.argv[3] ?? 0)

const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]
const transport = http('http://127.0.0.1:8545')
const pub = createPublicClient({ chain: arcLocal, transport })
const tc = createTestClient({ chain: arcLocal, transport, mode: 'hardhat' })
const acc = KEYS.map(privateKeyToAccount)
const wal = acc.map((a) => createWalletClient({ account: a, chain: arcLocal, transport }))
const [deployer, pubA, pubB, trader] = acc
const [wDeployer, wPubA, wPubB, wTrader] = wal

// Amplification. A 1:1 stableswap has to keep this moderate: amplification concentrates
// liquidity at the curve's centre, and if the peg leaves that centre the concentration
// works against the LP. A rate-anchored pool has no peg to leave — the centre tracks the
// rate — so the usual constraint does not apply, and whether that is really true is worth
// measuring rather than asserting. Override with AMP.
const AMP = BigInt(process.env.AMP ?? 200)
// 25bp. This is priced as an FX provider, not as a DeFi venue: Wise charges roughly
// 40-60bp on retail cross-border and banks 200-300bp, so a stableswap fee of 4bp leaves
// most of the spread on the table and pays LPs too little to show up. Override with FEE_PPM.
const FEE_PPM = BigInt(process.env.FEE_PPM ?? 2_500)
const PROTOCOL_SHARE = 500_000n // half of it to the protocol treasury
const EURUSD = pairId('EUR/USD')
const DEC = 6
const usd = (x) => parseUnits(String(Math.round(Number(x) * 1e6) / 1e6), DEC)

const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/eurusd-ecb.json'), 'utf8'))
const series = MAX_DAYS ? fx.rates.slice(0, MAX_DAYS) : fx.rates

async function deploy(a, args = []) {
  const hash = await wDeployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args })
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress
}
/**
 * Send a transaction, pinning the nonce explicitly and retrying if it goes stale.
 *
 * A run puts roughly ten thousand transactions through one account. Left to infer the
 * nonce, the client occasionally reuses a pending value across the mine/increaseTime
 * boundary and the run dies hours in, which is an expensive way to learn nothing.
 */
async function tx(w, address, abi, fn, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      const nonce = await pub.getTransactionCount({ address: w.account.address, blockTag: 'pending' })
      const hash = await w.writeContract({ address, abi, functionName: fn, args, nonce })
      const r = await pub.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error(`${fn} reverted`)
      return r
    } catch (e) {
      const msg = `${e?.details ?? ''}${e?.shortMessage ?? ''}${e?.message ?? ''}`
      if (attempt < 5 && /nonce/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 30))
        continue
      }
      throw e
    }
  }
}
const rd = (address, abi, fn, args = []) => pub.readContract({ address, abi, functionName: fn, args })

/*──────────────── setup ────────────────*/

console.log(`\x1b[1mRialto — does rate-anchoring pay?\x1b[0m`)
console.log(`scenario   ${SCENARIO}`)
console.log(`data       ${fx.source}`)
console.log(`           ${series.length} trading days, ${series[0].date} to ${series.at(-1).date}`)
console.log(`           EUR/USD ${Math.min(...series.map(r => r.rate))} .. ${Math.max(...series.map(r => r.rate))}`)
console.log(`pools      amp=${AMP} fee=${Number(FEE_PPM) / 100}bp protocol share=${Number(PROTOCOL_SHARE) / 10_000}%`)

const usdc = await deploy(TOKEN, ['USD Coin', 'USDC', DEC])
const eurc = await deploy(TOKEN, ['Euro Coin', 'EURC', DEC])
const oracle = await deploy(ORACLE, [[pubA.address, pubB.address], 2n, deployer.address])

const r0 = series[0].rate
// maxAge is deliberately tight: the rate is posted and used inside the same day.
const srcAnchored = await deploy(ORACLE_SRC, [oracle, EURUSD, 3600n])
const srcFixed = await deploy(FIXED, [toRate(1)])

async function postRate(rate) {
  const observedAt = BigInt((await pub.getBlock()).timestamp)
  const attestation = { pair: EURUSD, rate: toRate(rate), observedAt }
  const sigs = await signAttestationQuorum({
    signers: [{ walletClient: wPubA, account: pubA }, { walletClient: wPubB, account: pubB }],
    chainId: arcLocal.id, oracle, attestation,
  })
  await tx(wPubA, oracle, ORACLE.abi, 'submit', [attestation, sigs])
}
await postRate(r0)

const poolA = await deploy(POOL, [usdc, eurc, srcFixed, AMP, FEE_PPM, PROTOCOL_SHARE, deployer.address])
const poolB = await deploy(POOL, [usdc, eurc, srcAnchored, AMP, FEE_PPM, PROTOCOL_SHARE, deployer.address])

for (const who of [deployer, trader]) {
  await tx(wDeployer, usdc, TOKEN.abi, 'mint', [who.address, usd(500_000_000)])
  await tx(wDeployer, eurc, TOKEN.abi, 'mint', [who.address, usd(500_000_000)])
}
for (const [w] of [[wDeployer], [wTrader]]) {
  for (const t of [usdc, eurc]) for (const p of [poolA, poolB]) await tx(w, t, TOKEN.abi, 'approve', [p, 2n ** 255n])
}

// Both pools open with the same total value at the opening rate.
const EURC_SEED = 1_000_000
const TOTAL_VALUE = EURC_SEED * r0 * 2
let seedA, seedB
seedB = { u: usd(EURC_SEED * r0), e: usd(EURC_SEED) }              // value-balanced: B's sweet spot
if (SCENARIO === 'a-optimal') {
  // Give A its own best case: equal token counts, which is where a 1:1 curve is flattest.
  const n = TOTAL_VALUE / (1 + r0)
  seedA = { u: usd(n), e: usd(n) }
} else {
  seedA = { ...seedB }                                             // an LP deposits equal value
}

await tx(wDeployer, poolA, POOL.abi, 'addLiquidity', [seedA.u, seedA.e, 0n, deployer.address])
await tx(wDeployer, poolB, POOL.abi, 'addLiquidity', [seedB.u, seedB.e, 0n, deployer.address])

const openA = { r0: await rd(poolA, POOL.abi, 'reserve0'), r1: await rd(poolA, POOL.abi, 'reserve1') }
const openB = { r0: await rd(poolB, POOL.abi, 'reserve0'), r1: await rd(poolB, POOL.abi, 'reserve1') }

console.log(`\nopening    A: ${formatUnits(openA.r0, 6, 0)} USDC + ${formatUnits(openA.r1, 6, 0)} EURC`)
console.log(`           B: ${formatUnits(openB.r0, 6, 0)} USDC + ${formatUnits(openB.r1, 6, 0)} EURC`)

/*──────────────── the daily loop ────────────────*/

const quoteFor = (pool) => async (zeroForOne, amountIn) =>
  rd(pool, POOL.abi, 'quote', [zeroForOne, amountIn])

const stats = {
  A: { arbCount: 0, arbProfit: 0n, volume: 0n },
  B: { arbCount: 0, arbProfit: 0n, volume: 0n },
}

/** Let an arbitrageur take whatever mispricing the pool is offering. */
async function arbitrage(pool, key, marketRate) {
  let best
  try {
    best = await bestArb({
      quote: quoteFor(pool), marketRate: toRate(marketRate),
      maxIn: usd(3_000_000), dec0: DEC, dec1: DEC,
      spotPrice: () => rd(pool, POOL.abi, 'spotPrice'),
    })
  } catch { return }
  if (best.profit <= 0n || best.amountIn <= 0n) return
  try {
    await tx(wTrader, pool, POOL.abi, 'swap', [best.zeroForOne, best.amountIn, 0n, trader.address])
    stats[key].arbCount++
    stats[key].arbProfit += best.profit
    stats[key].volume += best.amountIn
  } catch { /* the pool could not support the trade; leave it mispriced */ }
}

// Deterministic retail flow, identical for both pools, so fee income is comparable.
let seed = 42
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const ORGANIC_PER_DAY = 6
async function organicFlow(pool, key) {
  for (let i = 0; i < ORGANIC_PER_DAY; i++) {
    const zeroForOne = rnd() < 0.5
    const size = usd(10_000 + Math.floor(rnd() * 40_000))
    try {
      await tx(wTrader, pool, POOL.abi, 'swap', [zeroForOne, size, 0n, trader.address])
      stats[key].volume += size
    } catch { /* pool exhausted on this side */ }
  }
}

const t0 = Date.now()
for (const [i, day] of series.entries()) {
  await tc.increaseTime({ seconds: 86_400 })
  await tc.mine({ blocks: 1 })
  if (i > 0) await postRate(day.rate)   // B's curve follows the market

  await arbitrage(poolB, 'B', day.rate)
  await arbitrage(poolA, 'A', day.rate)

  const flowSeed = seed
  await organicFlow(poolB, 'B')
  seed = flowSeed                        // identical retail flow through both
  await organicFlow(poolA, 'A')

  if (i % 20 === 0 || i === series.length - 1) {
    const el = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`  day ${String(i + 1).padStart(3)}/${series.length}  ${day.date}  EUR/USD ${day.rate}   ${el}s`)
  }
}
console.log('')

/*──────────────── settle up ────────────────*/

const finalRate = toRate(series.at(-1).rate)
const v = (r0_, r1_) => valueReserves({ reserve0: r0_, reserve1: r1_, dec0: DEC, dec1: DEC, rate: finalRate })

async function report(pool, key, open) {
  const r0_ = await rd(pool, POOL.abi, 'reserve0')
  const r1_ = await rd(pool, POOL.abi, 'reserve1')
  const f0 = await rd(pool, POOL.abi, 'protocolFees0')
  const f1 = await rd(pool, POOL.abi, 'protocolFees1')
  const held = v(open.r0, open.r1)      // what simply holding the opening basket is worth now
  const now = v(r0_, r1_)
  const protocol = v(f0, f1)
  return {
    key, reserve0: r0_, reserve1: r1_,
    lpValue: now, holdValue: held, pnl: now - held,
    pnlBps: held === 0n ? 0n : ((now - held) * 10_000n) / held,
    protocolRevenue: protocol,
    arbCount: stats[key].arbCount, arbProfit: stats[key].arbProfit, volume: stats[key].volume,
  }
}

const A = await report(poolA, 'A', openA)
const B = await report(poolB, 'B', openB)
const fmt = (x) => formatUnits(x, 18, 2)
const pct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`

const row = (label, a, b) => console.log(`${label.padEnd(26)} ${a.padStart(18)} ${b.padStart(18)}`)
console.log(`\x1b[1m${''.padEnd(26)} ${'A: 1:1 stableswap'.padStart(18)} ${'B: rate-anchored'.padStart(18)}\x1b[0m`)
console.log('─'.repeat(64))
row('LP value at close', fmt(A.lpValue), fmt(B.lpValue))
row('value if simply held', fmt(A.holdValue), fmt(B.holdValue))
row('LP profit vs holding', fmt(A.pnl), fmt(B.pnl))
row('  as % of opening', pct(A.pnlBps), pct(B.pnlBps))
console.log('─'.repeat(64))
row('protocol revenue', fmt(A.protocolRevenue), fmt(B.protocolRevenue))
row('volume routed (USDC-in)', formatUnits(A.volume, 6, 0), formatUnits(B.volume, 6, 0))
row('arbitrages taken', String(A.arbCount), String(B.arbCount))
row('lost to arbitrageurs', fmt(A.arbProfit), fmt(B.arbProfit))
console.log('─'.repeat(64))
row('closing USDC', formatUnits(A.reserve0, 6, 0), formatUnits(B.reserve0, 6, 0))
row('closing EURC', formatUnits(A.reserve1, 6, 0), formatUnits(B.reserve1, 6, 0))

const diff = B.pnl - A.pnl
console.log(`\n\x1b[1mDifference: ${fmt(diff)} USDC on a ${fmt(A.holdValue)} book over ${series.length} trading days.\x1b[0m`)
console.log(`Attributable to where the liquidity sits, and to nothing else: same invariant,`)
console.log(`same amplification, same fee, same trades, same code.`)

mkdirSync(join(ROOT, 'results'), { recursive: true })
const out = join(ROOT, `results/simulation-${SCENARIO}-${Number(FEE_PPM) / 100}bp-amp${AMP}.json`)
writeFileSync(out, JSON.stringify({
  scenario: SCENARIO,
  data: { source: fx.source, url: fx.url, days: series.length, from: series[0].date, to: series.at(-1).date },
  params: { amp: String(AMP), feePpm: String(FEE_PPM), protocolSharePpm: String(PROTOCOL_SHARE), organicTradesPerDay: ORGANIC_PER_DAY },
  pools: { A: { ...A, label: '1:1 stableswap' }, B: { ...B, label: 'rate-anchored' } },
}, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1))
console.log(`\nwrote ${out}`)
