const pptxgen = require('pptxgenjs')
const pres = new pptxgen()
pres.layout = 'LAYOUT_16x9'          // 10 x 5.625 in
pres.author = 'Ashwin Goyal'; pres.title = 'Rialto — Circle Developer Grants Cohort 2'

const INK = '0B0B0B', PAPER = 'FFFFFF', SUNK = 'F4F3EF', MUTE = '6B6A64', ORANGE = 'EB6834', BLUE = '2A78D6', OK = '1BAF7A'
const F = 'Calibri', FH = 'Arial'
const T = (s, x, y, w, h, o = {}) => s.addText(o.text ?? o._t ?? '', { x, y, w, h, fontFace: F, isTextBox: true, margin: 0, ...o })

function dark(title, kicker, sub, foot) {
  const s = pres.addSlide(); s.background = { color: INK }
  T(s, 0.7, 0.7, 8.6, 0.3, { text: kicker, fontSize: 11, color: '8D8B82', charSpacing: 4, bold: true })
  T(s, 0.7, 1.35, 8.6, 2.0, { text: title, fontSize: 40, color: 'FFFFFF', bold: true, fontFace: FH, valign: 'top' })
  if (sub) T(s, 0.7, 3.5, 8.0, 1.2, { text: sub, fontSize: 18, color: 'C3C2B7', valign: 'top' })
  if (foot) T(s, 0.7, 4.95, 8.6, 0.35, { text: foot, fontSize: 11, color: '8D8B82', fontFace: 'Courier New' })
  return s
}
function light(title, kicker) {
  const s = pres.addSlide(); s.background = { color: PAPER }
  T(s, 0.6, 0.45, 8.8, 0.3, { text: kicker, fontSize: 10.5, color: MUTE, charSpacing: 4, bold: true })
  T(s, 0.6, 0.75, 8.8, 0.8, { text: title, fontSize: 28, color: INK, bold: true, fontFace: FH, valign: 'top' })
  return s
}
const stat = (s, x, y, w, big, label, color = INK) => {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h: 1.55, fill: { color: SUNK }, line: { color: 'E6E5E0', width: 0.75 }, rectRadius: 0.08 })
  T(s, x + 0.2, y + 0.18, w - 0.4, 0.75, { text: big, fontSize: 30, bold: true, color, fontFace: FH, valign: 'top' })
  T(s, x + 0.2, y + 0.95, w - 0.4, 0.5, { text: label, fontSize: 11.5, color: MUTE, valign: 'top' })
}

// 1 · title
dark('Pay a foreign invoice\nin one transaction.', 'RIALTO · CIRCLE DEVELOPER GRANTS · COHORT 2',
  'Cross-border settlement on Arc at the FX rate that actually exists — built on the price oracle Arc launches without.',
  'rialto-arc.netlify.app  ·  github.com/let-the-dreamers-rise/rialto  ·  live on Arc testnet')

// 2 · problem
{ const s = light('A supplier bills you €5,000. You hold dollars.', 'THE PROBLEM')
  stat(s, 0.6, 1.75, 2.75, '40–60bp', 'through a payments provider, one to three days', ORANGE)
  stat(s, 3.62, 1.75, 2.75, '200–300bp', 'through a bank, with nothing linking it to the invoice', ORANGE)
  stat(s, 6.65, 1.75, 2.75, '0', 'price oracles deployed on Arc, three days before mainnet', ORANGE)
  T(s, 0.6, 3.6, 8.8, 1.5, { text: [
    { text: 'Circle has announced partner stablecoins in BRL, MXN, PHP, ZAR, JPY, KRW, CAD and AUD — none trading near 1.00. ', options: { fontSize: 14, color: INK } },
    { text: 'The only venue design on Arc is a stableswap that is cheapest at exactly 1.00, because a pool cannot centre on a rate the chain cannot read.', options: { fontSize: 14, color: MUTE } },
  ], valign: 'top' }) }

// 3 · measurement (native chart)
{ const s = light('What a pool with no oracle loses in a year', 'MEASURED · 259 REAL ECB OBSERVATIONS · SIX CORRIDORS')
  s.addChart(pres.ChartType.bar, [
    { name: '1:1 stableswap', labels: ['USD/BRL', 'USD/ZAR', 'USD/PHP', 'USD/INR', 'USD/TRY', 'EUR/USD'], values: [-33.36, -35.05, -35.68, -33.01, -39.04, -4.83] },
    { name: 'Rate-anchored', labels: ['USD/BRL', 'USD/ZAR', 'USD/PHP', 'USD/INR', 'USD/TRY', 'EUR/USD'], values: [0.31, 0.40, -0.29, -0.32, -1.20, -0.17] },
  ], { x: 0.6, y: 1.55, w: 5.9, h: 3.6, barDir: 'col', barGrouping: 'clustered', chartColors: [ORANGE, BLUE],
    showLegend: true, legendPos: 'b', legendFontSize: 10, legendColor: MUTE,
    showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 8, dataLabelColor: MUTE, dataLabelFormatCode: '0.0"%"',
    catAxisLabelColor: MUTE, catAxisLabelFontSize: 10, valAxisLabelColor: MUTE, valAxisLabelFontSize: 9,
    valGridLine: { color: 'ECEAE4', size: 0.5 }, catGridLine: { style: 'none' }, valAxisLabelFormatCode: '0"%"' })
  T(s, 6.8, 1.65, 2.6, 3.5, { text: [
    { text: 'LP return, per year', options: { bold: true, fontSize: 13, color: INK, breakLine: true } },
    { text: 'Two pools identical in every respect except where their liquidity sits. Same invariant, amplification, fee and trades.', options: { fontSize: 11.5, color: MUTE, breakLine: true, paraSpaceAfter: 8 } },
    { text: 'A third of the LP\'s capital, handed to arbitrageurs.', options: { fontSize: 13, color: ORANGE, bold: true, breakLine: true, paraSpaceAfter: 8 } },
    { text: 'Reproducible: npm run corridors', options: { fontSize: 10.5, color: MUTE, fontFace: 'Courier New' } },
  ], valign: 'top' }) }

// 4 · solution
{ const s = light('Five contracts, deployed and source-verified on Arc testnet', 'THE SOLUTION')
  const rows = [
    ['RialtoOracle', 'Pull-based FX feed. Publishers sign EIP-712 attestations; the caller names its own staleness bound; a circuit breaker caps any print at 10% fresh, 25% ever.'],
    ['RialtoPool', 'Stableswap on rate-scaled balances — the cheap part of the curve sits on the real rate and moves with it. 25bp, half to LPs, half to the protocol, in code.'],
    ['RialtoSettlement', 'Exact-output invoice settlement: denominated in what the payee receives, paid to a third party, reference and rate emitted on-chain.'],
    ['RialtoRouter', 'Multi-hop exact-output: N corridors give N(N−1)/2 pairs.'],
    ['RialtoForward', 'Collateralised, cash-settled rate locks for invoices with terms.'],
  ]
  rows.forEach(([n, d], i) => {
    const y = 1.6 + i * 0.72
    s.addShape(pres.ShapeType.ellipse, { x: 0.6, y: y + 0.06, w: 0.36, h: 0.36, fill: { color: i < 3 ? ORANGE : BLUE }, line: { color: PAPER, width: 0 } })
    T(s, 0.6, y + 0.06, 0.36, 0.36, { text: String(i + 1), fontSize: 12, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' })
    T(s, 1.15, y, 2.2, 0.5, { text: n, fontSize: 13.5, bold: true, color: INK, fontFace: 'Courier New', valign: 'top' })
    T(s, 3.35, y, 6.05, 0.7, { text: d, fontSize: 11.5, color: MUTE, valign: 'top' })
  }) }

// 5 · live proof (dark)
{ const s = dark('Live on Arc testnet.\nNot a diagram.', 'DEMONSTRATED · EVERY HASH OPENS ON ARCSCAN')
  const cells = [
    ['EUR 1.00', 'received by the payee, exactly as billed', OK],
    ['27bp', 'all-in: 25bp fee + 2bp slippage on a EUR 20 book', 'FFFFFF'],
    ['3.00 USDC', 'paid by a settled EUR 1,000 forward — exactly the rate move', 'FFFFFF'],
    ['0.001253 EURC', 'protocol revenue from that invoice, on-chain in protocolFees1', OK],
  ]
  cells.forEach(([b, l, c], i) => {
    const x = 0.7 + (i % 2) * 4.45, y = 3.35 + Math.floor(i / 2) * 1.0
    T(s, x, y, 4.2, 0.5, { text: b, fontSize: 22, bold: true, color: c, fontFace: FH })
    T(s, x, y + 0.5, 4.2, 0.4, { text: l, fontSize: 11, color: '8D8B82' })
  })
  T(s, 0.7, 5.0, 8.6, 0.35, { text: 'Oracle updating every 10 minutes unattended · six contracts verified · payer, payee and LP three separate addresses', fontSize: 10.5, color: '8D8B82', fontFace: 'Courier New' }) }

// 6 · business model
{ const s = light('How it makes money', 'REVENUE · ENFORCED IN CODE')
  stat(s, 0.6, 1.6, 2.75, '25bp', 'the fee — half of Wise, an order of magnitude under a bank')
  stat(s, 3.62, 1.6, 2.75, '12.5bp', 'of everything settled goes to the protocol; the split is capped at half by the contract', ORANGE)
  stat(s, 6.65, 1.6, 2.75, '12.53bp', 'what the testnet invoice actually paid — read off the pool, not projected', OK)
  s.addTable([
    [{ text: 'Daily settled volume', options: { bold: true, color: MUTE, fontSize: 11 } }, { text: 'Annual protocol revenue', options: { bold: true, color: MUTE, fontSize: 11 } }],
    ['$250k', '~$122,000'], ['$1M  (≈200 invoices of $5,000)', '~$489,000'], ['$10M', '~$4,890,000'],
  ], { x: 0.6, y: 3.45, w: 8.8, colW: [4.4, 4.4], fontFace: F, fontSize: 13, color: INK, border: { type: 'solid', color: 'E6E5E0', pt: 0.5 }, fill: { color: PAPER }, rowH: 0.36 })
  T(s, 0.6, 5.0, 8.8, 0.35, { text: 'The volume is new: an invoice settled here is a wire that would otherwise have gone through correspondent banking.', fontSize: 11, color: MUTE }) }

// 7 · which part of the payment
{ const s = light('Which part of the payment this is', 'SCOPE · SAID PLAINLY')
  const cols = [
    ['Getting in — not us', 'Circle Mint, an exchange, or a USDC balance the business already holds.', SUNK, MUTE],
    ['The FX leg — this', 'USDC to the exact euro amount billed, at the real rate, 25bp, one transaction, invoice reference on-chain. Nothing on Arc could do this.', INK, 'FFFFFF'],
    ['Getting out — not us', 'The payee holds EURC, or cashes to a local account through a partner — several are Circle grantees.', SUNK, MUTE],
  ]
  cols.forEach(([h, d, bg, fg], i) => {
    const x = 0.6 + i * 3.0
    s.addShape(pres.ShapeType.roundRect, { x, y: 1.7, w: 2.8, h: 2.7, fill: { color: bg }, line: { color: 'E6E5E0', width: 0.75 }, rectRadius: 0.08 })
    T(s, x + 0.22, 1.9, 2.4, 0.5, { text: h, fontSize: 14, bold: true, color: bg === INK ? 'FFB38A' : INK, valign: 'top' })
    T(s, x + 0.22, 2.45, 2.4, 1.8, { text: d, fontSize: 12, color: fg, valign: 'top' })
  })
  T(s, 0.6, 4.65, 8.8, 0.6, { text: 'No KYC, no fiat ramps, no local payout, no licence to hold client money. Circle already funds that network; what it cannot do today is convert at a rate the chain can verify.', fontSize: 11.5, color: MUTE, valign: 'top' }) }

// 8 · why now
{ const s = dark('Arc mainnet:\n16 September 2026.', 'WHY NOW',
  'On that date there is still no price oracle on Arc. The first partner-stablecoin pool that tries to quote will centre on 1.00 — because that is the only number available to it. This is a day-one problem, not a someday problem.',
  'arc.network/blog/arc-mainnet-goes-live-on-september-16-2026') }

// 9 · distribution
{ const s = light('Distribution without a network — concretely', 'ONE FOUNDER · NO RELATIONSHIPS · A PLAN THAT DOES NOT NEED THEM')
  const ch = [
    ['1', 'The two FX teams on Arc need the oracle', 'ViFi and Lunex run pools that cannot read a price. Offer the feed publicly; ask Circle for the intro. Weeks 1–4.'],
    ['2', 'Circle\'s payment grantees are the integrators', 'Hurupay, Blockradar, Payrit move USDC for customers paid in a second currency. A one-page settlement offer + live sandbox. Weeks 2–8.'],
    ['3', 'Launch week', 'Arc ecosystem directory; the "Arc has no oracle" measurement as a technical post with the harness attached. Weeks 0–2.'],
    ['4', 'India, when the INR stablecoin ships', 'Largest recipient of cross-border service payments; USD/INR already simulated at −33%/yr for 1:1 pools.'],
  ]
  ch.forEach(([n, h, d], i) => {
    const x = 0.6 + (i % 2) * 4.5, y = 1.6 + Math.floor(i / 2) * 1.75
    s.addShape(pres.ShapeType.ellipse, { x, y: y + 0.04, w: 0.34, h: 0.34, fill: { color: ORANGE }, line: { color: PAPER, width: 0 } })
    T(s, x, y + 0.04, 0.34, 0.34, { text: n, fontSize: 11, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' })
    T(s, x + 0.5, y, 3.8, 0.45, { text: h, fontSize: 13, bold: true, color: INK, valign: 'top' })
    T(s, x + 0.5, y + 0.45, 3.8, 1.2, { text: d, fontSize: 11, color: MUTE, valign: 'top' })
  })
  T(s, 0.6, 5.05, 8.8, 0.35, { text: 'The first customers of an FX primitive are protocols and payment apps — reached through an address and an ABI, which one person can produce and has.', fontSize: 11, color: MUTE }) }

// 10 · milestones & ask
{ const s = light('Milestones — $100,000 USDC over 24 weeks', 'THE ASK')
  const hdr = (t) => ({ text: t, options: { bold: true, color: MUTE, fontSize: 10.5, fill: { color: SUNK } } })
  s.addTable([
    [hdr('#'), hdr('Deliverable'), hdr('Metric'), hdr('Wk'), hdr('USDC')],
    ['1', 'Oracle + USDC/EURC on Arc mainnet in launch week; 2-of-3 publishers on an intraday source; settlement front end', 'Verified mainnet addresses; 14 days publishing; 100 settled invoices', '4', '20,000'],
    ['2', 'A corridor per shipped partner stablecoin — BRL, MXN, PHP, ZAR first; CCTP v2 / Gateway; settlement API + SDK', '≥4 corridors; $500k settled; ≥3 external publishers', '10', '25,000'],
    ['3', 'Oracle as public infrastructure: independent publishers, any pair on request, integration guide, security review', '≥2 external protocols reading it; ≥8 pairs', '16', '25,000'],
    ['4', 'Depth: LP programme, payment-app routing, Circle Wallets, published corridor economics', '$5M settled; ≥25 paying businesses; ≥2 apps', '24', '30,000'],
  ], { x: 0.6, y: 1.6, w: 8.8, colW: [0.35, 4.0, 3.05, 0.5, 0.9], fontFace: F, fontSize: 10, color: INK, border: { type: 'solid', color: 'E6E5E0', pt: 0.5 }, valign: 'top', rowH: [0.3, 0.72, 0.72, 0.72, 0.72] })
  T(s, 0.6, 5.0, 8.8, 0.4, { text: 'Milestone 1 alone is a coherent deliverable. Milestone 3 is the one worth arguing for: every lending market, perp and prediction market on Arc needs a feed, and none exists.', fontSize: 11, color: MUTE, valign: 'top' }) }

// 11 · team
{ const s = pres.addSlide(); s.background = { color: INK }
  T(s, 0.7, 0.55, 8.6, 0.3, { text: 'TEAM · ASHWIN GOYAL · INDIVIDUAL · INDIA · STUDENT · FULL-TIME', fontSize: 11, color: '8D8B82', charSpacing: 4, bold: true })
  T(s, 0.7, 0.95, 8.6, 1.0, { text: 'I build systems a stranger can re-derive.\nThen I attack them.', fontSize: 27, color: 'FFFFFF', bold: true, fontFace: FH, valign: 'top' })
  T(s, 0.7, 2.05, 5.0, 0.25, { text: 'SHIPPED BEFORE RIALTO', fontSize: 9.5, color: '6B6A64', charSpacing: 3, bold: true })
  const rows = [
    ['Germline', 'Verifiable AI-configuration tuning, live on 0G mainnet; every step recorded on-chain.', 'FFFFFF'],
    ['BIP 360 conformance', 'From-scratch implementation vs the official reference, 13 vectors and 2,000 random trees: two real gaps found in the reference.', 'FFFFFF'],
    ['rein', 'A smart account an agent can operate and cannot drain. Verified source; six attacks lost nothing. 46 tests.', 'FFFFFF'],
    ['proofflow', 'Revenue-based credit for emerging-market SMBs on Solana, built on USDC and CCTP, Arcium MPC. Live.', 'FFB38A'],
    ['economic-immune-system', 'Transaction authorisation against a budget policy, built on Circle Developer Controlled Wallets.', 'FFB38A'],
  ]
  rows.forEach(([n, d, c], i) => {
    const y = 2.35 + i * 0.5
    T(s, 0.7, y, 1.45, 0.48, { text: n, fontSize: 10.5, bold: true, color: c, valign: 'top' })
    T(s, 2.2, y, 3.5, 0.48, { text: d, fontSize: 9.5, color: 'C3C2B7', valign: 'top' })
  })
  T(s, 0.7, 4.85, 5.0, 0.4, { text: 'So CCTP and Circle Wallets, marked planned in the milestones, are products I have already shipped with. What is new is Arc, and the primitive Arc is missing.', fontSize: 9, color: '8D8B82', italic: true, valign: 'top' })
  T(s, 6.1, 2.05, 3.2, 0.25, { text: 'RIALTO · NINE DAYS · ONE PERSON', fontSize: 9.5, color: '6B6A64', charSpacing: 3, bold: true })
  const stats = [['6', 'contracts, source-verified on Arc', 'FFFFFF'], ['71', 'passing tests', 'FFFFFF'], ['259', 'days of ECB data, six corridors', 'FFFFFF'],
    ['37.8→3.2%', 'oracle failure mode, found and bounded', OK], ['1 + 1', 'invoice and forward, settled on-chain', OK], ['4:34', 'demo video, reproducible from the repo', 'FFFFFF']]
  stats.forEach(([b, l, c], i) => {
    const x = 6.1 + (i % 2) * 1.65, y = 2.35 + Math.floor(i / 2) * 0.82
    T(s, x, y, 1.6, 0.4, { text: b, fontSize: 20, bold: true, color: c, fontFace: FH })
    T(s, x, y + 0.4, 1.6, 0.4, { text: l, fontSize: 8.5, color: '8D8B82', valign: 'top' })
  })
  T(s, 0.7, 5.15, 8.6, 0.3, { text: 'github.com/let-the-dreamers-rise · 123 repositories · 901 contributions in the last year · rialto-arc.netlify.app', fontSize: 10, color: '8D8B82', fontFace: 'Courier New' }) }

pres.writeFile({ fileName: 'rialto-deck.pptx' }).then((f) => console.log('wrote', f))
