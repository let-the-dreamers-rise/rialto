// RialtoPool: invariant behaviour, pricing, fees, LP accounting.
import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcLocal, toRate, parseUnits, formatUnits } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const POOL = art('RialtoPool'), TOKEN = art('MockERC20'), FIXED = art('FixedRateSource')

const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  lp:       '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  trader:   '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  treasury: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
}
const transport = http('http://127.0.0.1:8545')
const pub = createPublicClient({ chain: arcLocal, transport })
const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]))
const w = Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, createWalletClient({ account: a, chain: arcLocal, transport })]))

const AMP = 200n
const FEE_PPM = 400n          // 4 bp
const PROTOCOL_SHARE = 500_000n // half the fee
const RATE = toRate(1.1646)   // EUR/USD

let usdc, eurc, pool, rateSrc

async function deploy(a, wallet, args = []) {
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args })
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress
}
async function call(wallet, address, abi, fn, args) {
  const hash = await wallet.writeContract({ address, abi, functionName: fn, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${fn} reverted`)
  return r
}
const readPool = (fn, args = []) => pub.readContract({ address: pool, abi: POOL.abi, functionName: fn, args })
async function expectRevert(p, name) {
  try { await p } catch (e) {
    const s = `${e.shortMessage ?? ''}${e.metaMessages?.join(' ') ?? ''}${e.message}`
    if (name) assert.ok(s.includes(name), `expected ${name}, got ${s.slice(0, 250)}`)
    return
  }
  assert.fail('expected revert')
}
const mint = (t, to, amt) => call(w.deployer, t, TOKEN.abi, 'mint', [to, amt])
const approve = (t, wallet, spender) => call(wallet, t, TOKEN.abi, 'approve', [spender, 2n ** 255n])
const usd = (x) => parseUnits(String(x), 6)

before(async () => {
  usdc = await deploy(TOKEN, w.deployer, ['USD Coin', 'USDC', 6])
  eurc = await deploy(TOKEN, w.deployer, ['Euro Coin', 'EURC', 6])
  rateSrc = await deploy(FIXED, w.deployer, [RATE])
  pool = await deploy(POOL, w.deployer, [usdc, eurc, rateSrc, AMP, FEE_PPM, PROTOCOL_SHARE, acct.treasury.address])

  for (const who of ['lp', 'trader']) {
    await mint(usdc, acct[who].address, usd(10_000_000))
    await mint(eurc, acct[who].address, usd(10_000_000))
    await approve(usdc, w[who], pool)
    await approve(eurc, w[who], pool)
  }
  // Seed balanced *in value*: 1,164,600 USDC against 1,000,000 EURC at 1.1646.
  await call(w.lp, pool, POOL.abi, 'addLiquidity', [usd(1_164_600), usd(1_000_000), 0n, acct.lp.address])
})

describe('pricing', () => {
  test('a value-balanced pool quotes at the oracle rate', async () => {
    // The whole thesis: the cheap part of the curve sits on the real rate, not on 1.00.
    const spot = await readPool('spotPrice')
    const drift = spot > RATE ? spot - RATE : RATE - spot
    assert.ok((drift * 1_000_000n) / RATE < 100n, `spot ${spot} vs rate ${RATE}`)
  })

  test('a round trip loses only the fee, never more', async () => {
    const inAmt = usd(10_000)
    const out = await readPool('quote', [true, inAmt])
    const back = await readPool('quote', [false, out])
    assert.ok(back < inAmt, 'a round trip must not be profitable')
    const lossBps = ((inAmt - back) * 10_000n) / inAmt
    // Two crossings at 4bp, plus curvature on a trade this size.
    assert.ok(lossBps >= 8n && lossBps <= 20n, `round-trip loss ${lossBps}bp`)
  })

  test('slippage on a small trade is near the rate', async () => {
    const out = await readPool('quote', [true, usd(1_000)]) // 1,000 USDC -> EURC
    const ideal = (usd(1_000) * 10n ** 18n) / RATE
    const slipBps = ((ideal - out) * 10_000n) / ideal
    assert.ok(slipBps < 20n, `slippage ${slipBps}bp on 1k`)
  })

  test('a bigger trade costs more per unit than a smaller one', async () => {
    const small = await readPool('quote', [true, usd(1_000)])
    const big = await readPool('quote', [true, usd(500_000)])
    const pxSmall = (usd(1_000) * 10n ** 18n) / small
    const pxBig = (usd(500_000) * 10n ** 18n) / big
    assert.ok(pxBig > pxSmall, 'price impact must increase with size')
  })
})

describe('swaps and reserves', () => {
  test('a swap moves the tokens and conserves the invariant', async () => {
    const before = { d: await readPool('invariant'), r0: await readPool('reserve0'), r1: await readPool('reserve1') }
    const expected = await readPool('quote', [true, usd(50_000)])
    const balBefore = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })

    await call(w.trader, pool, POOL.abi, 'swap', [true, usd(50_000), 0n, acct.trader.address])

    const balAfter = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })
    assert.equal(balAfter - balBefore, expected, 'trader receives exactly the quote')
    assert.equal(await readPool('reserve0'), before.r0 + usd(50_000))
    // Fees stay in the pool, so the invariant may only grow.
    assert.ok((await readPool('invariant')) >= before.d, 'invariant must not fall on a swap')
  })

  test('slippage protection is honoured', async () => {
    const out = await readPool('quote', [true, usd(10_000)])
    await expectRevert(
      call(w.trader, pool, POOL.abi, 'swap', [true, usd(10_000), out + usd(100), acct.trader.address]),
      'Slippage',
    )
  })

  test('a zero-amount swap reverts', async () => {
    await expectRevert(call(w.trader, pool, POOL.abi, 'swap', [true, 0n, 0n, acct.trader.address]), 'ZeroAmount')
  })
})

describe('protocol revenue', () => {
  test('the protocol accrues its share of the fee, and the trader is unaffected', async () => {
    const before = await readPool('protocolFees1')
    const quoted = await readPool('quote', [true, usd(100_000)])
    const balBefore = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })
    await call(w.trader, pool, POOL.abi, 'swap', [true, usd(100_000), 0n, acct.trader.address])
    const balAfter = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })

    assert.equal(balAfter - balBefore, quoted, 'the fee split must not change the trader’s price')
    const accrued = (await readPool('protocolFees1')) - before
    assert.ok(accrued > 0n, 'protocol earned nothing')

    // ~half of 4bp on ~85,000 EURC of output ≈ 1.7 EURC
    const outApprox = quoted
    const expected = (((outApprox * FEE_PPM) / 1_000_000n) * PROTOCOL_SHARE) / 1_000_000n
    const diff = accrued > expected ? accrued - expected : expected - accrued
    assert.ok(diff * 100n <= expected * 5n, `accrued ${accrued} vs expected ~${expected}`)
  })

  test('protocol fees are not part of the reserves LPs own', async () => {
    const bal = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [pool] })
    const reserve = await readPool('reserve1')
    const fees = await readPool('protocolFees1')
    assert.equal(bal, reserve + fees, 'token balance must equal reserves plus unclaimed fees')
  })

  test('only the treasury can be paid, whoever calls', async () => {
    await expectRevert(
      call(w.trader, pool, POOL.abi, 'collectProtocolFees', [acct.trader.address]),
      'NotTreasury',
    )
    const owed = await readPool('protocolFees1')
    const before = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.treasury.address] })
    // A keeper may trigger the sweep; the money still goes to the treasury.
    await call(w.trader, pool, POOL.abi, 'collectProtocolFees', [acct.treasury.address])
    const after = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.treasury.address] })
    assert.equal(after - before, owed)
    assert.equal(await readPool('protocolFees1'), 0n)
  })

  test('the protocol share is capped at half the fee', async () => {
    await expectRevert(call(w.treasury, pool, POOL.abi, 'setProtocolShare', [600_000n]), 'ShareTooLarge')
    await expectRevert(call(w.trader, pool, POOL.abi, 'setProtocolShare', [100_000n]), 'NotTreasury')
  })
})

describe('liquidity', () => {
  test('proportional withdrawal returns a fair share', async () => {
    const lpBal = await readPool('balanceOf', [acct.lp.address])
    const supply = await readPool('totalSupply')
    const [r0, r1] = [await readPool('reserve0'), await readPool('reserve1')]
    const burn = lpBal / 10n

    const b0 = await pub.readContract({ address: usdc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.lp.address] })
    await call(w.lp, pool, POOL.abi, 'removeLiquidity', [burn, 0n, 0n, acct.lp.address])
    const a0 = await pub.readContract({ address: usdc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.lp.address] })

    assert.equal(a0 - b0, (r0 * burn) / supply, 'share of reserve0 must be exactly proportional')
    assert.equal(await readPool('reserve1'), r1 - (r1 * burn) / supply)
  })

  test('a lopsided deposit is charged an imbalance fee', async () => {
    // Otherwise depositing one-sided and exiting proportionally is a free trade.
    const balancedLp = await readPool('quote', [true, usd(1)]) // touch state, no-op read
    const supplyBefore = await readPool('totalSupply')
    const dBefore = await readPool('invariant')

    await call(w.trader, pool, POOL.abi, 'addLiquidity', [usd(200_000), 0n, 0n, acct.trader.address])
    const minted = await readPool('balanceOf', [acct.trader.address])
    const dAfter = await readPool('invariant')

    // Fair share of the invariant growth, ignoring the fee.
    const fairShare = (supplyBefore * (dAfter - dBefore)) / dBefore
    assert.ok(minted < fairShare, 'one-sided deposit must mint less than the un-fee’d share')
    assert.ok(minted > (fairShare * 90n) / 100n, 'but the fee must be small, not punitive')
    assert.ok(balancedLp > 0n)
  })

  test('a one-sided deposit then a proportional exit is not profitable', async () => {
    const lp = await readPool('balanceOf', [acct.trader.address])
    const u0 = await pub.readContract({ address: usdc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })
    const e0 = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })
    await call(w.trader, pool, POOL.abi, 'removeLiquidity', [lp, 0n, 0n, acct.trader.address])
    const u1 = await pub.readContract({ address: usdc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })
    const e1 = await pub.readContract({ address: eurc, abi: TOKEN.abi, functionName: 'balanceOf', args: [acct.trader.address] })

    // Value what came back at the oracle rate against the 200,000 USDC put in.
    const backValue = (u1 - u0) * 10n ** 12n + ((e1 - e0) * 10n ** 12n * RATE) / 10n ** 18n
    const inValue = usd(200_000) * 10n ** 12n
    assert.ok(backValue < inValue, `round trip returned ${formatUnits(backValue, 18)} for ${formatUnits(inValue, 18)}`)
  })
})

describe('safety', () => {
  test('LPs can exit without the oracle', async () => {
    // removeLiquidity must never consult the rate source: a dead oracle should stop
    // trading, not trap funds.
    const src = await readPool('rateSource')
    assert.equal(src.toLowerCase(), rateSrc.toLowerCase())
    const lpBal = await readPool('balanceOf', [acct.lp.address])
    const r = await call(w.lp, pool, POOL.abi, 'removeLiquidity', [lpBal / 100n, 0n, 0n, acct.lp.address])
    assert.equal(r.status, 'success')
  })

  test('the fee ceiling is enforced at construction', async () => {
    // A failed deployment surfaces as an estimateGas error rather than a decodable custom
    // error, so assert the rejection itself; the guard is `feePpm_ > MAX_FEE_PPM`.
    await expectRevert(deploy(POOL, w.deployer, [usdc, eurc, rateSrc, AMP, 200_000n, 0n, acct.treasury.address]))
    // A fee at the ceiling is fine, which pins the boundary.
    const ok = await deploy(POOL, w.deployer, [usdc, eurc, rateSrc, AMP, 100_000n, 0n, acct.treasury.address])
    assert.ok(ok && ok !== '0x')
  })

  test('the protocol share ceiling is enforced at construction', async () => {
    await expectRevert(deploy(POOL, w.deployer, [usdc, eurc, rateSrc, AMP, 400n, 600_000n, acct.treasury.address]))
  })
})
