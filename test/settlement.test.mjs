// Exact-output pricing and invoice settlement.
import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createWalletClient, createPublicClient, http, keccak256, stringToBytes, decodeEventLog } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcLocal, toRate, parseUnits, formatUnits } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const POOL = art('RialtoPool'), TOKEN = art('MockERC20'), FIXED = art('FixedRateSource')
const SETTLE = art('RialtoSettlement')

const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  payer:    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  payee:    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  treasury: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
}
const transport = http('http://127.0.0.1:8545')
const pub = createPublicClient({ chain: arcLocal, transport })
const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]))
const w = Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, createWalletClient({ account: a, chain: arcLocal, transport })]))

const AMP = 200n
const FEE_PPM = 2_500n           // 25 bp — priced as an FX provider, not a DEX
const PROTOCOL_SHARE = 500_000n
const RATE = toRate(1.1646)
const usd = (x) => parseUnits(String(x), 6)

let usdc, eurc, pool, settlement

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
const rd = (address, abi, fn, args = []) => pub.readContract({ address, abi, functionName: fn, args })
const bal = (t, who) => rd(t, TOKEN.abi, 'balanceOf', [who])
async function expectRevert(p, name) {
  try { await p } catch (e) {
    const s = `${e.shortMessage ?? ''}${e.metaMessages?.join(' ') ?? ''}${e.message}`
    if (name) assert.ok(s.includes(name), `expected ${name}, got ${s.slice(0, 250)}`)
    return
  }
  assert.fail('expected revert')
}
const now = async () => Number((await pub.getBlock()).timestamp)

before(async () => {
  usdc = await deploy(TOKEN, w.deployer, ['USD Coin', 'USDC', 6])
  eurc = await deploy(TOKEN, w.deployer, ['Euro Coin', 'EURC', 6])
  const src = await deploy(FIXED, w.deployer, [RATE])
  pool = await deploy(POOL, w.deployer, [usdc, eurc, src, AMP, FEE_PPM, PROTOCOL_SHARE, acct.treasury.address])
  settlement = await deploy(SETTLE, w.deployer, [])

  for (const who of ['deployer', 'payer']) {
    await call(w.deployer, usdc, TOKEN.abi, 'mint', [acct[who].address, usd(20_000_000)])
    await call(w.deployer, eurc, TOKEN.abi, 'mint', [acct[who].address, usd(20_000_000)])
    for (const t of [usdc, eurc]) for (const sp of [pool, settlement]) {
      await call(w[who], t, TOKEN.abi, 'approve', [sp, 2n ** 255n])
    }
  }
  await call(w.deployer, pool, POOL.abi, 'addLiquidity', [usd(1_164_600), usd(1_000_000), 0n, acct.deployer.address])
})

describe('exact-output pricing', () => {
  test('quoting for an exact output round-trips against the exact-input quote', async () => {
    const want = usd(5_000)                                   // EUR 5,000 invoice
    const needed = await rd(pool, POOL.abi, 'quoteExactOut', [true, want])
    const delivered = await rd(pool, POOL.abi, 'quote', [true, needed])
    // Rounding is against the payer, so paying `needed` delivers at least `want`.
    assert.ok(delivered >= want, `exact-out under-delivers: ${delivered} < ${want}`)
    assert.ok(delivered - want < usd(1), `rounding drift too large: ${formatUnits(delivered - want, 6)}`)
  })

  test('the cost is near the rate plus the fee, and never below it', async () => {
    const want = usd(10_000)
    const needed = await rd(pool, POOL.abi, 'quoteExactOut', [true, want])
    const atRate = (want * RATE) / 10n ** 18n
    assert.ok(needed > atRate, 'paying less than the raw rate would mean a free lunch')
    const spreadBps = ((needed - atRate) * 10_000n) / atRate
    assert.ok(spreadBps >= 25n && spreadBps <= 60n, `all-in spread ${spreadBps}bp`)
  })

  test('both directions work', async () => {
    const needEur = await rd(pool, POOL.abi, 'quoteExactOut', [false, usd(5_000)]) // pay EURC, deliver USDC
    assert.ok(needEur > 0n && needEur < usd(5_000), 'EURC needed for 5,000 USDC should be under 5,000')
  })

  test('asking for more than the pool holds reverts', async () => {
    await expectRevert(rd(pool, POOL.abi, 'quoteExactOut', [true, usd(50_000_000)]), 'InsufficientLiquidity')
  })

  test('swapExactOut delivers exactly the requested amount', async () => {
    const want = usd(2_500)
    const before = await bal(eurc, acct.payee.address)
    const maxIn = (await rd(pool, POOL.abi, 'quoteExactOut', [true, want])) * 101n / 100n
    await call(w.payer, pool, POOL.abi, 'swapExactOut', [true, want, maxIn, acct.payee.address])
    assert.equal((await bal(eurc, acct.payee.address)) - before, want, 'payee must receive the exact amount')
  })

  test('the input bound is enforced', async () => {
    const want = usd(2_500)
    const needed = await rd(pool, POOL.abi, 'quoteExactOut', [true, want])
    await expectRevert(
      call(w.payer, pool, POOL.abi, 'swapExactOut', [true, want, needed - 1n, acct.payee.address]),
      'Slippage',
    )
  })
})

describe('settling an invoice', () => {
  const ref = keccak256(stringToBytes('INV-2026-114'))

  const instruction = async (over = {}) => ({
    pool, payee: acct.payee.address, zeroForOne: true,
    amountOut: usd(5_000), maxAmountIn: usd(6_500),
    deadline: BigInt((await now()) + 600), invoiceRef: ref,
    ...over,
  })

  test('the payee receives exactly the invoiced amount, from the payer’s currency', async () => {
    const i = await instruction()
    const payeeBefore = await bal(eurc, acct.payee.address)
    const payerBefore = await bal(usdc, acct.payer.address)

    const r = await call(w.payer, settlement, SETTLE.abi, 'settle', [i])

    assert.equal((await bal(eurc, acct.payee.address)) - payeeBefore, usd(5_000))
    const spent = payerBefore - (await bal(usdc, acct.payer.address))
    assert.ok(spent > 0n && spent <= i.maxAmountIn)

    // The settlement contract must not retain anything.
    assert.equal(await bal(usdc, settlement), 0n, 'settlement held USDC')
    assert.equal(await bal(eurc, settlement), 0n, 'settlement held EURC')

    const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: SETTLE.abi, data: l.data, topics: l.topics }) } catch { return null } })
      .find((e) => e?.eventName === 'InvoiceSettled')
    assert.ok(ev, 'no InvoiceSettled event')
    assert.equal(ev.args.invoiceRef, ref)
    assert.equal(ev.args.payer.toLowerCase(), acct.payer.address.toLowerCase())
    assert.equal(ev.args.payee.toLowerCase(), acct.payee.address.toLowerCase())
    assert.equal(ev.args.amountOut, usd(5_000))
    assert.equal(ev.args.amountIn, spent)
  })

  test('the published effective rate is the one the payer actually got', async () => {
    const i = await instruction({ amountOut: usd(1_000) })
    const r = await call(w.payer, settlement, SETTLE.abi, 'settle', [i])
    const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: SETTLE.abi, data: l.data, topics: l.topics }) } catch { return null } })
      .find((e) => e?.eventName === 'InvoiceSettled')
    const recomputed = (ev.args.amountIn * 10n ** 18n) / ev.args.amountOut
    assert.equal(ev.args.effectiveRate, recomputed)
    // All-in cost sits just above the mid rate, by roughly the fee.
    const overBps = ((ev.args.effectiveRate - RATE) * 10_000n) / RATE
    assert.ok(overBps > 0n && overBps < 100n, `effective spread ${overBps}bp over mid`)
  })

  test('an expired instruction is refused', async () => {
    const i = await instruction({ deadline: BigInt((await now()) - 1) })
    await expectRevert(call(w.payer, settlement, SETTLE.abi, 'settle', [i]), 'Expired')
  })

  test('an instruction that would cost more than the bound is refused', async () => {
    const needed = await rd(pool, POOL.abi, 'quoteExactOut', [true, usd(5_000)])
    const i = await instruction({ maxAmountIn: needed - 1n })
    await expectRevert(call(w.payer, settlement, SETTLE.abi, 'settle', [i]), 'TooExpensive')
  })

  test('paying nobody is refused', async () => {
    const i = await instruction({ payee: '0x0000000000000000000000000000000000000000' })
    await expectRevert(call(w.payer, settlement, SETTLE.abi, 'settle', [i]), 'ZeroPayee')
  })

  test('a zero invoice is refused', async () => {
    const i = await instruction({ amountOut: 0n })
    await expectRevert(call(w.payer, settlement, SETTLE.abi, 'settle', [i]), 'ZeroAmount')
  })

  test('quote and settle agree', async () => {
    const q = await rd(settlement, SETTLE.abi, 'quote', [pool, true, usd(3_000)])
    const i = await instruction({ amountOut: usd(3_000), maxAmountIn: q })
    const r = await call(w.payer, settlement, SETTLE.abi, 'settle', [i])
    assert.equal(r.status, 'success', 'a settle at exactly the quoted price must succeed')
  })

  test('settling the other direction pays a USDC invoice out of EURC', async () => {
    const i = await instruction({ zeroForOne: false, amountOut: usd(4_000), maxAmountIn: usd(4_000) })
    const before = await bal(usdc, acct.payee.address)
    await call(w.payer, settlement, SETTLE.abi, 'settle', [i])
    assert.equal((await bal(usdc, acct.payee.address)) - before, usd(4_000))
  })
})
