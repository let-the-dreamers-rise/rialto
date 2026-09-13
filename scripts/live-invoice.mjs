// Seed the pool and settle a real cross-border invoice on Arc testnet.
//
//   node scripts/live-invoice.mjs arc-testnet
//
// This is the flow the front page promises: a business owes a euro invoice, holds dollars,
// and pays it in one transaction with the payee receiving the exact amount billed. Every
// step here is a transaction on a public chain.
//
// Size is set by Circle's faucet, which meters testnet EURC at 20 per request. The book is
// therefore small, and the script prints what the invoice cost against mid so the slippage
// is visible rather than buried — on a book this size it is the dominant term, and saying
// so is the point. The economics at realistic depth are measured in scripts/simulate.mjs.
import { createWalletClient, createPublicClient, http, formatUnits, parseEventLogs } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcTestnet, arcLocal } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const target = process.argv[2] ?? 'arc-testnet'
const chain = target === 'local' ? arcLocal : arcTestnet
const rec = JSON.parse(readFileSync(join(ROOT, `deployments/${target}.json`), 'utf8'))

const INVOICE_EUR = BigInt(process.env.INVOICE ?? 1_000_000)      // EUR 1.00, 6dp
const INVOICE_REF = process.env.REF ?? 'INV-2026-114'
const SEED_EURC = BigInt(process.env.SEED_EURC ?? 20_000_000)     // the whole faucet drip
const GAS_RESERVE = BigInt(process.env.GAS_RESERVE ?? 6_000_000)  // keep 6 USDC back for gas

const LOCAL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
let pk = process.env.DEPLOYER_PK
if (!pk) {
  pk = target === 'local' ? LOCAL_PK
    : JSON.parse(readFileSync(join(ROOT, '.secrets/deployer.json'), 'utf8')).privateKey
}
const lp = privateKeyToAccount(pk)

// The payer is a separate party holding only dollars, and the payee a third address that
// touches nothing else — an invoice settled from and to the same wallet proves nothing.
function keyAt(name) {
  const p = join(ROOT, `.secrets/${name}.json`)
  if (!existsSync(p)) {
    mkdirSync(join(ROOT, '.secrets'), { recursive: true })
    writeFileSync(p, JSON.stringify({ privateKey: generatePrivateKey() }, null, 2))
    console.log(`generated .secrets/${name}.json (gitignored)`)
  }
  return privateKeyToAccount(JSON.parse(readFileSync(p, 'utf8')).privateKey)
}
const payer = keyAt('taker')     // already funded from the forward run
const payee = keyAt('payee')

const transport = http(chain.rpcUrls.default.http[0])
const pub = createPublicClient({ chain, transport })
const LPW = createWalletClient({ account: lp, chain, transport })
const PAYER = createWalletClient({ account: payer, chain, transport })

const ERC = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]
const POOL = art('RialtoPool').abi
const SETTLE = art('RialtoSettlement').abi
const ORACLE = art('RialtoOracle').abi

const bal = (t, a) => pub.readContract({ address: t, abi: ERC, functionName: 'balanceOf', args: [a] })
const usd = (v) => `${Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`
const eur = (v) => `EUR ${Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function send(w, call) {
  const hash = await w.writeContract(call)
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${call.functionName} reverted (${hash})`)
  return r
}
const steps = []
const note = (label, r, detail) => {
  steps.push({ label, tx: r.transactionHash, gas: String(r.gasUsed), detail })
  console.log(`  ${label.padEnd(26)} ${r.transactionHash}  ${detail ?? ''}`)
}

// The local mocks deploy with no supply and gas there is the chain's own ether, so a
// rehearsal has to mint itself a float and fund the payer. On Arc both come from the faucet
// and USDC is the gas token, so neither step exists.
if (target === 'local') {
  const MOCK = [{ name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }]
  const mint = (token, to, amt) => send(LPW, { address: token, abi: MOCK, functionName: 'mint', args: [to, amt] })
  await mint(rec.usdc, lp.address, 30_000_000n)
  await mint(rec.eurc, lp.address, 20_000_000n)
  await mint(rec.usdc, payer.address, 10_000_000n)
  for (const a of [payer.address, payee.address]) {
    await pub.waitForTransactionReceipt({ hash: await LPW.sendTransaction({ to: a, value: 10n ** 18n }) })
  }
}

const [rate] = await pub.readContract({
  address: rec.oracle, abi: ORACLE, functionName: 'getRate', args: [rec.pairId, 3600n],
})
console.log(`oracle     ${formatUnits(rate, 18)} USD per EUR`)
console.log(`pool       ${rec.pool}`)
console.log(`LP         ${lp.address}      ${usd(await bal(rec.usdc, lp.address))}  ${eur(await bal(rec.eurc, lp.address))}`)
console.log(`payer      ${payer.address}   ${usd(await bal(rec.usdc, payer.address))}`)
console.log(`payee      ${payee.address}   ${eur(await bal(rec.eurc, payee.address))}`)

console.log('\nsteps:')

// 1. Seed the pool at the oracle rate. Balanced in *value*, not in units: that is the whole
//    argument — a 1:1 pool would sit its liquidity at a price that does not exist.
let r0 = await bal(rec.usdc, rec.pool)
let r1 = await bal(rec.eurc, rec.pool)
if (r0 === 0n && r1 === 0n) {
  const eurcHave = await bal(rec.eurc, lp.address)
  const seedEurc = eurcHave < SEED_EURC ? eurcHave : SEED_EURC
  if (seedEurc === 0n) throw new Error('no EURC to seed with — claim from faucet.circle.com (Arc, EURC)')
  let seedUsdc = (seedEurc * rate) / 10n ** 18n
  const usdcHave = await bal(rec.usdc, lp.address)
  if (usdcHave < seedUsdc + GAS_RESERVE) {
    seedUsdc = usdcHave > GAS_RESERVE ? usdcHave - GAS_RESERVE : 0n
    console.log(`  (short of a balanced seed; using ${usd(seedUsdc)} and keeping ${usd(GAS_RESERVE)} for gas)`)
  }
  if (seedUsdc === 0n) throw new Error('not enough USDC to seed and still pay gas')

  await send(LPW, { address: rec.usdc, abi: ERC, functionName: 'approve', args: [rec.pool, seedUsdc] })
  await send(LPW, { address: rec.eurc, abi: ERC, functionName: 'approve', args: [rec.pool, seedEurc] })
  const rSeed = await send(LPW, {
    address: rec.pool, abi: POOL, functionName: 'addLiquidity',
    args: [seedUsdc, seedEurc, 0n, lp.address],
  })
  note('pool seeded', rSeed, `${usd(seedUsdc)} + ${eur(seedEurc)} at ${formatUnits(rate, 18)}`)
  r0 = await bal(rec.usdc, rec.pool); r1 = await bal(rec.eurc, rec.pool)
} else {
  console.log(`  pool already holds ${usd(r0)} + ${eur(r1)}`)
}

// 2. Quote the invoice. Exact output: the payee is owed a number, not approximately a number.
const quoted = await pub.readContract({
  address: rec.settlement, abi: SETTLE, functionName: 'quote',
  args: [rec.pool, true, INVOICE_EUR],
})
const mid = (INVOICE_EUR * rate) / 10n ** 18n
console.log(`  quote                      ${eur(INVOICE_EUR)} costs ${usd(quoted)}  (mid ${usd(mid)})`)

// 3. Settle it. A bound and a deadline, not a firm quote: the payer says the most they will
//    part with and by when, and the chain either honours it or reverts.
const maxAmountIn = (quoted * 10_100n) / 10_000n   // 1% headroom over the quote
const payerHas = await bal(rec.usdc, payer.address)
if (payerHas < maxAmountIn) throw new Error(`payer holds ${usd(payerHas)}, needs ${usd(maxAmountIn)}`)

await send(PAYER, { address: rec.usdc, abi: ERC, functionName: 'approve', args: [rec.settlement, maxAmountIn] })
const ref = `0x${Buffer.from(INVOICE_REF).toString('hex').padEnd(64, '0')}`
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
const before = { payer: await bal(rec.usdc, payer.address), payee: await bal(rec.eurc, payee.address) }
const rSettle = await send(PAYER, {
  address: rec.settlement, abi: SETTLE, functionName: 'settle',
  args: [{ pool: rec.pool, payee: payee.address, zeroForOne: true, amountOut: INVOICE_EUR,
           maxAmountIn, deadline, invoiceRef: ref }],
})
const ev = parseEventLogs({ abi: SETTLE, eventName: 'InvoiceSettled', logs: rSettle.logs })[0].args
note('invoice settled', rSettle, `${eur(ev.amountOut)} delivered for ${usd(ev.amountIn)}`)

const after = { payer: await bal(rec.usdc, payer.address), payee: await bal(rec.eurc, payee.address) }
const allInBps = Number(((ev.amountIn - mid) * 10_000n) / mid)

console.log(`\nresult`)
console.log(`  invoice            ${INVOICE_REF}, ${eur(INVOICE_EUR)}`)
console.log(`  payee received     ${eur(after.payee - before.payee)}   exact: ${after.payee - before.payee === INVOICE_EUR}`)
console.log(`  payer paid         ${usd(before.payer - after.payer)}`)
console.log(`  at mid it was      ${usd(mid)}`)
console.log(`  all-in             ${allInBps} bp over mid  (25bp fee + slippage on a ${usd(r0)}/${eur(r1)} book)`)
console.log(`  effective rate     ${formatUnits(ev.effectiveRate, 18)} USD per EUR`)

const out = {
  network: target, chainId: chain.id, pool: rec.pool, settlement: rec.settlement,
  explorer: chain.blockExplorers?.default.url ?? null,
  invoiceRef: INVOICE_REF, invoiceRefHex: ref,
  amountOut: String(ev.amountOut), amountOutLabel: eur(ev.amountOut),
  amountIn: String(ev.amountIn), amountInLabel: usd(ev.amountIn),
  midCost: String(mid), midLabel: usd(mid),
  allInBps, effectiveRate: formatUnits(ev.effectiveRate, 18), oracleRate: formatUnits(rate, 18),
  exact: after.payee - before.payee === INVOICE_EUR,
  bookUsdc: String(r0), bookEurc: String(r1),
  payer: payer.address, payee: payee.address, lp: lp.address,
  steps, ranAt: new Date().toISOString(),
}
if (target === 'local') {
  console.log('\nlocal rehearsal: not writing the demo page files')
} else {
  for (const f of ['apps/web/public/live-invoice.json', 'site/public/live-invoice.json']) {
    writeFileSync(join(ROOT, f), JSON.stringify(out, null, 2))
    console.log(`\nwrote ${f}`)
  }
}
