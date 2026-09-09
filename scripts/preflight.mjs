// Confirm Arc testnet will take this deployment before spending anything on it.
import { createPublicClient, http, formatUnits } from 'viem'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcTestnet, ARC_TESTNET } from '../packages/sdk/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const art = (n) => JSON.parse(readFileSync(join(ROOT, `build/${n}.json`), 'utf8'))
const pub = createPublicClient({ chain: arcTestnet, transport: http(arcTestnet.rpcUrls.default.http[0]) })
const deployer = JSON.parse(readFileSync(join(ROOT, '.secrets/deployer.json'), 'utf8')).address

const [chainId, block, gasPrice, bal] = await Promise.all([
  pub.getChainId(), pub.getBlock(), pub.getGasPrice(), pub.getBalance({ address: deployer }),
])
console.log(`chain id        ${chainId} ${chainId === arcTestnet.id ? '(Arc testnet OK)' : '(MISMATCH)'}`)
console.log(`head block      ${block.number}`)
console.log(`block gas limit ${block.gasLimit}`)
console.log(`base fee        ${block.baseFeePerGas ?? 'n/a'}`)

console.log('\nlive tokens the pool will use:')
for (const k of ['USDC', 'EURC']) {
  const code = await pub.getBytecode({ address: ARC_TESTNET[k] })
  const dec = await pub.readContract({
    address: ARC_TESTNET[k],
    abi: [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' }],
    functionName: 'decimals',
  }).catch(() => null)
  console.log(`  ${k.padEnd(5)} ${ARC_TESTNET[k]}  ${code && code !== '0x' ? `code ${(code.length - 2) / 2}B` : 'NO CODE'}  decimals=${dec}`)
}

let total = 0n
console.log('\nbytecode sizes:')
for (const n of ['RialtoOracle', 'OracleRateSource', 'RialtoPool']) {
  const a = art(n)
  const size = (a.deployedBytecode.length - 2) / 2
  console.log(`  ${n.padEnd(18)} ${String(size).padStart(6)}B  ${size > 24576 ? 'OVER LIMIT' : 'ok'}`)
  total += BigInt(a.bytecode.length / 2) * 200n // rough gas per byte incl. execution
}
const estGas = 4_500_000n // measured locally across the three deployments
const cost = estGas * gasPrice
console.log(`\ndeployer        ${deployer}`)
console.log(`balance         ${formatUnits(bal, 18)} USDC`)
console.log(`deploy cost     ~${formatUnits(cost, 18)} USDC (${estGas} gas at ${gasPrice} wei)`)
const needed = cost + 10n ** 18n
if (bal >= needed) console.log('\nREADY — node scripts/deploy.mjs arc-testnet')
else console.log(`\nNOT FUNDED — send ~2 USDC of Arc testnet gas to ${deployer}\n             https://faucet.circle.com (select Arc Testnet)`)
