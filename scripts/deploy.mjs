// Deploy the oracle, a rate source and a pool. Same path for the local chain and Arc.
//
//   node scripts/deploy.mjs local
//   node scripts/deploy.mjs arc-testnet
//
// On Arc the real USDC and EURC are used; locally, 6-decimal mocks standing in for them.
import { createWalletClient, createPublicClient, http, formatUnits as viemFormat } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcTestnet, arcLocal, ARC_TESTNET, pairId, toRate, parseUnits } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const target = process.argv[2] ?? 'local'
const chain = target === 'local' ? arcLocal : arcTestnet

const LOCAL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
let pk = process.env.DEPLOYER_PK
if (!pk) {
  if (target === 'local') pk = LOCAL_PK
  else {
    const p = join(ROOT, '.secrets/deployer.json')
    if (!existsSync(p)) throw new Error('no .secrets/deployer.json and no DEPLOYER_PK set')
    pk = JSON.parse(readFileSync(p, 'utf8')).privateKey
  }
}
const account = privateKeyToAccount(pk)
const transport = http(chain.rpcUrls.default.http[0])
const pub = createPublicClient({ chain, transport })
const wallet = createWalletClient({ account, chain, transport })

// Publisher set for the oracle. In production these are independent operators; for a first
// deployment the deployer is the sole publisher and quorum is 1, which the README is
// explicit about — a one-of-one feed is a trusted feed.
const publishers = (process.env.PUBLISHERS ?? account.address).split(',').map((s) => s.trim())
const quorum = BigInt(process.env.QUORUM ?? 1)
const AMP = BigInt(process.env.AMP ?? 200)
const FEE_PPM = BigInt(process.env.FEE_PPM ?? 2500)
const PROTOCOL_SHARE = BigInt(process.env.PROTOCOL_SHARE ?? 500_000)
const TREASURY = process.env.TREASURY ?? account.address
const MAX_AGE = BigInt(process.env.MAX_RATE_AGE ?? 900) // 15 minutes

console.log(`network    ${chain.name} (${chain.id})`)
console.log(`deployer   ${account.address}`)
const bal = await pub.getBalance({ address: account.address })
console.log(`balance    ${viemFormat(bal, 18)} USDC`)
if (bal === 0n) {
  console.error(`\nUnfunded. Send Arc testnet gas to ${account.address} via https://faucet.circle.com (Arc Testnet).`)
  process.exit(2)
}

async function deploy(name, args) {
  const a = art(name)
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${name} deployment reverted`)
  console.log(`  ${name.padEnd(16)} ${r.contractAddress}  gas ${r.gasUsed}`)
  return r.contractAddress
}

console.log('\ndeploying:')
let usdc, eurc
if (target === 'local') {
  usdc = await deploy('MockERC20', ['USD Coin', 'USDC', 6])
  eurc = await deploy('MockERC20', ['Euro Coin', 'EURC', 6])
} else {
  usdc = ARC_TESTNET.USDC
  eurc = ARC_TESTNET.EURC
  console.log(`  USDC (live)      ${usdc}`)
  console.log(`  EURC (live)      ${eurc}`)
}

const oracle = await deploy('RialtoOracle', [publishers, quorum, account.address])
const EURUSD = pairId('EUR/USD')
const rateSource = await deploy('OracleRateSource', [oracle, EURUSD, MAX_AGE])
const pool = await deploy('RialtoPool', [usdc, eurc, rateSource, AMP, FEE_PPM, PROTOCOL_SHARE, TREASURY])

console.log(`\nconfig`)
console.log(`  pair           EUR/USD  (${EURUSD})`)
console.log(`  amplification  ${AMP}`)
console.log(`  swap fee       ${Number(FEE_PPM) / 100} bp`)
console.log(`  protocol share ${Number(PROTOCOL_SHARE) / 10_000}% of the fee -> ${TREASURY}`)
console.log(`  publishers     ${publishers.join(', ')}  (quorum ${quorum})`)
console.log(`  max rate age   ${MAX_AGE}s`)
if (chain.blockExplorers) console.log(`\nexplorer   ${chain.blockExplorers.default.url}/address/${pool}`)

mkdirSync(join(ROOT, 'deployments'), { recursive: true })
const out = join(ROOT, `deployments/${target}.json`)
writeFileSync(out, JSON.stringify({
  network: target, chainId: chain.id, rpc: chain.rpcUrls.default.http[0],
  usdc, eurc, oracle, rateSource, pool, treasury: TREASURY,
  pair: 'EUR/USD', pairId: EURUSD,
  amp: String(AMP), feePpm: String(FEE_PPM), protocolSharePpm: String(PROTOCOL_SHARE),
  publishers, quorum: String(quorum), maxRateAge: String(MAX_AGE),
  deployer: account.address, deployedAt: new Date().toISOString(),
}, null, 2))
console.log(`\nwrote ${out}`)

// The demo page does not read a file for its addresses: it reads the chain on every
// request, so a deployment it does not know about shows up as soon as it is deployed and a
// stale file can never disagree with reality. Addresses live in deployments/<network>.json
// for the scripts, and nowhere else.
