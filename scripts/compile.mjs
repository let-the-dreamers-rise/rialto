// Compile contracts/src/*.sol with solc-js and write ABI + bytecode to build/.
// Deliberately framework-free: deployment only needs an ABI and bytecode, and this
// project has to build in a sandbox where foundry cannot be installed (GitHub API is
// blocked by egress policy), so the toolchain is npm-only.
import solc from 'solc'
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'contracts/src')
const OUT = join(ROOT, 'build')
mkdirSync(OUT, { recursive: true })

const sources = {}
for (const f of readdirSync(SRC).filter((f) => f.endsWith('.sol'))) {
  sources[f] = { content: readFileSync(join(SRC, f), 'utf8') }
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 400 },
    // Arc's EVM baseline is Osaka; cancun is a safe subset for solc 0.8.28.
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
}

const out = JSON.parse(solc.compile(JSON.stringify(input)))

const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
for (const w of (out.errors ?? []).filter((e) => e.severity !== 'error')) {
  console.warn('WARN:', w.formattedMessage.trim())
}
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage)
  process.exit(1)
}

let n = 0
for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(
      join(OUT, `${name}.json`),
      JSON.stringify(
        {
          contractName: name,
          sourceName: file,
          abi: c.abi,
          bytecode: '0x' + c.evm.bytecode.object,
          deployedBytecode: '0x' + c.evm.deployedBytecode.object,
        },
        null,
        2,
      ),
    )
    const size = c.evm.deployedBytecode.object.length / 2
    console.log(`compiled ${name}  runtime=${size}B  ${size > 24576 ? 'OVER 24576B LIMIT' : 'ok'}`)
    n++
  }
}
if (n === 0) { console.error('no contracts compiled'); process.exit(1) }
