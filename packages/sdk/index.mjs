// Rialto SDK — pair identifiers, oracle attestation signing, and unit handling.

import { keccak256, stringToBytes, defineChain, getAddress } from 'viem'

/*───────────────────────────── chains ─────────────────────────────*/

/// Arc testnet. USDC is the native gas token: 18 decimals natively, 6 via ERC-20.
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
})

export const arcLocal = defineChain({
  ...arcTestnet,
  name: 'Arc Local',
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
})

/// Live token addresses on Arc testnet, from the Arc docs.
export const ARC_TESTNET = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  USYC: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
  FxEscrow: '0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10',
  TokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  GatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  Permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  Multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
}

/*───────────────────────────── pairs and units ─────────────────────────────*/

/** Identifier for a rate, e.g. pairId('EUR/USD'). */
export const pairId = (symbol) => keccak256(stringToBytes(symbol))

/** A decimal rate as the 1e18-scaled integer the oracle stores. 1.1646 -> 1164600000000000000n */
export function toRate(x) {
  if (typeof x === 'bigint') return x
  // String(number) gives the shortest round-tripping form, so 1.1646 stays "1.1646".
  // toFixed(18) would surface the binary representation as 1.164600000000000080.
  let s = String(x)
  if (s.includes('e') || s.includes('E')) s = Number(x).toFixed(18)
  const neg = s.startsWith('-')
  if (neg) s = s.slice(1)
  const [w, f = ''] = s.split('.')
  const v = BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))
  return neg ? -v : v
}

/** Inverse of {@link toRate}, for display. */
export const fromRate = (r, dp = 6) => (Number(BigInt(r) / 10n ** BigInt(18 - dp)) / 10 ** dp)

/** Format an integer token amount with `decimals` places. */
export function formatUnits(v, decimals, dp = decimals) {
  const n = BigInt(v)
  const neg = n < 0n
  const a = neg ? -n : n
  const base = 10n ** BigInt(decimals)
  const w = a / base
  const f = (a % base).toString().padStart(decimals, '0').slice(0, dp).replace(/0+$/, '')
  return `${neg ? '-' : ''}${w}${f ? '.' + f : ''}`
}

/** Parse a decimal string into an integer token amount. */
export function parseUnits(s, decimals) {
  const [w, f = ''] = String(s).split('.')
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals))
}

/*───────────────────────────── oracle attestations ─────────────────────────────*/

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'pair', type: 'bytes32' },
    { name: 'rate', type: 'uint256' },
    { name: 'observedAt', type: 'uint64' },
  ],
}

export const oracleDomain = (chainId, verifyingContract) => ({
  name: 'RialtoOracle',
  version: '1',
  chainId,
  verifyingContract: getAddress(verifyingContract),
})

/**
 * Sign a rate attestation as one publisher.
 *
 * A publisher signs an observation, not an instruction: the same signature is valid
 * whoever relays it, which is what lets the pool carry its own price in.
 */
export async function signAttestation({ walletClient, account, chainId, oracle, attestation }) {
  return walletClient.signTypedData({
    account: account ?? walletClient.account,
    domain: oracleDomain(chainId, oracle),
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation',
    message: {
      pair: attestation.pair,
      rate: BigInt(attestation.rate),
      observedAt: BigInt(attestation.observedAt),
    },
  })
}

/**
 * Collect signatures from several publishers, ordered as the contract requires.
 *
 * The oracle demands ascending signer addresses so it can reject a duplicate signer in one
 * pass. Sorting here rather than making every caller remember is the difference between an
 * SDK and a wrapper.
 */
export async function signAttestationQuorum({ signers, chainId, oracle, attestation }) {
  const signed = await Promise.all(
    signers.map(async ({ walletClient, account }) => ({
      address: getAddress((account ?? walletClient.account).address),
      signature: await signAttestation({ walletClient, account, chainId, oracle, attestation }),
    })),
  )
  return signed
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
    .map((s) => s.signature)
}

/*───────────────────────────── pool helpers ─────────────────────────────*/

/**
 * Value a pool's reserves in token0 terms at an arbitrary rate, 18 decimals.
 *
 * Valuation is done here rather than on-chain because a fair comparison of two pools has
 * to price both at the *market* rate, not at whatever rate each pool believes.
 */
export function valueReserves({ reserve0, reserve1, dec0, dec1, rate }) {
  const mul0 = 10n ** BigInt(18 - dec0)
  const mul1 = 10n ** BigInt(18 - dec1)
  return BigInt(reserve0) * mul0 + (BigInt(reserve1) * mul1 * BigInt(rate)) / 10n ** 18n
}

/**
 * The profit-maximising arbitrage against a pool, given the true market rate.
 *
 * Profit is concave in trade size, so a ternary search finds the peak without needing a
 * closed form for the stableswap curve. This is what an arbitrageur actually does to a
 * mispriced pool, and running it every day is how the cost of mispricing gets measured
 * rather than asserted.
 */
export async function bestArb({ quote, marketRate, maxIn, dec0, dec1, spotPrice }) {
  const mul0 = 10n ** BigInt(18 - dec0)
  const mul1 = 10n ** BigInt(18 - dec1)
  const r = BigInt(marketRate)

  // Profit of selling `amtIn` of the input token, in 18dp token0 terms.
  const profit = async (zeroForOne, amtIn) => {
    if (amtIn <= 0n) return 0n
    let out
    try { out = await quote(zeroForOne, amtIn) } catch { return 0n }
    if (out <= 0n) return 0n
    return zeroForOne
      ? (out * mul1 * r) / 10n ** 18n - amtIn * mul0   // paid token0, received token1
      : out * mul0 - (amtIn * mul1 * r) / 10n ** 18n   // paid token1, received token0
  }

  // Which way the mispricing runs is decided by the pool's marginal price, so only one
  // direction has to be searched. spotPrice() reports real exchange terms regardless of
  // which rate the pool centres on, so this is valid for both designs.
  let zeroForOne
  if (spotPrice) {
    let spot
    try { spot = await spotPrice() } catch { return { zeroForOne: true, amountIn: 0n, profit: 0n } }
    if (spot === r) return { zeroForOne: true, amountIn: 0n, profit: 0n }
    // Pool prices token1 below the market => buy token1 from it, i.e. sell token0.
    zeroForOne = spot < r
  }

  const search = async (dir) => {
    let a = 0n
    let b = dir ? BigInt(maxIn) : (BigInt(maxIn) * 10n ** 18n) / r
    // Golden-section search: profit is concave in size, and this costs one quote per
    // iteration instead of the two a ternary search needs.
    const PHI_NUM = 618n, PHI_DEN = 1000n
    let c = b - ((b - a) * PHI_NUM) / PHI_DEN
    let d = a + ((b - a) * PHI_NUM) / PHI_DEN
    let fc = await profit(dir, c)
    let fd = await profit(dir, d)
    for (let i = 0; i < 44 && b - a > 1n; i++) {
      if (fc < fd) {
        a = c; c = d; fc = fd
        d = a + ((b - a) * PHI_NUM) / PHI_DEN
        fd = await profit(dir, d)
      } else {
        b = d; d = c; fd = fc
        c = b - ((b - a) * PHI_NUM) / PHI_DEN
        fc = await profit(dir, c)
      }
    }
    const amountIn = fc > fd ? c : d
    return { zeroForOne: dir, amountIn, profit: fc > fd ? fc : fd }
  }

  if (zeroForOne !== undefined) {
    const best = await search(zeroForOne)
    return best.profit > 0n ? best : { zeroForOne, amountIn: 0n, profit: 0n }
  }
  let best = { zeroForOne: true, amountIn: 0n, profit: 0n }
  for (const dir of [true, false]) {
    const cand = await search(dir)
    if (cand.profit > best.profit) best = cand
  }
  return best
}
