// Authorise a publisher address on the oracle and send it gas.
//
//   node scripts/authorise-publisher.mjs 0x... [usdcToSend]
//   GAS_ONLY=1 node scripts/authorise-publisher.mjs 0x...      # just top it up
//
// The address is the only thing this needs; the key behind it stays wherever it lives —
// for the site's publisher, in Netlify Blobs, where it was generated. Run from the oracle
// admin (the deployer, until admin is transferred).
//
// GAS_ONLY exists because funding an address is a transfer and authorising it is a
// decision, and the two are not always taken by the same hands.
import { createWalletClient, createPublicClient, http, formatUnits, parseUnits, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcTestnet } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rec = JSON.parse(readFileSync(join(ROOT, 'deployments/arc-testnet.json'), 'utf8'))
const ORACLE = JSON.parse(readFileSync(join(ROOT, 'build/RialtoOracle.json'), 'utf8')).abi
if (!process.argv[2]) throw new Error('usage: authorise-publisher.mjs <address> [usdc]')
const target = getAddress(process.argv[2])
const gas = parseUnits(process.argv[3] ?? '3', 18)   // native USDC is 18dp on Arc

const pk = process.env.DEPLOYER_PK ?? JSON.parse(readFileSync(join(ROOT, '.secrets/deployer.json'), 'utf8')).privateKey
const admin = privateKeyToAccount(pk)
const transport = http(arcTestnet.rpcUrls.default.http[0])
const pub = createPublicClient({ chain: arcTestnet, transport })
const wallet = createWalletClient({ account: admin, chain: arcTestnet, transport })

const onChainAdmin = await pub.readContract({ address: rec.oracle, abi: ORACLE, functionName: 'admin' })
if (onChainAdmin.toLowerCase() !== admin.address.toLowerCase()) throw new Error(`oracle admin is ${onChainAdmin}, not this key`)

const already = await pub.readContract({ address: rec.oracle, abi: ORACLE, functionName: 'isPublisher', args: [target] })
if (already) console.log(`${target} is already a publisher`)
else if (process.env.GAS_ONLY) console.log(`${target} is NOT yet a publisher (GAS_ONLY set; not authorising)`)
else {
  const hash = await wallet.writeContract({ address: rec.oracle, abi: ORACLE, functionName: 'setPublisher', args: [target, true] })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`setPublisher reverted (${hash})`)
  console.log(`setPublisher(${target}, true)  ${hash}`)
}

const bal = await pub.getBalance({ address: target })
if (bal >= gas) console.log(`${target} already holds ${formatUnits(bal, 18)} USDC of gas`)
else {
  const hash = await wallet.sendTransaction({ to: target, value: gas - bal })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`gas transfer reverted (${hash})`)
  console.log(`sent ${formatUnits(gas - bal, 18)} USDC gas  ${hash}`)
}

const after = await pub.getBalance({ address: target })
console.log(`\npublisher   ${target}`)
console.log(`isPublisher ${await pub.readContract({ address: rec.oracle, abi: ORACLE, functionName: 'isPublisher', args: [target] })}`)
console.log(`gas         ${formatUnits(after, 18)} USDC  (~${Math.floor(Number(formatUnits(after, 18)) / 0.134)} days at 10-minute updates)`)
console.log(`admin left  ${formatUnits(await pub.getBalance({ address: admin.address }), 18)} USDC`)
