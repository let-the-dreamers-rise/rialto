// RialtoOracle, against a real EVM node over JSON-RPC.
import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createWalletClient, createPublicClient, createTestClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcLocal, pairId, toRate, signAttestation, signAttestationQuorum } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const ORACLE = art('RialtoOracle')

const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
]
const transport = http('http://127.0.0.1:8545')
const pub = createPublicClient({ chain: arcLocal, transport })
const tc = createTestClient({ chain: arcLocal, transport, mode: 'hardhat' })
const accounts = KEYS.map(privateKeyToAccount)
const wallets = accounts.map((a) => createWalletClient({ account: a, chain: arcLocal, transport }))

// publishers: accounts 0,1,2 ; quorum 2. account 3 is an outsider.
const PUBS = accounts.slice(0, 3)
const EURUSD = pairId('EUR/USD')
let oracle

const read = (fn, args) => pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: fn, args })
async function send(w, fn, args) {
  const hash = await w.writeContract({ address: oracle, abi: ORACLE.abi, functionName: fn, args })
  return pub.waitForTransactionReceipt({ hash })
}
/** Assert a call reverts, optionally with one of the named custom errors. */
async function expectRevert(p, name) {
  const names = name == null ? null : (Array.isArray(name) ? name : [name])
  try { await p } catch (e) {
    const s = `${e.shortMessage ?? ''}${e.metaMessages?.join(' ') ?? ''}${e.message}`
    if (names) assert.ok(names.some((n) => s.includes(n)), `expected one of ${names.join('/')}, got: ${s.slice(0, 300)}`)
    return
  }
  assert.fail('expected revert')
}
const now = async () => Number((await pub.getBlock()).timestamp)

async function attest({ rate, observedAt, signers = [0, 1] }) {
  const attestation = { pair: EURUSD, rate: toRate(rate), observedAt: BigInt(observedAt) }
  const sigs = await signAttestationQuorum({
    signers: signers.map((i) => ({ walletClient: wallets[i], account: accounts[i] })),
    chainId: arcLocal.id, oracle, attestation,
  })
  return { attestation, sigs }
}

before(async () => {
  const hash = await wallets[0].deployContract({
    abi: ORACLE.abi, bytecode: ORACLE.bytecode,
    args: [PUBS.map((a) => a.address), 2n, accounts[0].address],
  })
  oracle = (await pub.waitForTransactionReceipt({ hash })).contractAddress
})

describe('publishing a rate', () => {
  test('a quorum of publishers sets the rate', async () => {
    const t = await now()
    const { attestation, sigs } = await attest({ rate: 1.1646, observedAt: t })
    await send(wallets[3], 'submit', [attestation, sigs]) // relayed by a non-publisher
    const [rate, observedAt] = await read('getRate', [EURUSD, 3600n])
    assert.equal(rate, toRate(1.1646))
    assert.equal(observedAt, BigInt(t))
  })

  test('anyone may relay — only signatures count', async () => {
    // Already proven above: account 3 is not a publisher yet the submission stood.
    assert.equal(await read('isPublisher', [accounts[3].address]), false)
  })

  test('one publisher alone cannot move the rate', async () => {
    const t = await now()
    const { attestation, sigs } = await attest({ rate: 1.17, observedAt: t + 1, signers: [0] })
    await expectRevert(send(wallets[0], 'submit', [attestation, sigs]), 'QuorumNotMet')
  })

  test('a non-publisher signature does not count toward quorum', async () => {
    const t = await now()
    const { attestation, sigs } = await attest({ rate: 1.17, observedAt: t + 1, signers: [0, 3] })
    await expectRevert(send(wallets[0], 'submit', [attestation, sigs]), 'QuorumNotMet')
  })

  test('the same publisher signing twice cannot fake a quorum', async () => {
    const t = await now()
    const a = { pair: EURUSD, rate: toRate(1.17), observedAt: BigInt(t + 1) }
    const sig = await signAttestation({ walletClient: wallets[0], account: accounts[0], chainId: arcLocal.id, oracle, attestation: a })
    await expectRevert(send(wallets[0], 'submit', [a, [sig, sig]]), 'UnsortedSigners')
  })

  test('a tampered rate invalidates the signatures', async () => {
    const t = await now()
    const { attestation, sigs } = await attest({ rate: 1.1646, observedAt: t + 2 })
    await expectRevert(
      send(wallets[0], 'submit', [{ ...attestation, rate: toRate(1.5) }, sigs]),
      'QuorumNotMet',
    )
  })

  test('a signature for another chain does not verify', async () => {
    const before = await read('peek', [EURUSD])
    const t = await now()
    const attestation = { pair: EURUSD, rate: toRate(1.16), observedAt: BigInt(t + 3) }
    const sigs = await Promise.all([0, 1].map((i) =>
      signAttestation({ walletClient: wallets[i], account: accounts[i], chainId: 1, oracle, attestation })))
    const sorted = [0, 1].map((i) => ({ a: accounts[i].address, s: sigs[i] }))
      .sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1)).map((x) => x.s)
    // Signed for chain 1, these recover to addresses that are neither publishers nor in
    // any particular order, so the submission is refused. Which guard fires first is an
    // implementation detail; that the feed does not move is the property.
    await expectRevert(send(wallets[0], 'submit', [attestation, sorted]), 'QuorumNotMet')
    const after = await read('peek', [EURUSD])
    assert.equal(after.rate, before.rate)
  })
})

describe('ordering and freshness', () => {
  test('a late-arriving older observation does not rewind the feed', async () => {
    const t = await now()
    const fresh = await attest({ rate: 1.16, observedAt: t + 10 })
    await send(wallets[0], 'submit', [fresh.attestation, fresh.sigs])
    const stale = await attest({ rate: 1.10, observedAt: t + 5 })
    await expectRevert(send(wallets[0], 'submit', [stale.attestation, stale.sigs]), 'NotNewer')
  })

  test('an observation from the future is rejected', async () => {
    const t = await now()
    const { attestation, sigs } = await attest({ rate: 1.16, observedAt: t + 3600 })
    await expectRevert(send(wallets[0], 'submit', [attestation, sigs]), 'FromFuture')
  })

  test('reading enforces the caller’s own freshness bound', async () => {
    await tc.increaseTime({ seconds: 7200 })
    await tc.mine({ blocks: 1 })
    await expectRevert(read('getRate', [EURUSD, 60n]), 'StaleRate')
    const [rate] = await read('getRate', [EURUSD, 86400n]) // a laxer caller still reads it
    assert.ok(rate > 0n)
  })

  test('an unknown pair has no feed', async () => {
    await expectRevert(read('getRate', [pairId('XXX/YYY'), 3600n]), 'NoFeed')
  })
})

describe('circuit breaker', () => {
  test('a wild move is rejected while the previous observation is fresh', async () => {
    const t = await now()
    const base = await attest({ rate: 1.16, observedAt: t + 1 })
    await send(wallets[0], 'submit', [base.attestation, base.sigs])
    // +30% in one step, well past the 10% cap
    const wild = await attest({ rate: 1.51, observedAt: t + 2 })
    await expectRevert(send(wallets[0], 'submit', [wild.attestation, wild.sigs]), 'DeviationTooLarge')
  })

  test('a normal move passes', async () => {
    const t = await now()
    const { attestation, sigs } = await attest({ rate: 1.18, observedAt: t + 5 })
    const r = await send(wallets[0], 'submit', [attestation, sigs])
    assert.equal(r.status, 'success')
  })

  test('the allowance widens with staleness but never disappears', async () => {
    const fresh = await read('allowedDeviationBps', [0n])
    const hour = await read('allowedDeviationBps', [3600n])
    const week = await read('allowedDeviationBps', [7n * 24n * 3600n])
    assert.equal(fresh, 1000n, 'fresh: 10%')
    assert.equal(hour, 2000n, 'one hour stale: 20%')
    assert.equal(week, 2500n, 'a week stale is still capped at 25%')
  })

  test('a stale feed permits a larger repricing, so an FX gap is not fatal', async () => {
    await tc.increaseTime({ seconds: 3 * 3600 })
    await tc.mine({ blocks: 1 })
    const t = await now()
    const prev = await read('peek', [EURUSD])
    const target = (prev.rate * 118n) / 100n // +18%: past the fresh cap, inside the stale one
    const attestation = { pair: EURUSD, rate: target, observedAt: BigInt(t) }
    const sigs = await signAttestationQuorum({
      signers: [0, 1].map((i) => ({ walletClient: wallets[i], account: accounts[i] })),
      chainId: arcLocal.id, oracle, attestation,
    })
    const r = await send(wallets[0], 'submit', [attestation, sigs])
    assert.equal(r.status, 'success')
  })

  test('waiting does NOT buy an unlimited print', async () => {
    // The whole point of the absolute ceiling: sitting out the window must not let a
    // compromised publisher set name any number it likes. Measured before this cap
    // existed, one such print took 37.8% of a pool's book.
    await tc.increaseTime({ seconds: 30 * 24 * 3600 })
    await tc.mine({ blocks: 1 })
    const t = await now()
    const prev = await read('peek', [EURUSD])
    const attestation = { pair: EURUSD, rate: prev.rate * 10n, observedAt: BigInt(t) }
    const sigs = await signAttestationQuorum({
      signers: [0, 1].map((i) => ({ walletClient: wallets[i], account: accounts[i] })),
      chainId: arcLocal.id, oracle, attestation,
    })
    await expectRevert(send(wallets[0], 'submit', [attestation, sigs]), 'DeviationTooLarge')
  })
})

describe('governance', () => {
  test('only the admin rotates publishers', async () => {
    await expectRevert(send(wallets[3], 'setPublisher', [accounts[3].address, true]), 'NotAdmin')
    await send(wallets[0], 'setPublisher', [accounts[3].address, true])
    assert.equal(await read('isPublisher', [accounts[3].address]), true)
    await send(wallets[0], 'setPublisher', [accounts[3].address, false])
  })

  test('zero rates are refused', async () => {
    const t = await now()
    const attestation = { pair: EURUSD, rate: 0n, observedAt: BigInt(t + 1) }
    const sigs = await signAttestationQuorum({
      signers: [0, 1].map((i) => ({ walletClient: wallets[i], account: accounts[i] })),
      chainId: arcLocal.id, oracle, attestation,
    })
    await expectRevert(send(wallets[0], 'submit', [attestation, sigs]), 'ZeroRate')
  })
})
