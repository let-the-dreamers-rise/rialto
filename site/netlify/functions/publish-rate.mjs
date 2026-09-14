// Scheduled publisher: fetch the current ECB reference rate and post it to the oracle.
//
// A feed is a contract plus somebody who keeps posting to it. Without this, the demo page is
// only fresh while someone is at a terminal, and a reviewer who opens it on a Sunday finds a
// stale print — which is the oracle behaving correctly and the project looking abandoned.
//
// The key comes from publisher.mjs: generated on first use and kept in Netlify Blobs, or
// PUBLISHER_PK if that is set. A run with a key that is not yet authorised, or not yet
// funded, reverts and reports it — which is the right answer until the admin authorises the
// address at /api/publisher and someone sends it gas.
import { createWalletClient, createPublicClient, http, formatUnits, keccak256, stringToBytes, parseUnits } from 'viem'
import { publisherAccount } from './publisher.mjs'
import { getStore } from '@netlify/blobs'

const RPC = Netlify.env.get('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.io'
const ORACLE_ADDRESS = '0x391c05393778eae959cf16296e308d5538c5754f'
const PAIR = 'EUR/USD'
const PAIR_ID = keccak256(stringToBytes(PAIR))

const chain = {
  id: 5042002, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
}
const ORACLE = [
  { type: 'function', name: 'submit', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { type: 'tuple', name: 'a', components: [
        { name: 'pair', type: 'bytes32' }, { name: 'rate', type: 'uint256' }, { name: 'observedAt', type: 'uint64' }] },
      { type: 'bytes[]', name: 'sigs' }] },
  { type: 'function', name: 'getRate', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }, { type: 'uint64' }] },
]
const TYPES = { Attestation: [
  { name: 'pair', type: 'bytes32' }, { name: 'rate', type: 'uint256' }, { name: 'observedAt', type: 'uint64' }] }

// Ten days back: the ECB skips weekends and TARGET holidays, so a short window can be empty.
async function latestEcb() {
  const iso = (d) => d.toISOString().slice(0, 10)
  const end = new Date(), start = new Date(end.getTime() - 10 * 864e5)
  const url = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A'
    + `?startPeriod=${iso(start)}&endPeriod=${iso(end)}&format=csvdata`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`ECB responded ${res.status}`)
  const rows = (await res.text()).trim().split('\n')
  const head = rows[0].split(',')
  const iDate = head.indexOf('TIME_PERIOD'), iVal = head.indexOf('OBS_VALUE')
  if (iDate < 0 || iVal < 0) throw new Error('ECB response missing TIME_PERIOD or OBS_VALUE')
  const obs = rows.slice(1).map((r) => r.split(','))
    .map((c) => ({ date: c[iDate], rate: c[iVal] }))
    .filter((o) => o.date && Number.isFinite(Number(o.rate)))
  if (!obs.length) throw new Error('ECB returned no observations')
  return obs[obs.length - 1]
}

export default async () => {
  const j = (v, status = 200) =>
    new Response(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)),
      { status, headers: { 'content-type': 'application/json' } })

  try {
    const account = await publisherAccount()
    const transport = http(RPC)
    const pub = createPublicClient({ chain, transport })
    const wallet = createWalletClient({ account, chain, transport })

    const obs = await latestEcb()
    const rate = parseUnits(obs.rate, 18)

    // observedAt comes from the chain's clock: the oracle rejects anything more than
    // MAX_CLOCK_SKEW from block.timestamp, and a function host's clock is not Arc's.
    const observedAt = BigInt((await pub.getBlock()).timestamp)
    const attestation = { pair: PAIR_ID, rate, observedAt }
    const signature = await wallet.signTypedData({
      account,
      domain: { name: 'RialtoOracle', version: '1', chainId: chain.id, verifyingContract: ORACLE_ADDRESS },
      types: TYPES, primaryType: 'Attestation', message: attestation,
    })

    const before = await pub.getBalance({ address: account.address })
    const hash = await wallet.writeContract({
      address: ORACLE_ADDRESS, abi: ORACLE, functionName: 'submit', args: [attestation, [signature]],
    })
    const r = await pub.waitForTransactionReceipt({ hash })
    const after = await pub.getBalance({ address: account.address })
    if (r.status !== 'success') return j({ error: 'submit reverted', tx: hash }, 502)

    const record = { rate: obs.rate, ecbDate: obs.date, tx: hash, gas: String(r.gasUsed),
                     costUsdc: formatUnits(before - after, 18), publisher: account.address,
                     postedAt: new Date().toISOString(), source: 'scheduled' }
    // Best effort: a failed record must not turn a successful post into a reported failure.
    try { await getStore({ name: 'publisher', consistency: 'strong' }).setJSON('last', record) } catch {}
    return j(record)
  } catch (e) {
    return j({ error: 'publish failed', detail: String(e?.shortMessage ?? e?.message ?? e) }, 502)
  }
}

// Every ten minutes, because the pool settles against a 15-minute bound: an hourly
// publisher would leave the feed outside that bound for 45 minutes in every 60, and the
// page would correctly report it stale almost all the time.
//
// At the measured 0.00093 USDC per update that is about 0.13 USDC a day. The ECB publishes
// once a day, so most of these runs re-attest the same value — the README and the page are
// both explicit that this is a daily number held inside an intraday bound, and that a
// production feed takes intraday quotes from independent publishers instead.
export const config = { schedule: '*/10 * * * *' }
