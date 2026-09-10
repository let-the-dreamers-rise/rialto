// Open, fill and settle a real FX forward on Arc testnet.
//
//   node scripts/live-forward.mjs arc-testnet
//
// The point of this script is that the result is not a simulation. An importer owes
// EUR 1,000 and locks the rate against a writer; both post USDC margin; at maturity the
// position settles against the oracle and the cash difference moves. Every step is a
// transaction on a public chain and the hashes are written to a file the demo page reads,
// so a reader can check each one on the explorer rather than take the page's word.
//
// USDC is the only token involved — the forward is cash-settled — which is what makes this
// runnable today. The spot pools need EURC from the faucet before they can quote.
//
// The two rates are real ECB reference prints for EUR/USD: the strike is the rate already
// on the live feed, and settlement is a later observation posted before settling. The
// attestation timestamp is necessarily now rather than the ECB publication date, because
// the oracle rejects anything more than MAX_CLOCK_SKEW out; the VALUE is real, the clock
// is today's. Nothing here pretends a week passed.
import { createWalletClient, createPublicClient, http, formatUnits, parseEventLogs } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcTestnet, arcLocal, toRate, signAttestationQuorum } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const target = process.argv[2] ?? 'arc-testnet'
const chain = target === 'local' ? arcLocal : arcTestnet
const rec = JSON.parse(readFileSync(join(ROOT, `deployments/${target}.json`), 'utf8'))

const STRIKE_RATE = process.env.STRIKE ?? '1.1622'   // ECB 2026-09-04, already on the feed
const SETTLE_RATE = process.env.SETTLE ?? '1.1652'   // ECB 2026-09-09
const STRIKE_DATE = process.env.STRIKE_DATE ?? '2026-09-04'
const SETTLE_DATE = process.env.SETTLE_DATE ?? '2026-09-09'
const NOTIONAL = BigInt(process.env.NOTIONAL ?? 1_000_000_000) // EUR 1,000 at 6dp
const COLLATERAL = BigInt(process.env.COLLATERAL ?? 5_000_000) //   5 USDC each side
const TENOR = Number(process.env.TENOR ?? 120)                 // seconds to maturity

const LOCAL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
let pk = process.env.DEPLOYER_PK
if (!pk) {
  pk = target === 'local'
    ? LOCAL_PK
    : JSON.parse(readFileSync(join(ROOT, '.secrets/deployer.json'), 'utf8')).privateKey
}
const writer = privateKeyToAccount(pk)

// The taker is a second party. A forward with one participant proves nothing, so this
// generates a counterparty, funds it from the writer, and lets it sign for itself.
const takerPath = join(ROOT, '.secrets/taker.json')
if (!existsSync(takerPath)) {
  mkdirSync(join(ROOT, '.secrets'), { recursive: true })
  writeFileSync(takerPath, JSON.stringify({ privateKey: generatePrivateKey() }, null, 2))
  console.log('generated a counterparty key in .secrets/taker.json (gitignored)')
}
const taker = privateKeyToAccount(JSON.parse(readFileSync(takerPath, 'utf8')).privateKey)

const transport = http(chain.rpcUrls.default.http[0])
const pub = createPublicClient({ chain, transport })
const W = createWalletClient({ account: writer, chain, transport })
const T = createWalletClient({ account: taker, chain, transport })

const USDC = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]
const FWD = art('RialtoForward').abi
const ORACLE = art('RialtoOracle').abi

const bal6 = (a) => pub.readContract({ address: rec.usdc, abi: USDC, functionName: 'balanceOf', args: [a] })
// Two decimals and thousands separators everywhere, so the ledger on the page reads the
// way a statement does rather than the way a uint256 does.
const usd = (v) => `${Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`
const eur = (v) => `EUR ${Number(formatUnits(v, 6)).toLocaleString('en-US')}`

// Each send waits for its receipt before the next, so a nonce cannot collide with itself.
async function send(wallet, { address, abi, functionName, args, value }) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, value })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted (${hash})`)
  return r
}

const steps = []
const note = (label, receipt, detail) => {
  steps.push({ label, tx: receipt.transactionHash, gas: String(receipt.gasUsed), detail })
  console.log(`  ${label.padEnd(26)} ${receipt.transactionHash}  ${detail ?? ''}`)
}

// The local mocks deploy with no supply, so the rehearsal mints itself a float. On Arc the
// balance is real USDC from the faucet and there is nothing to mint.
if (target === 'local') {
  const MOCK = [{ name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }]
  if ((await bal6(writer.address)) < COLLATERAL * 10n) {
    await send(W, { address: rec.usdc, abi: MOCK, functionName: 'mint', args: [writer.address, 1_000_000_000n] })
  }
}

console.log(`forward    ${rec.forward}`)
console.log(`writer     ${writer.address}  ${usd(await bal6(writer.address))}`)
console.log(`taker      ${taker.address}  ${usd(await bal6(taker.address))}`)

// 1. Fund the counterparty: collateral plus gas. On Arc USDC *is* gas, so one send does both.
const need = COLLATERAL + 1_500_000n
const have = await bal6(taker.address)
console.log('\nsteps:')
if (have < need) {
  if (target === 'local') {
    // The local mock is an ordinary ERC-20 and gas is the chain's own ether, so the two
    // have to be sent separately. On Arc they are the same balance and one send does both.
    const MOCK = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }]
    await pub.waitForTransactionReceipt({ hash: await W.sendTransaction({ to: taker.address, value: 10n ** 18n }) })
    const r = await send(W, { address: rec.usdc, abi: MOCK, functionName: 'transfer', args: [taker.address, need - have] })
    note('fund counterparty', r, `${usd(need - have)} plus gas`)
  } else {
    const top = (need - have) * 10n ** 12n // 6dp -> the 18dp native value
    const r = await pub.waitForTransactionReceipt({
      hash: await W.sendTransaction({ to: taker.address, value: top }),
    })
    note('fund counterparty', r, `${usd(need - have)} for collateral and gas`)
  }
}

// 2. The writer posts the offer: a rate locked for 1,000 EUR, margin behind it.
await send(W, { address: rec.usdc, abi: USDC, functionName: 'approve', args: [rec.forward, COLLATERAL] })
const maturity = BigInt(Math.floor(Date.now() / 1000) + TENOR)
const strike = toRate(STRIKE_RATE)
const rOffer = await send(W, {
  address: rec.forward, abi: FWD, functionName: 'offer',
  args: [rec.pairId, NOTIONAL, strike, maturity, COLLATERAL],
})
const offered = parseEventLogs({ abi: FWD, eventName: 'Offered', logs: rOffer.logs })[0]
const id = offered.args.id
note('writer posts offer', rOffer, `id ${id}, strike ${STRIKE_RATE} (ECB ${STRIKE_DATE}), ${usd(COLLATERAL)} margin`)

// 3. The importer takes it. From here their cost in dollars is fixed whatever EUR/USD does.
await send(T, { address: rec.usdc, abi: USDC, functionName: 'approve', args: [rec.forward, COLLATERAL] })
const rTake = await send(T, { address: rec.forward, abi: FWD, functionName: 'take', args: [id, COLLATERAL] })
note('importer locks the rate', rTake, `${eur(NOTIONAL)} notional, ${usd(COLLATERAL)} margin`)

// 4. Wait for maturity. Not a simulated clock — the chain's own timestamp has to pass it.
const until = Number(maturity) + 5
const wait = until - Math.floor(Date.now() / 1000)
if (wait > 0) {
  console.log(`  waiting ${wait}s for maturity (${new Date(Number(maturity) * 1000).toISOString()})`)
  await new Promise((r) => setTimeout(r, wait * 1000))
}

// 5. Post the settlement rate. One publisher, quorum one — the README is blunt that this
//    is a trusted feed until the publisher set is independent.
// observedAt comes from the chain's own clock, not this machine's: the oracle rejects
// anything more than MAX_CLOCK_SKEW away from block.timestamp, and the two can differ.
const observedAt = BigInt((await pub.getBlock()).timestamp)
const att = { pair: rec.pairId, rate: toRate(SETTLE_RATE), observedAt }
const sigs = await signAttestationQuorum({
  signers: [{ walletClient: W, account: writer }],
  chainId: chain.id, oracle: rec.oracle, attestation: att,
})
const rPost = await send(W, { address: rec.oracle, abi: ORACLE, functionName: 'submit', args: [att, sigs] })
note('settlement rate posted', rPost, `${SETTLE_RATE} (ECB ${SETTLE_DATE})`)

// 6. Settle. Either party may call inside the grace window; anyone may after it.
const before = { writer: await bal6(writer.address), taker: await bal6(taker.address) }
const rSettle = await send(T, { address: rec.forward, abi: FWD, functionName: 'settle', args: [id] })
const s = parseEventLogs({ abi: FWD, eventName: 'Settled', logs: rSettle.logs })[0].args
note('settled against oracle', rSettle, `taker P&L ${usd(s.takerPnl)}${s.capped ? ' (CAPPED)' : ''}`)

const after = { writer: await bal6(writer.address), taker: await bal6(taker.address) }
const spotCost = (toRate(SETTLE_RATE) * NOTIONAL) / 10n ** 18n
const lockedCost = (strike * NOTIONAL) / 10n ** 18n

console.log(`\nresult`)
console.log(`  strike ${STRIKE_RATE} -> settled at ${SETTLE_RATE}   (${(((Number(SETTLE_RATE) / Number(STRIKE_RATE)) - 1) * 10_000).toFixed(1)} bp)`)
console.log(`  ${eur(NOTIONAL)} would have cost ${usd(spotCost)} at settlement spot`)
console.log(`  the lock fixed it at                 ${usd(lockedCost)}`)
console.log(`  forward paid the importer            ${usd(s.toTaker - COLLATERAL)}`)
console.log(`  capped:  ${s.capped}`)
console.log(`  taker   ${usd(before.taker)} -> ${usd(after.taker)}`)
console.log(`  writer  ${usd(before.writer)} -> ${usd(after.writer)}`)

const out = {
  network: target, chainId: chain.id, forward: rec.forward, oracle: rec.oracle,
  explorer: chain.blockExplorers?.default.url ?? null,
  pair: rec.pair, id: String(id),
  notional: String(NOTIONAL), notionalLabel: eur(NOTIONAL),
  strike: STRIKE_RATE, strikeDate: STRIKE_DATE,
  settledAt: SETTLE_RATE, settleDate: SETTLE_DATE,
  moveBps: Number((((Number(SETTLE_RATE) / Number(STRIKE_RATE)) - 1) * 10_000).toFixed(1)),
  collateralEachSide: String(COLLATERAL),
  takerPnl: String(s.takerPnl), toTaker: String(s.toTaker), toWriter: String(s.toWriter),
  capped: s.capped,
  paidToImporter: String(s.toTaker - COLLATERAL),
  spotCost: String(spotCost), lockedCost: String(lockedCost),
  writer: writer.address, taker: taker.address,
  steps, ranAt: new Date().toISOString(),
  rateSource: 'European Central Bank daily reference rates (EXR.D.USD.EUR.SP00.A)',
}
// A local rehearsal must not leave its numbers on the demo page — the page claims these
// are live Arc transactions, and for a local run they would be hardhat hashes that resolve
// to nothing on the explorer.
if (target === 'local') {
  console.log('\nlocal rehearsal: not writing the demo page files')
} else {
  for (const p of ['apps/web/public/live-forward.json', 'site/public/live-forward.json']) {
    writeFileSync(join(ROOT, p), JSON.stringify(out, null, 2))
    console.log(`\nwrote ${p}`)
  }
}
