import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'

const path = '.secrets/deployer.json'
mkdirSync('.secrets', { recursive: true })
if (existsSync(path)) { console.log('exists, not overwriting'); process.exit(0) }
const pk = generatePrivateKey()
const acct = privateKeyToAccount(pk)
writeFileSync(path, JSON.stringify({ address: acct.address, privateKey: pk }, null, 2))
chmodSync(path, 0o600)
console.log('DEPLOYER ADDRESS:', acct.address)
