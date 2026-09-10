// Verify the deployed contracts on Arcscan (Blockscout) via standard-json-input.
// A grant reviewer clicking an address should read the source, not bytecode.
import solc from 'solc'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'contracts/src'
const d = JSON.parse(readFileSync('deployments/arc-testnet.json', 'utf8'))
const version = solc.version()                       // e.g. 0.8.28+commit.7893614a.Emscripten.clang
const compiler = 'v' + version.split('.Emscripten')[0]

const sources = {}
for (const f of readdirSync(SRC).filter((f) => f.endsWith('.sol'))) {
  sources[f] = { content: readFileSync(join(SRC, f), 'utf8') }
}
// Must match scripts/compile.mjs exactly or the bytecode will not match.
const standardInput = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 400 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
}

const targets = [
  { address: d.oracle,     name: 'RialtoOracle.sol:RialtoOracle' },
  { address: d.rateSource, name: 'RateSource.sol:OracleRateSource' },
  { address: d.pool,       name: 'RialtoPool.sol:RialtoPool' },
  { address: d.settlement, name: 'RialtoSettlement.sol:RialtoSettlement' },
  { address: d.router,     name: 'RialtoRouter.sol:RialtoRouter' },
  { address: d.forward,    name: 'RialtoForward.sol:RialtoForward' },
].filter((t) => t.address)

// Blockscout rate-limits, and a 429 on one contract reads exactly like a pass if the body
// is not checked. Anything that is not an accepted submission is reported as such.
const results = []

for (const t of targets) {
  const form = new FormData()
  form.append('compiler_version', compiler)
  form.append('contract_name', t.name)
  form.append('autodetect_constructor_args', 'true')
  form.append('license_type', 'mit')
  form.append('files[0]', new Blob([JSON.stringify(standardInput)], { type: 'application/json' }), 'standard-input.json')

  const url = `https://testnet.arcscan.app/api/v2/smart-contracts/${t.address}/verification/via/standard-input`
  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    const ok = res.status === 200 && !/too many requests/i.test(text)
    results.push({ name: t.name, ok, status: res.status })
    console.log(`${t.name.padEnd(40)} ${res.status}  ${text.slice(0, 140)}`)
  } catch (e) {
    results.push({ name: t.name, ok: false, status: 'error' })
    console.log(`${t.name.padEnd(40)} FAILED ${String(e.message).slice(0, 80)}`)
  }
  // Space the submissions out rather than collecting rate-limit responses.
  await new Promise((r) => setTimeout(r, 4000))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} submissions accepted`)
if (failed.length) {
  console.log('not accepted: ' + failed.map((f) => `${f.name} (${f.status})`).join(', '))
  console.log('re-run for those; a 429 is a rate limit, not a verification failure.')
  process.exitCode = 1
}
