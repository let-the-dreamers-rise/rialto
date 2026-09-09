// The claim this project actually rests on, tested across every corridor.
//
// EUR/USD is the friendly case: it trades near 1.16, so a stableswap centred at 1.00 is
// merely wrong. The corridors that matter for stablecoin payments are not near 1. Circle
// has announced partner stablecoins in BRL, MXN, PHP, ZAR, JPY, KRW, CAD and AUD; the
// biggest remittance corridors in the world run to INR, PHP, MXN and NGN. Those trade at
// 5, 16, 63, 94 to the dollar.
//
// A stableswap centred at 1.00 does not merely misprice those. It cannot hold them.
//
// Same two pools as scripts/simulate.mjs — identical invariant, amplification, fee and
// trades, differing only in where liquidity sits — run over a year of real ECB
// observations for each corridor. Sampled weekly rather than daily to keep six corridors
// tractable; the arbitrageur and the retail flow are otherwise unchanged.
import { createWalletClient, createPublicClient, createTestClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  arcLocal, pairId, toRate, parseUnits, formatUnits,
  signAttestationQuorum, valueReserves, bestArb,
} from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const POOL = art('RialtoPool'), TOKEN = art('MockERC20')
const ORACLE = art('RialtoOracle'), FIXED = art('FixedRateSource'), ORACLE_SRC = art('OracleRateSource')

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

const AMP = 200n
const FEE_PPM = BigInt(process.env.FEE_PPM ?? 2_500)
const PROTOCOL_SHARE = 500_000n
const DEC = 6
const USDC_SEED = 1_000_000
const ORGANIC_PER_STEP = 4

const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/fx-corridors-ecb.json'), 'utf8'))
const only = process.argv[2]

async function tx(w, address, abi, fn, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      const nonce = await pub.getTransactionCount({ address: w.account.address, blockTag: 'pending' })
      const hash = await w.writeContract({ address, abi, functionName: fn, args, nonce })
      const r = await pub.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error(`${fn} reverted`)
      return r
    } catch (e) {
      const m = `${e?.details ?? ''}${e?.shortMessage ?? ''}${e?.message ?? ''}`
      if (attempt < 5 && /nonce/i.test(m)) { await new Promise((r) => setTimeout(r, 30)); continue }
      throw e
    }
  }
}
const rd = (a_, abi, fn, args = []) => pub.readContract({ address: a_, abi, functionName: fn, args })
async function deploy(a_, args = []) {
  const hash = await wDeployer.deployContract({ abi: a_.abi, bytecode: a_.bytecode, args })
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress
}
const units = (x) => parseUnits(String(Math.round(Number(x) * 1e6) / 1e6), DEC)

/** token0 (USD) per one unit of token1 (the local currency). */
const toToken0PerToken1 = (key, r) => (key === 'EUR' ? r : 1 / r)

async function runCorridor(key, c) {
  const pairName = c.pair
  const PAIR = pairId(pairName)
  const series = c.rates.filter((_, i) => i % 5 === 0) // weekly
  const r0 = toToken0PerToken1(key, series[0].rate)

  const usdc = await deploy(TOKEN, ['USD Coin', 'USDC', DEC])
  const local = await deploy(TOKEN, [pairName, key, DEC])
  const oracle = await deploy(ORACLE, [[pubA.address, pubB.address], 2n, deployer.address])
  const srcAnchored = await deploy(ORACLE_SRC, [oracle, PAIR, 30n * 86400n])
  const srcFixed = await deploy(FIXED, [toRate(1)])

  const post = async (rate) => {
    const observedAt = BigInt((await pub.getBlock()).timestamp)
    const att = { pair: PAIR, rate: toRate(rate), observedAt }
    const sigs = await signAttestationQuorum({
      signers: [{ walletClient: wPubA, account: pubA }, { walletClient: wPubB, account: pubB }],
      chainId: arcLocal.id, oracle, attestation: att,
    })
    await tx(wPubA, oracle, ORACLE.abi, 'submit', [att, sigs])
  }
  await post(r0)

  const poolA = await deploy(POOL, [usdc, local, srcFixed, AMP, FEE_PPM, PROTOCOL_SHARE, deployer.address])
  const poolB = await deploy(POOL, [usdc, local, srcAnchored, AMP, FEE_PPM, PROTOCOL_SHARE, deployer.address])

  const localSeed = USDC_SEED / r0            // equal value on both sides
  const supply = units(Math.max(USDC_SEED, localSeed) * 500)
  for (const who of [deployer, trader]) {
    await tx(wDeployer, usdc, TOKEN.abi, 'mint', [who.address, supply])
    await tx(wDeployer, local, TOKEN.abi, 'mint', [who.address, supply])
  }
  for (const w of [wDeployer, wTrader]) {
    for (const t of [usdc, local]) for (const p of [poolA, poolB]) {
      await tx(w, t, TOKEN.abi, 'approve', [p, 2n ** 255n])
    }
  }

  const seedU = units(USDC_SEED), seedL = units(localSeed)
  const opened = { A: false, B: false }
  for (const [p, k] of [[poolA, 'A'], [poolB, 'B']]) {
    try { await tx(wDeployer, p, POOL.abi, 'addLiquidity', [seedU, seedL, 0n, deployer.address]); opened[k] = true }
    catch { /* a 1:1 curve may not even accept this basket */ }
  }
  if (!opened.B) return { pair: pairName, error: 'rate-anchored pool would not open' }

  const openA = opened.A
    ? { r0: await rd(poolA, POOL.abi, 'reserve0'), r1: await rd(poolA, POOL.abi, 'reserve1') }
    : { r0: seedU, r1: seedL }
  const openB = { r0: await rd(poolB, POOL.abi, 'reserve0'), r1: await rd(poolB, POOL.abi, 'reserve1') }

  let seed = 42
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const stats = { A: { arb: 0n, vol: 0n }, B: { arb: 0n, vol: 0n } }

  async function arbitrage(pool, k, marketRate) {
    let best
    try {
      best = await bestArb({
        quote: (z, amt) => rd(pool, POOL.abi, 'quote', [z, amt]),
        marketRate: toRate(marketRate), maxIn: units(USDC_SEED * 3), dec0: DEC, dec1: DEC,
        spotPrice: () => rd(pool, POOL.abi, 'spotPrice'),
      })
    } catch { return }
    if (best.profit <= 0n || best.amountIn <= 0n) return
    try {
      await tx(wTrader, pool, POOL.abi, 'swap', [best.zeroForOne, best.amountIn, 0n, trader.address])
      stats[k].arb += best.profit; stats[k].vol += best.amountIn
    } catch { /* pool cannot support it */ }
  }
  async function organic(pool, k, rate) {
    for (let i = 0; i < ORGANIC_PER_STEP; i++) {
      const z = rnd() < 0.5
      const usdSize = 5_000 + Math.floor(rnd() * 20_000)
      const size = units(z ? usdSize : usdSize / rate)
      try { await tx(wTrader, pool, POOL.abi, 'swap', [z, size, 0n, trader.address]); stats[k].vol += size } catch {}
    }
  }

  for (const [i, day] of series.entries()) {
    const rate = toToken0PerToken1(key, day.rate)
    await tc.increaseTime({ seconds: 7 * 86_400 })
    await tc.mine({ blocks: 1 })
    if (i > 0) { try { await post(rate) } catch { /* cap refused; feed holds */ } }
    await arbitrage(poolB, 'B', rate)
    if (opened.A) await arbitrage(poolA, 'A', rate)
    const s = seed
    await organic(poolB, 'B', rate)
    seed = s
    if (opened.A) await organic(poolA, 'A', rate)
  }

  const finalRate = toRate(toToken0PerToken1(key, series.at(-1).rate))
  const v = (a_, b_) => valueReserves({ reserve0: a_, reserve1: b_, dec0: DEC, dec1: DEC, rate: finalRate })
  const rep = async (pool, k, open, ok) => {
    if (!ok) return { openedPool: false }
    const x = await rd(pool, POOL.abi, 'reserve0'), y = await rd(pool, POOL.abi, 'reserve1')
    const held = v(open.r0, open.r1), now = v(x, y)
    return {
      openedPool: true, reserve0: x, reserve1: y, lpValue: now, holdValue: held,
      pnlBps: held === 0n ? 0n : ((now - held) * 10_000n) / held,
      arbLoss: stats[k].arb, volume: stats[k].vol,
      protocolRevenue: v(await rd(pool, POOL.abi, 'protocolFees0'), await rd(pool, POOL.abi, 'protocolFees1')),
    }
  }
  return {
    pair: pairName, rate0: r0, steps: series.length,
    rangePct: c.range_pct,
    A: await rep(poolA, 'A', openA, opened.A),
    B: await rep(poolB, 'B', openB, true),
  }
}

const results = []
const keys = only ? [only] : Object.keys(fx.corridors)
for (const key of keys) {
  const c = fx.corridors[key]
  process.stdout.write(`running ${c.pair} ... `)
  const t0 = Date.now()
  try {
    const r = await runCorridor(key, c)
    results.push(r)
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`)
  } catch (e) {
    console.log(`FAILED: ${String(e.shortMessage ?? e.message).slice(0, 90)}`)
    results.push({ pair: c.pair, error: String(e.shortMessage ?? e.message).slice(0, 120) })
  }
}

const pct = (b) => `${(Number(b) / 100).toFixed(2)}%`
console.log(`\n\x1b[1mLP outcome over one year, by corridor (fee ${Number(FEE_PPM) / 100}bp, amp ${AMP})\x1b[0m`)
console.log('─'.repeat(78))
console.log(`${'corridor'.padEnd(11)}${'rate'.padStart(10)}${'range'.padStart(8)}${'1:1 pool'.padStart(16)}${'rate-anchored'.padStart(16)}${'lost to arb (1:1)'.padStart(17)}`)
console.log('─'.repeat(78))
for (const r of results) {
  if (r.error) { console.log(`${r.pair.padEnd(11)}${'—'.padStart(10)}  ${r.error}`); continue }
  const a = r.A.openedPool ? pct(r.A.pnlBps) : 'CANNOT OPEN'
  const arb = r.A.openedPool ? formatUnits(r.A.arbLoss, 18, 0) : '—'
  const rateStr = r.rate0 < 0.01 ? r.rate0.toExponential(2) : r.rate0.toFixed(4)
  console.log(`${r.pair.padEnd(11)}${rateStr.padStart(10)}${(r.rangePct + '%').padStart(8)}${a.padStart(16)}${pct(r.B.pnlBps).padStart(16)}${arb.padStart(17)}`)
}
console.log('─'.repeat(78))

mkdirSync(join(ROOT, 'results'), { recursive: true })
const out = join(ROOT, `results/corridors-${Number(FEE_PPM) / 100}bp.json`)
writeFileSync(out, JSON.stringify({ source: fx.source, url: fx.url, params: { amp: String(AMP), feePpm: String(FEE_PPM), sampling: 'weekly' }, results },
  (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1))
console.log(`\nwrote ${out}`)
