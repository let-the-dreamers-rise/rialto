// FX forwards: locking a rate for an invoice with terms.
//
// Sizes and rate paths are taken from the real ECB corridor fixture, so the scenarios are
// moves that actually happened rather than moves chosen to make the contract look good.
import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createWalletClient, createPublicClient, createTestClient, http, decodeEventLog } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcLocal, toRate, parseUnits, formatUnits, pairId, signAttestationQuorum } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const TOKEN = art('MockERC20'), ORACLE = art('RialtoOracle'), FWD = art('RialtoForward')
const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/fx-corridors-ecb.json'), 'utf8'))

const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  pubB:     '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  importer: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // taker
  writer:   '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
}
const transport = http('http://127.0.0.1:8545')
const pub = createPublicClient({ chain: arcLocal, transport })
const tc = createTestClient({ chain: arcLocal, transport, mode: 'hardhat' })
const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]))
const w = Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, createWalletClient({ account: a, chain: arcLocal, transport })]))
const u = (x) => parseUnits(String(Math.round(Number(x) * 1e6) / 1e6), 6)

const BRL = fx.corridors.BRL
// Each position gets its own pair. The oracle bounds how far one print may move a feed,
// so tests sharing a single feed would inherit whatever rate the previous test left behind
// and fail on the deviation cap rather than on the behaviour under test.
let pairSeq = 0
const nextPair = () => pairId(`USD/BRL#${++pairSeq}`)
// token0-per-token1: USD per BRL.
const usdPerBrl = (brlPerUsd) => 1 / brlPerUsd
const SPOT0 = usdPerBrl(BRL.last.rate)          // ~0.196
const DAY = 86_400

let usdc, oracle, fwd

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
const bal = (who) => rd(usdc, TOKEN.abi, 'balanceOf', [who])
async function expectRevert(p, name) {
  try { await p } catch (e) {
    const s = `${e.shortMessage ?? ''}${e.metaMessages?.join(' ') ?? ''}${e.message}`
    if (name) assert.ok(s.includes(name), `expected ${name}, got ${s.slice(0, 220)}`)
    return
  }
  assert.fail('expected revert')
}
const now = async () => Number((await pub.getBlock()).timestamp)

async function post(rate, pair) {
  const observedAt = BigInt(await now())
  const att = { pair, rate: toRate(rate), observedAt }
  const sigs = await signAttestationQuorum({
    signers: [{ walletClient: w.deployer, account: acct.deployer }, { walletClient: w.pubB, account: acct.pubB }],
    chainId: arcLocal.id, oracle, attestation: att,
  })
  await call(w.deployer, oracle, ORACLE.abi, 'submit', [att, sigs])
}

before(async () => {
  usdc = await deploy(TOKEN, w.deployer, ['USD Coin', 'USDC', 6])
  oracle = await deploy(ORACLE, w.deployer, [[acct.deployer.address, acct.pubB.address], 2n, acct.deployer.address])
  fwd = await deploy(FWD, w.deployer, [usdc, oracle])
  for (const who of ['importer', 'writer']) {
    await call(w.deployer, usdc, TOKEN.abi, 'mint', [acct[who].address, u(10_000_000)])
    await call(w[who], usdc, TOKEN.abi, 'approve', [fwd, 2n ** 255n])
  }
})

// A Brazilian importer owes R$1,000,000 in 30 days and wants to fix its dollar cost.
const NOTIONAL = u(1_000_000)
const STRIKE = toRate(SPOT0)
const MARGIN = u(40_000) // ~20% of the ~196k USD notional value

async function openAndTake({ strike = STRIKE, days = 30, wm = MARGIN, tm = MARGIN } = {}) {
  const pair = nextPair()
  await post(SPOT0, pair)
  const maturity = BigInt((await now()) + days * DAY)
  const r = await call(w.writer, fwd, FWD.abi, 'offer', [pair, NOTIONAL, strike, maturity, wm])
  const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: FWD.abi, data: l.data, topics: l.topics }) } catch { return null } }).find((e) => e?.eventName === 'Offered')
  const id = ev.args.id
  await call(w.importer, fwd, FWD.abi, 'take', [id, tm])
  return { id, pair }
}

describe('locking a rate', () => {
  test('an importer locks, the real move happens, and the lock pays', async () => {
    const { id, pair } = await openAndTake()
    const [takerCover, writerCover] = await rd(fwd, FWD.abi, 'coveredMoveBps', [id])
    assert.ok(takerCover > 1500n && writerCover > 1500n, `should cover a >15% move, got ${takerCover}/${writerCover}`)

    // BRL weakens to its worst level in the observed year: the importer's dollars buy more
    // reais, so the lock costs them — exactly the case a hedger accepts.
    const worst = usdPerBrl(BRL.max)
    const takerBefore = await bal(acct.importer.address)
    const writerBefore = await bal(acct.writer.address)

    await tc.increaseTime({ seconds: 31 * DAY }); await tc.mine({ blocks: 1 })
    await post(worst, pair)
    await call(w.importer, fwd, FWD.abi, 'settle', [id])

    const pnl = Number((await bal(acct.importer.address)) - takerBefore) / 1e6 - Number(MARGIN) / 1e6
    const writerPnl = Number((await bal(acct.writer.address)) - writerBefore) / 1e6 - Number(MARGIN) / 1e6
    assert.ok(Math.abs(pnl + writerPnl) < 1, 'the contract is zero-sum between the parties')
    // BRL/USD fell here, so the taker (long BRL) loses and the writer gains.
    assert.ok(pnl < 0 && writerPnl > 0, `taker ${pnl}, writer ${writerPnl}`)
  })

  test('when the currency moves the other way, the lock pays the importer', async () => {
    const { id, pair } = await openAndTake()
    const best = usdPerBrl(BRL.min) // BRL strengthens: the importer needed the hedge
    const before = await bal(acct.importer.address)
    await tc.increaseTime({ seconds: 31 * DAY }); await tc.mine({ blocks: 1 })
    await post(best, pair)
    await call(w.importer, fwd, FWD.abi, 'settle', [id])
    const gained = Number((await bal(acct.importer.address)) - before) / 1e6 - Number(MARGIN) / 1e6
    assert.ok(gained > 0, `hedge should have paid, got ${gained}`)
    // Sanity: the payout equals notional x rate move, within rounding.
    const expected = 1_000_000 * (usdPerBrl(BRL.min) - SPOT0)
    assert.ok(Math.abs(gained - expected) < 1, `payout ${gained} vs expected ${expected}`)
  })

  test('settlement is exactly zero-sum and conserves collateral', async () => {
    const { id, pair } = await openAndTake()
    const pot = MARGIN * 2n
    const t0 = await bal(acct.importer.address), w0 = await bal(acct.writer.address)
    await tc.increaseTime({ seconds: 31 * DAY }); await tc.mine({ blocks: 1 })
    await post(SPOT0 * 1.02, pair)
    await call(w.writer, fwd, FWD.abi, 'settle', [id])
    const paid = ((await bal(acct.importer.address)) - t0) + ((await bal(acct.writer.address)) - w0)
    assert.equal(paid, pot, 'every unit of collateral must come back out')
    assert.equal(await bal(fwd), 0n, 'the contract must not retain collateral')
  })
})

describe('bounded loss', () => {
  test('a move past the collateral is capped, and says so', async () => {
    const { id, pair } = await openAndTake({ wm: u(2_000), tm: u(2_000) }) // deliberately thin margin
    await tc.increaseTime({ seconds: 31 * DAY }); await tc.mine({ blocks: 1 })
    await post(SPOT0 * 1.2, pair) // +20%: worth ~39k USD on this notional, far past 2k of margin
    const t0 = await bal(acct.importer.address)
    const r = await call(w.importer, fwd, FWD.abi, 'settle', [id])
    const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: FWD.abi, data: l.data, topics: l.topics }) } catch { return null } }).find((e) => e?.eventName === 'Settled')
    assert.equal(ev.args.capped, true, 'a move past the collateral must be flagged as capped')
    const got = (await bal(acct.importer.address)) - t0
    assert.equal(got, u(4_000), 'the winner takes the whole pot and no more')
  })

  test('nobody can lose more than they posted', async () => {
    const { id, pair } = await openAndTake({ wm: u(2_000), tm: u(2_000) })
    await tc.increaseTime({ seconds: 31 * DAY }); await tc.mine({ blocks: 1 })
    await post(SPOT0 * 0.85, pair)
    const t0 = await bal(acct.importer.address)
    await call(w.writer, fwd, FWD.abi, 'settle', [id])
    assert.equal((await bal(acct.importer.address)) - t0, 0n, 'taker loses their margin, not a cent more')
  })
})

describe('lifecycle and access', () => {
  test('an unfilled offer can be cancelled and the margin returned', async () => {
    const maturity = BigInt((await now()) + 30 * DAY)
    const before = await bal(acct.writer.address)
    const r = await call(w.writer, fwd, FWD.abi, 'offer', [nextPair(), NOTIONAL, STRIKE, maturity, MARGIN])
    const id = r.logs.map((l) => { try { return decodeEventLog({ abi: FWD.abi, data: l.data, topics: l.topics }) } catch { return null } }).find((e) => e?.eventName === 'Offered').args.id
    await call(w.writer, fwd, FWD.abi, 'cancel', [id])
    assert.equal(await bal(acct.writer.address), before)
  })

  test('a filled offer cannot be cancelled', async () => {
    const { id, pair } = await openAndTake()
    await expectRevert(call(w.writer, fwd, FWD.abi, 'cancel', [id]), 'AlreadyTaken')
  })

  test('settling before maturity is refused', async () => {
    const { id, pair } = await openAndTake()
    await expectRevert(call(w.importer, fwd, FWD.abi, 'settle', [id]), 'NotYetMature')
  })

  test('a stranger cannot settle during the grace period, but can after it', async () => {
    const { id, pair } = await openAndTake()
    // Just past maturity, still inside the one-day grace.
    await tc.increaseTime({ seconds: 30 * DAY + 3600 }); await tc.mine({ blocks: 1 })
    await post(SPOT0, pair)
    await expectRevert(call(w.deployer, fwd, FWD.abi, 'settle', [id]), 'NotParty')
    // Past the grace period anyone may close it, so a losing side cannot strand the trade.
    await tc.increaseTime({ seconds: 2 * DAY }); await tc.mine({ blocks: 1 })
    await post(SPOT0, pair)
    const r = await call(w.deployer, fwd, FWD.abi, 'settle', [id])
    assert.equal(r.status, 'success')
  })

  test('a position cannot be settled twice', async () => {
    const { id, pair } = await openAndTake()
    await tc.increaseTime({ seconds: 31 * DAY }); await tc.mine({ blocks: 1 })
    await post(SPOT0, pair)
    await call(w.importer, fwd, FWD.abi, 'settle', [id])
    await expectRevert(call(w.importer, fwd, FWD.abi, 'settle', [id]), 'AlreadySettled')
  })
})

describe('early close', () => {
  test('a healthy position cannot be liquidated', async () => {
    const { id, pair } = await openAndTake()
    await post(SPOT0 * 1.01, pair)
    await expectRevert(call(w.deployer, fwd, FWD.abi, 'liquidate', [id]), 'NotLiquidatable')
  })

  test('a position whose margin is nearly gone can be closed early by anyone', async () => {
    const { id, pair } = await openAndTake({ wm: u(5_000), tm: u(5_000) })
    // ~+2.6% is worth ~5,100 USD on this notional: past the writer's 5,000 of margin.
    await post(SPOT0 * 1.026, pair)
    const before = await bal(acct.importer.address)
    const r = await call(w.deployer, fwd, FWD.abi, 'liquidate', [id])
    assert.equal(r.status, 'success')
    assert.ok((await bal(acct.importer.address)) - before > 0n, 'the winner is paid out on liquidation')
    assert.equal((await rd(fwd, FWD.abi, 'get', [id])).settled, true)
  })
})
