// Deploy the rest of the stack onto an oracle that is already live.
//
//   node scripts/deploy-instruments.mjs arc-testnet
//
// The oracle and its rate source are left alone — they are verified and carrying a live
// EUR/USD print, and redeploying them would throw that away. This adds the pool at the
// fee the documents actually quote, plus the three contracts that were written and tested
// but never put on a chain: settlement, the multi-hop router, and the forward.
import { createWalletClient, createPublicClient, http, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcTestnet, arcLocal } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const target = process.argv[2] ?? 'arc-testnet'
const chain = target === 'local' ? arcLocal : arcTestnet

const recPath = join(ROOT, `deployments/${target}.json`)
if (!existsSync(recPath)) throw new Error(`no deployment record at ${recPath} — run deploy.mjs first`)
const rec = JSON.parse(readFileSync(recPath, 'utf8'))

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

const AMP = BigInt(process.env.AMP ?? rec.amp ?? 200)
const FEE_PPM = BigInt(process.env.FEE_PPM ?? 2500)
const PROTOCOL_SHARE = BigInt(process.env.PROTOCOL_SHARE ?? rec.protocolSharePpm ?? 500_000)
const TREASURY = process.env.TREASURY ?? rec.treasury ?? account.address

console.log(`network    ${chain.name} (${chain.id})`)
console.log(`deployer   ${account.address}`)
const bal = await pub.getBalance({ address: account.address })
console.log(`balance    ${formatUnits(bal, 18)} USDC`)
if (bal === 0n) { console.error('unfunded'); process.exit(2) }
console.log(`reusing    oracle ${rec.oracle}`)
console.log(`reusing    rateSource ${rec.rateSource}`)

async function deploy(name, args) {
  const a = art(name)
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${name} deployment reverted`)
  console.log(`  ${name.padEnd(18)} ${r.contractAddress}  gas ${r.gasUsed}`)
  return r.contractAddress
}

console.log('\ndeploying:')
const pool = await deploy('RialtoPool', [rec.usdc, rec.eurc, rec.rateSource, AMP, FEE_PPM, PROTOCOL_SHARE, TREASURY])
const settlement = await deploy('RialtoSettlement', [])
const router = await deploy('RialtoRouter', [])
const forward = await deploy('RialtoForward', [rec.usdc, rec.oracle])

const after = await pub.getBalance({ address: account.address })
console.log(`\nspent      ${formatUnits(bal - after, 18)} USDC of gas`)
console.log(`remaining  ${formatUnits(after, 18)} USDC`)
console.log(`\nconfig`)
console.log(`  swap fee       ${Number(FEE_PPM) / 100} bp   (was ${Number(rec.feePpm) / 100} bp)`)
console.log(`  amplification  ${AMP}`)

const next = {
  ...rec,
  pool, settlement, router, forward,
  previousPool: rec.pool,
  amp: String(AMP), feePpm: String(FEE_PPM), protocolSharePpm: String(PROTOCOL_SHARE),
  treasury: TREASURY,
  instrumentsDeployedAt: new Date().toISOString(),
}
writeFileSync(recPath, JSON.stringify(next, null, 2))
console.log(`\nwrote ${recPath}`)
