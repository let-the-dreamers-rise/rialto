// Fetch the current ECB reference rate for a pair and post it to the oracle.
//
//   node scripts/publish-rate.mjs                 # EUR/USD onto Arc testnet
//   PAIR=EUR/USD DRY=1 node scripts/publish-rate.mjs
//
// This is the whole publisher. A feed is not a contract, it is a contract plus somebody who
// keeps posting to it, and the cost of that is the number this prints at the end.
//
// Staleness is not an error condition here. The oracle is pull-based: getRate reverts past
// the bound the *caller* names, so a feed nobody has updated stops trades rather than
// settling them at yesterday's price. What a stale feed does mean is that nobody is
// running this, which is a different problem and an honest one to show.
import { createWalletClient, createPublicClient, http, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcTestnet, arcLocal, pairId, toRate, signAttestationQuorum } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const target = process.env.NETWORK ?? 'arc-testnet'
const chain = target === 'local' ? arcLocal : arcTestnet
const rec = JSON.parse(readFileSync(join(ROOT, `deployments/${target}.json`), 'utf8'))
const PAIR = process.env.PAIR ?? 'EUR/USD'
const DRY = process.env.DRY === '1'

// ECB quotes everything per one euro, so a EUR/BASE pair is series D.<BASE>.EUR.SP00.A and
// the value is already BASE per EUR — the same orientation the pool uses for token0/token1.
function seriesFor(pair) {
  const [from, to] = pair.split('/')
  if (from !== 'EUR') throw new Error(`only EUR-base pairs come straight from the ECB; got ${pair}`)
  return `D.${to}.EUR.SP00.A`
}

// Ten days back, because the ECB does not publish on weekends or TARGET holidays and a
// Monday morning would otherwise find an empty window.
async function latestEcb(pair) {
  const end = new Date()
  const start = new Date(end.getTime() - 10 * 864e5)
  const iso = (d) => d.toISOString().slice(0, 10)
  const url = `https://data-api.ecb.europa.eu/service/data/EXR/${seriesFor(pair)}`
    + `?startPeriod=${iso(start)}&endPeriod=${iso(end)}&format=csvdata`
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) })
  if (!res.ok) throw new Error(`ECB responded ${res.status}`)
  const rows = (await res.text()).trim().split('\n')
  const head = rows[0].split(',')
  const iDate = head.indexOf('TIME_PERIOD')
  const iVal = head.indexOf('OBS_VALUE')
  if (iDate < 0 || iVal < 0) throw new Error('ECB response is missing TIME_PERIOD or OBS_VALUE')
  const obs = rows.slice(1).map((r) => r.split(',')).map((c) => ({ date: c[iDate], rate: c[iVal] }))
    .filter((o) => o.date && Number.isFinite(Number(o.rate)))
  if (!obs.length) throw new Error('ECB returned no observations in the window')
  return obs[obs.length - 1]
}

const LOCAL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
let pk = process.env.PUBLISHER_PK ?? process.env.DEPLOYER_PK
if (!pk) {
  const p = join(ROOT, '.secrets/deployer.json')
  if (target === 'local') pk = LOCAL_PK
  else if (existsSync(p)) pk = JSON.parse(readFileSync(p, 'utf8')).privateKey
  else throw new Error('no publisher key: set PUBLISHER_PK or provide .secrets/deployer.json')
}
const publisher = privateKeyToAccount(pk)
const transport = http(chain.rpcUrls.default.http[0])
const pub = createPublicClient({ chain, transport })
const wallet = createWalletClient({ account: publisher, chain, transport })
const ORACLE = art('RialtoOracle').abi
const id = pairId(PAIR)

const obs = await latestEcb(PAIR)
console.log(`ECB        ${PAIR} ${obs.rate} on ${obs.date}`)

let onChain = null
try {
  const [rate, observedAt] = await pub.readContract({
    address: rec.oracle, abi: ORACLE, functionName: 'getRate', args: [id, 10n ** 9n],
  })
  const age = Math.floor(Date.now() / 1000) - Number(observedAt)
  onChain = { rate, age }
  console.log(`on chain   ${formatUnits(rate, 18)}  ${(age / 3600).toFixed(1)}h old`)
} catch {
  console.log('on chain   no feed yet')
}

const next = toRate(obs.rate)
if (onChain) {
  const move = Number(
    ((next > onChain.rate ? next - onChain.rate : onChain.rate - next) * 10_000n) / onChain.rate,
  )
  console.log(`move       ${move} bp`)
}
if (DRY) { console.log('\nDRY=1, nothing posted'); process.exit(0) }

const before = await pub.getBalance({ address: publisher.address })
// observedAt is the chain's clock, not this machine's: the oracle rejects anything more
// than MAX_CLOCK_SKEW away from block.timestamp and the two drift.
const observedAt = BigInt((await pub.getBlock()).timestamp)
const attestation = { pair: id, rate: next, observedAt }
const sigs = await signAttestationQuorum({
  signers: [{ walletClient: wallet, account: publisher }],
  chainId: chain.id, oracle: rec.oracle, attestation,
})
const hash = await wallet.writeContract({
  address: rec.oracle, abi: ORACLE, functionName: 'submit', args: [attestation, sigs],
})
const r = await pub.waitForTransactionReceipt({ hash })
if (r.status !== 'success') throw new Error(`submit reverted (${hash})`)
const after = await pub.getBalance({ address: publisher.address })

console.log(`\nposted     ${obs.rate} as ${PAIR}`)
console.log(`tx         ${hash}`)
console.log(`cost       ${formatUnits(before - after, 18)} USDC  (gas ${r.gasUsed})`)
if (chain.blockExplorers) console.log(`explorer   ${chain.blockExplorers.default.url}/tx/${hash}`)

// The page quotes what an update costs. Quoting a measurement with the transaction behind
// it beats quoting a number someone typed once and never checked again.
if (target !== 'local') {
  const record = {
    network: target, pair: PAIR, rate: obs.rate, ecbDate: obs.date,
    tx: hash, gas: String(r.gasUsed), costUsdc: formatUnits(before - after, 18),
    block: String(r.blockNumber), publisher: publisher.address,
    explorer: chain.blockExplorers?.default.url ?? null,
    postedAt: new Date().toISOString(),
    source: 'European Central Bank daily reference rates',
  }
  for (const f of ['apps/web/public/last-publish.json', 'site/public/last-publish.json']) {
    writeFileSync(join(ROOT, f), JSON.stringify(record, null, 2))
    console.log(`wrote      ${f}`)
  }
}
