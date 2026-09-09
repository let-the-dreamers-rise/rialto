// Cross-currency settlement between currencies that share no pool.
//
// Rates and reserve ratios come from the real ECB observations in the corridor fixture, so
// the amounts below are the amounts a real BRL→PHP payment would involve.
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
const POOL = art('RialtoPool'), TOKEN = art('MockERC20'), FIXED = art('FixedRateSource'), ROUTER = art('RialtoRouter')
const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/fx-corridors-ecb.json'), 'utf8'))

const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  payer:    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  payee:    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
}
const transport = http('http://127.0.0.1:8545')
const pub = createPublicClient({ chain: arcLocal, transport })
const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]))
const w = Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, createWalletClient({ account: a, chain: arcLocal, transport })]))

const AMP = 200n, FEE = 2_500n, SHARE = 500_000n, DEC = 6
const u = (x) => parseUnits(String(Math.round(Number(x) * 1e6) / 1e6), DEC)

// Latest real observations: local currency units per USD.
const BRL_PER_USD = fx.corridors.BRL.last.rate
const PHP_PER_USD = fx.corridors.PHP.last.rate
// The pools quote token0 (USDC) per one unit of token1 (the local currency).
const USD_PER_BRL = 1 / BRL_PER_USD
const USD_PER_PHP = 1 / PHP_PER_USD

let usdc, brl, php, poolBRL, poolPHP, router

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
    if (name) assert.ok(s.includes(name), `expected ${name}, got ${s.slice(0, 200)}`)
    return
  }
  assert.fail('expected revert')
}
const now = async () => Number((await pub.getBlock()).timestamp)

before(async () => {
  usdc = await deploy(TOKEN, w.deployer, ['USD Coin', 'USDC', DEC])
  brl  = await deploy(TOKEN, w.deployer, ['Brazilian Real Coin', 'BRLA', DEC])
  php  = await deploy(TOKEN, w.deployer, ['Philippine Peso Coin', 'PHPC', DEC])
  router = await deploy(ROUTER, w.deployer, [])

  const srcBRL = await deploy(FIXED, w.deployer, [toRate(USD_PER_BRL)])
  const srcPHP = await deploy(FIXED, w.deployer, [toRate(USD_PER_PHP)])
  poolBRL = await deploy(POOL, w.deployer, [usdc, brl, srcBRL, AMP, FEE, SHARE, acct.deployer.address])
  poolPHP = await deploy(POOL, w.deployer, [usdc, php, srcPHP, AMP, FEE, SHARE, acct.deployer.address])

  for (const who of ['deployer', 'payer']) {
    for (const t of [usdc, brl, php]) {
      await call(w.deployer, t, TOKEN.abi, 'mint', [acct[who].address, u(2_000_000_000)])
      for (const sp of [poolBRL, poolPHP, router]) await call(w[who], t, TOKEN.abi, 'approve', [sp, 2n ** 255n])
    }
  }
  // Each pool: 2,000,000 USDC against the equivalent local amount.
  await call(w.deployer, poolBRL, POOL.abi, 'addLiquidity', [u(2_000_000), u(2_000_000 * BRL_PER_USD), 0n, acct.deployer.address])
  await call(w.deployer, poolPHP, POOL.abi, 'addLiquidity', [u(2_000_000), u(2_000_000 * PHP_PER_USD), 0n, acct.deployer.address])
})

// BRL -> USDC : spend token1, receive token0  => zeroForOne = false
// USDC -> PHP : spend token0, receive token1  => zeroForOne = true
const PATH = () => [{ pool: poolBRL, zeroForOne: false }, { pool: poolPHP, zeroForOne: true }]

describe('routing across currencies with no shared pool', () => {
  test('a BRL payer settles a PHP invoice in one transaction', async () => {
    const invoice = u(250_000) // ₱250,000
    const [needed, legs] = await rd(router, ROUTER.abi, 'quoteExactOut', [PATH(), invoice])

    // Sanity against the real cross rate: BRL per PHP = (BRL/USD) / (PHP/USD)
    const crossMid = 250_000 * (BRL_PER_USD / PHP_PER_USD)
    const paidBrl = Number(needed) / 1e6
    assert.ok(paidBrl > crossMid, 'paying below the cross rate would be a free lunch')
    const spreadBps = ((paidBrl - crossMid) / crossMid) * 10_000
    // Two hops, 25bp each, plus curvature.
    assert.ok(spreadBps > 45 && spreadBps < 130, `two-hop all-in spread ${spreadBps.toFixed(1)}bp`)
    assert.equal(legs.length, 2)

    const payeeBefore = await bal(php, acct.payee.address)
    const payerBefore = await bal(brl, acct.payer.address)

    const r = await call(w.payer, router, ROUTER.abi, 'settle', [{
      path: PATH(), payee: acct.payee.address, amountOut: invoice,
      maxAmountIn: needed, deadline: BigInt((await now()) + 600),
      invoiceRef: keccak256(stringToBytes('INV-BR-PH-9001')),
    }])

    assert.equal((await bal(php, acct.payee.address)) - payeeBefore, invoice, 'payee must receive the exact peso amount')
    assert.equal(payerBefore - (await bal(brl, acct.payer.address)), needed, 'payer parts with exactly the quote')

    // The router must not retain anything, in any currency.
    for (const [t, n] of [[usdc,'USDC'],[brl,'BRL'],[php,'PHP']]) {
      assert.equal(await bal(t, router), 0n, `router retained ${n}`)
    }

    const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: ROUTER.abi, data: l.data, topics: l.topics }) } catch { return null } })
      .find((e) => e?.eventName === 'RoutedSettlement')
    assert.ok(ev, 'no RoutedSettlement event')
    assert.equal(ev.args.hops, 2n)
    assert.equal(ev.args.amountOut, invoice)
    assert.equal(ev.args.amountIn, needed)
  })

  test('the reverse direction works too', async () => {
    const invoice = u(100_000) // R$100,000 owed by a Philippine payer
    const path = [{ pool: poolPHP, zeroForOne: false }, { pool: poolBRL, zeroForOne: true }]
    const [needed] = await rd(router, ROUTER.abi, 'quoteExactOut', [path, invoice])
    const before = await bal(brl, acct.payee.address)
    await call(w.payer, router, ROUTER.abi, 'settle', [{
      path, payee: acct.payee.address, amountOut: invoice, maxAmountIn: needed,
      deadline: BigInt((await now()) + 600), invoiceRef: keccak256(stringToBytes('INV-PH-BR-1')),
    }])
    assert.equal((await bal(brl, acct.payee.address)) - before, invoice)
  })

  test('a single-hop route is just a direct settlement', async () => {
    const invoice = u(50_000)
    const path = [{ pool: poolPHP, zeroForOne: true }]
    const [needed] = await rd(router, ROUTER.abi, 'quoteExactOut', [path, invoice])
    const direct = await rd(poolPHP, POOL.abi, 'quoteExactOut', [true, invoice])
    assert.equal(needed, direct, 'routing one hop must not cost more than going direct')
  })

  test('the payer bound covers the whole route, not each leg', async () => {
    const invoice = u(250_000)
    const [needed] = await rd(router, ROUTER.abi, 'quoteExactOut', [PATH(), invoice])
    await expectRevert(call(w.payer, router, ROUTER.abi, 'settle', [{
      path: PATH(), payee: acct.payee.address, amountOut: invoice, maxAmountIn: needed - 1n,
      deadline: BigInt((await now()) + 600), invoiceRef: keccak256(stringToBytes('x')),
    }]), 'TooExpensive')
  })
})

describe('malformed routes are refused', () => {
  test('a disjoint path is rejected', async () => {
    // BRL->USDC then BRL->USDC again: the second leg does not take what the first produced.
    const bad = [{ pool: poolBRL, zeroForOne: false }, { pool: poolPHP, zeroForOne: false }]
    await expectRevert(rd(router, ROUTER.abi, 'quoteExactOut', [bad, u(1_000)]), 'DisjointPath')
  })

  test('a repeated pool is rejected', async () => {
    // Otherwise the second solve would depend on the first leg executing, and the "exact"
    // quote would silently become an estimate.
    const bad = [{ pool: poolBRL, zeroForOne: false }, { pool: poolBRL, zeroForOne: true }]
    await expectRevert(rd(router, ROUTER.abi, 'quoteExactOut', [bad, u(1_000)]), 'NoRepeatedPool')
  })

  test('an empty path is rejected', async () => {
    await expectRevert(rd(router, ROUTER.abi, 'quoteExactOut', [[], u(1_000)]), 'EmptyPath')
  })

  test('an expired instruction is refused', async () => {
    await expectRevert(call(w.payer, router, ROUTER.abi, 'settle', [{
      path: PATH(), payee: acct.payee.address, amountOut: u(1_000), maxAmountIn: u(10_000_000),
      deadline: BigInt((await now()) - 1), invoiceRef: keccak256(stringToBytes('y')),
    }]), 'Expired')
  })

  test('paying nobody is refused', async () => {
    await expectRevert(call(w.payer, router, ROUTER.abi, 'settle', [{
      path: PATH(), payee: '0x0000000000000000000000000000000000000000', amountOut: u(1_000),
      maxAmountIn: u(10_000_000), deadline: BigInt((await now()) + 600), invoiceRef: keccak256(stringToBytes('z')),
    }]), 'ZeroPayee')
  })
})

describe('the combinatorial claim', () => {
  test('N corridors give N(N-1)/2 pairs', () => {
    // Not a property of the code so much as the reason the router exists: two pools here
    // already serve BRL/PHP in both directions without a BRL/PHP pool existing.
    const pairs = (n) => (n * (n - 1)) / 2
    assert.equal(pairs(2), 1)
    assert.equal(pairs(6), 15)   // the six corridors measured in scripts/simulate-corridors
    assert.equal(pairs(8), 28)   // Circle's announced partner stablecoins
  })
})
