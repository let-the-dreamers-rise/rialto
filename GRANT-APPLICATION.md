# Circle Developer Grants — Rialto

Answers against the Cohort 2 Questbook form. Ask: **$100,000 USDC over four milestones.**
Items marked ⚠ need a decision or a fact only the founders can supply.

> On the size of the ask, plainly: Cohort 1 disbursed $5K–$25K per team, median $10K. This
> asks for the program maximum. The justification is not ambition, it is scope — an oracle
> Arc does not have, and FX venues for eight currencies that currently cannot trade on Arc
> at all. Milestones are ordered so that a partial award funds a coherent subset: milestone
> 1 alone puts the oracle and one live corridor on mainnet.

---

## Project

**Name.** Rialto

**One line.** The FX layer for Circle's partner stablecoins on Arc — plus the price oracle
Arc is missing, without which none of it is possible.

**Why now, specifically.** [Arc mainnet goes live on 16 September 2026](https://www.arc.network/blog/arc-mainnet-goes-live-on-september-16-2026).
On that date there is still no price oracle deployed on Arc, and therefore no way for any
venue on it to know what a currency is worth. This is not a problem that arrives later with
scale; it arrives on day one, with the first partner stablecoin pool that tries to quote a
price and centres itself on 1.00 because that is the only number available to it. We have
the oracle deployed and source-verified on testnet now, carrying a live feed, with a pool
and a settled invoice on top of it.

**Problem, and why it matters.** Circle has announced partner stablecoins in BRL, MXN, PHP,
ZAR, JPY, KRW, CAD and AUD. Those currencies trade at roughly 5, 17, 57, 16, 150, 1400, 1.4
and 1.5 to the dollar.

The only venue design deployed on Arc is a Curve-style stableswap, whose invariant is flat —
cheap — around equal balances, meaning a price of **1.00**. None of those currencies is
anywhere near 1.00.

We measured what that does, over a year of real ECB observations, on six corridors,
executing on a real EVM against the deployed contracts:

| Corridor | Range | 1:1 stableswap | Rate-anchored | Lost to arbitrageurs (1:1) |
|---|---|---|---|---|
| USD/BRL | 14.0% | **−33.36%** | +0.31% | 1,014,751 |
| USD/ZAR | 13.5% | **−35.05%** | +0.40% | 1,021,560 |
| USD/PHP | 10.4% | **−35.68%** | −0.29% | 880,996 |
| USD/INR | 10.3% | **−33.01%** | −0.32% | 809,667 |
| USD/TRY | 17.8% | **−39.04%** | −1.20% | 931,393 |
| EUR/USD | 5.6% | −4.83% | −0.17% | 151,118 |

**A third of the liquidity provider's capital, per year.** On EUR/USD the incumbent design
is merely wrong. On the corridors stablecoin payments are actually for, it is a shredder.

The conclusion is uncomfortable and we think it is the most important sentence in this
application: **Circle's partner-stablecoin strategy has no functioning venue on Circle's own
chain.** Every partner deal signed for BRL, MXN, PHP or ZAR lands on a chain where that
currency cannot be traded without handing a third of the liquidity to arbitrageurs within a
year.

The reason is specific and a reviewer can check it in thirty seconds: **Arc ships with no
price oracle.** You cannot centre a pool on a rate you cannot read, so every venue anchors
at 1.00, so the category looks fine until somebody measures a year of it.

**Solution.** Five contracts, all deployed, verified and exercised on Arc testnet. Three
carry the argument:

1. **RialtoOracle** — a pull-based FX feed for Arc. Publishers sign observations off-chain;
   whoever needs a rate carries it in with the transaction that uses it, and the contract
   verifies a quorum on-chain. No keeper pays gas for a price nobody reads, the rate is fresh
   at the point of use, and the *caller* states its own staleness bound.
2. **RialtoPool** — the stableswap invariant applied to rate-scaled balances, so the cheap
   part of the curve sits on the real rate and moves with it.
3. **RialtoSettlement** — the part that makes it a payments rail rather than a venue. An
   invoice is denominated in what the payee *receives*, is paid to a third party, and has to
   carry its reference on-chain for reconciliation. None of those is a swap, which is why
   `swapExactOut` and a settlement contract had to exist.

The other two are what a business actually buys: **RialtoRouter**, multi-hop exact-output
settlement so N corridors give N(N−1)/2 pairs, and **RialtoForward**, a collateralised rate
lock for invoices with terms — because over thirty days a currency moves more than any fee.

**Priced as an FX provider, not a DEX.** A 25bp fee — 27bp all-in on the live book, the
extra 2bp being slippage on a EUR 20 pool — about half of Wise, an order of
magnitude under a bank. The 4bp a stableswap would charge leaves most of the spread on the
table and pays liquidity too little to turn up: at 4bp the same simulation returns LPs
+0.41%, below a Treasury bill. Pricing is what makes the venue exist.

**Why hasn't this been solved?** The oracle is the barrier and it is a chicken-and-egg one.
Arc has no price feed, so a pool has nothing to anchor to, so it anchors at 1.00, so the
category looks like it works until someone measures the LP's year. Rate-scaling itself is
not novel — it is Curve's own rate-provider mechanism. What is new is having a rate to
provide on this chain.

---

## Arc and Circle products

**Are you live on Arc?** Yes, on testnet. Six contracts deployed and **source-verified on
Arcscan**, reading the live USDC (`0x3600…0000`) and EURC (`0x89B5…D72a`), both confirmed
6-decimal:

| Contract | Address |
|---|---|
| `RialtoOracle` | [`0x391c05393778eae959cf16296e308d5538c5754f`](https://testnet.arcscan.app/address/0x391c05393778eae959cf16296e308d5538c5754f) |
| `OracleRateSource` | [`0xda0a00a82455d6a28b4695be97e6fdbfb4d18198`](https://testnet.arcscan.app/address/0xda0a00a82455d6a28b4695be97e6fdbfb4d18198) |
| `RialtoPool` | [`0x089879abc2a71e003a71eb9047acd0d63b1f9cfc`](https://testnet.arcscan.app/address/0x089879abc2a71e003a71eb9047acd0d63b1f9cfc) |
| `RialtoSettlement` | [`0xd8c925d0f500356bb8f87ac52faf4c9439923899`](https://testnet.arcscan.app/address/0xd8c925d0f500356bb8f87ac52faf4c9439923899) |
| `RialtoRouter` | [`0x978e8fe239ed8c7b669687afa55a6310242a1172`](https://testnet.arcscan.app/address/0x978e8fe239ed8c7b669687afa55a6310242a1172) |
| `RialtoForward` | [`0xf49f0ba2e427ee045755199ebf63dbc64fde0751`](https://testnet.arcscan.app/address/0xf49f0ba2e427ee045755199ebf63dbc64fde0751) |

The oracle carries a live EUR/USD print, and **the forward carries a position that was opened,
filled by a second party and settled against that feed** — five transactions on Arc testnet,
linked from the demo page. An importer locked EUR 1,000 at 1.1622 (ECB 2026-09-04); the feed
settled at 1.1652 (ECB 2026-09-09); the lock paid them the 3.00 USDC difference out of the
writer's margin, uncapped, with the collateral accounting balancing to the cent.

**And the headline flow runs.** The pool is seeded from a faucet drip — 23.18 USDC against
EUR 20.00, balanced in value at the oracle rate — and a payer holding only dollars settled
invoice `INV-2026-114` against it: the payee received **exactly EUR 1.00**, the payer paid
1.164 USDC at an effective 1.1624, and the all-in cost was **27bp** — the 25bp fee plus 2bp
of slippage on a book that small. Payer, payee and LP are three separate addresses.

The protocol's share of that is **0.001253 EURC**, or 12.53bp, sitting in `protocolFees1` on
the pool contract. That is the business model as an on-chain balance rather than a
projection, and it is a fraction of a cent because the invoice was one euro: Circle's faucet
meters testnet EURC at 20 per request, so the drip is the whole book. The rate is the claim,
not the total.

**What has not run on-chain is the router.** Multi-hop settlement needs a second seeded
corridor, and a second corridor needs testnet liquidity we do not have. It is deployed,
verified and covered by ten tests, and it has not routed a live trade. Depth across corridors
is the first thing this grant buys.

**Why Arc is core to the flow of value.**

- **USDC is the native gas token**, so the quote, the fee, the LP's inventory and the gas are
  one asset. An FX venue where the numéraire is also the gas token has no second-token
  friction for either side of the trade.
- **Sub-second deterministic finality.** FX arbitrage is a latency game. The window between
  a rate moving and the pool being re-priced is exactly what the LP pays for, and on Arc that
  window is a block.
- **EURC is native on Arc**, and Circle's partner stablecoins — BRL, MXN, JPY, ZAR, PHP —
  trade at roughly 5, 17, 150, 18 and 56 to the dollar. A 1:1 stableswap cannot hold them at
  all. A rate-scaled one treats them exactly like EUR. This is how the design reaches the
  emerging-market corridors Circle has been funding.

**Circle products used.**

| Product | Role | Status |
|---|---|---|
| USDC | Numéraire, gas, and one side of every pair | Native on Arc |
| EURC | The first pair | Live on Arc testnet, verified on-chain |
| Arc | Settlement, and the oracle's home | Testnet; mainnet 16 Sep 2026 |
| Partner stablecoins | Pairs 2..n — the whole point of rate-scaling | As they land |
| CCTP v2 / Gateway | Routing inventory to the pool from other chains | Arc testnet |
| Circle Wallets | LP and publisher key management | Arc testnet |

**StableFX.** Circle's own FX escrow is on Arc (`0xd682…2E10`) but is RFQ, gated to KYB'd
institutions. Rialto is the permissionless layer beneath that gate: the same pair, for
everyone who cannot get an API key. The two are complements, not competitors — an
institution quoting RFQ can hedge into the pool.

---

## Revenue

The swap fee splits between LPs and a protocol treasury, capped **in code** at half, and the
split never changes the payer's price because it comes out of the fee rather than on top of
it. **12.5bp of every swap by construction** — half of 25bp — and 13.4bp of routed volume
over the 259-day simulation. The settled invoice on testnet paid 12.53bp into the pool's
`protocolFees1`, where anyone can read it.

| Daily settled volume | Annual protocol revenue |
|---|---|
| $250k | ~$122,000 |
| $1M | ~$489,000 |
| $10M | ~$4,890,000 |

$1M a day is roughly 200 invoices of $5,000. The team is also the first liquidity provider,
so it earns the LP side on its own inventory as well.

**Why this is worth Circle's money specifically.** The volume is *new*. A DeFi pool recycles
USDC that is already onchain; an invoice settled here is a wire that would otherwise have
gone through correspondent banking, arriving as USDC utility that did not previously exist.
It is the same flow CPN serves at the institutional end, reached from the other direction —
without an intermediary, for businesses too small for a CPN relationship.

## Traction, and what Circle actually funds

Honest position: **pre-launch, on testnet.** Which, on the evidence, is not the obstacle it
is usually assumed to be.

**ViFi Labs received $20,000 in Cohort 1 while deployed on Arc testnet only, with no users
or volume published** — the same amount as Hurupay (50,000 users, $100M transacted) and
Blockradar ($600M processed). Payrit, with 36,000 real transactions and $1.9M of volume,
received $5,000. Award size in that cohort does not track traction, and the pre-traction
team Circle backed at the top of the range was building **decentralised FX for emerging
market currencies** — this exact category.

We take the implication seriously rather than flattering ourselves with it: what got funded
was a credible technical answer in a priority category, on testnet. So this application is
built to be judged on the engineering and the measurements, because that is evidently what
was judged.

What exists:

- `RialtoOracle` (3.7KB), `RialtoPool` (8.7KB), `RialtoSettlement` (2.8KB),
  `RialtoRouter` (4.3KB), `RialtoForward` (6.0KB) — compiling and exercised.
- **71 passing tests** across the oracle (quorum, forged and duplicate signatures, ordering,
  staleness, the deviation ceiling), the pool (pricing at the oracle rate, exact-output
  rounding, protocol fee accounting, imbalance fees, exit without the oracle), settlement,
  multi-hop routing, and forwards (bounded loss, liquidation, grace, zero-sum settlement).
- Three measured results on real ECB data, each reproducible with one command: the 259-day
  EUR/USD comparison, the six-corridor comparison, and the amplification study.
- `REVIEW.md`: an adversarial review that found and fixed an unbounded oracle failure mode
  — a compromised publisher set could take 37.8% of a pool's book in one print, now bounded
  at ~3.2% — and measured what remains exploitable.
- **Six contracts deployed and source-verified on Arc testnet**, carrying a settled invoice
  (`INV-2026-114`, payee received exactly EUR 1.00, 27bp all-in, three separate addresses)
  and a settled forward (EUR 1,000 locked at 1.1622, settled at 1.1652, 3.00 USDC paid) —
  not a testnet deployment that merely exists, but one a reviewer can audit transaction by
  transaction.

**Demo video.** Recorded from the live page by `npm run video` — a scripted Playwright
walkthrough with the real transactions, the 60-second oracle bound reverting on camera and
the 15-minute one succeeding, captions burned in, offline-synthesised narration. Two cuts:
1:50 silent-with-captions and 2:38 narrated. Both reproducible from the repository;
`scripts/narrate/README.md` has the voice pipeline.

**Video:** https://rialto-arc.netlify.app/rialto-demo.mp4 (narrated cut, hosted with the
demo; also embedded at the foot of the page).

⚠ Before submitting: the legal entity and founder bios.

## Where this sits next to what is already on Arc

Two teams are already doing FX on Arc, and the honest framing is not that they are doing it
wrong. It is that **all three of us are working under the same missing primitive.**

ViFi Labs builds an AMM for correlated assets. Lunex runs a Curve-style stableswap on
USDC/EURC. Both designs approximate an external rate, because on Arc there is nothing else
available: **no price oracle is deployed on the chain.** Circle's own prediction-market
sample app has to bootstrap UMA for the same reason. Nobody can anchor a pool to EUR/USD or
USD/NGN when EUR/USD and USD/NGN cannot be read on-chain.

The measurements in this application are about that constraint, not about those teams. A
pool with no external anchor loses 33–39% of its liquidity a year on the emerging-market
corridors, and 4.8% on the friendliest pair available. That is what the absence of an
oracle costs the Arc ecosystem, and the number is the same whoever deployed the pool.

So the sequencing matters more than the competition:

1. **The oracle is the unlock, and it is not ours to keep.** It is permissionless to read.
   ViFi's correlated-asset AMM becomes rate-aware with it. Lunex's stableswap can re-centre
   with it. Any lending market, perp, prediction market or treasury product on Arc that is
   currently blocked on a price feed becomes buildable. Milestone 3 is explicitly about
   handing it over — independent publishers, any pair on request, documented for third-party
   integration.
2. **Our pools are the reference implementation**, not the moat. They exist to prove the
   primitive works and to be the first venue that uses it properly.
3. **Settlement, routing and forwards are the product.** Exact-output invoices, N(N−1)/2
   corridors from N pools, and rate locks for invoices with terms — the parts a business
   actually buys, which no AMM on Arc offers today.

If Circle funds one thing here, fund the oracle. It lifts every FX team on the chain
including the two already in the portfolio, and it is the piece none of us can build as a
side effect of shipping a pool.

## Milestones — $100,000 USDC

| # | Deliverable | Metric | Weeks | USDC |
|---|---|---|---|---|
| 1 | Oracle + USDC/EURC live on **Arc mainnet in launch week**; publisher set at 2-of-3 on an intraday source; a settlement front end a business can use without a terminal | Verified mainnet addresses on Arcscan; 14 days continuous publishing inside the 15-minute bound; 100 settled invoices | 4 | 20,000 |
| 2 | Corridors for every Circle partner stablecoin that has shipped — BRL, MXN, PHP, ZAR first; oracle publishing all pairs; settlement API and SDK | ≥4 corridors live; **$500k settled volume**; ≥3 external publishers | 10 | 25,000 |
| 3 | Oracle hardened and documented as public infrastructure: independent publisher set, feed for any pair on request, integration guide | ≥2 external protocols reading the feed; ≥8 pairs published; third-party security review published | 16 | 25,000 |
| 4 | Depth where it matters: LP programme, routing so payment apps settle through it, published corridor economics | **$5M settled volume**; ≥25 paying businesses; ≥2 payment apps integrated | 24 | 30,000 |

Metrics are settled volume, live corridors and paying businesses — not TVL. Milestone 1 is
dated by Circle's own calendar: **Arc mainnet is 16 September 2026**, and the correctly
priced FX layer existing in launch week rather than a year later is most of the value here.

Milestone 3 is the one we would argue hardest for. The oracle is not part of our product in
any defensible sense — it is the thing Arc is missing, and every lending market, perp,
prediction market and treasury product on the chain needs it. Funding it as public
infrastructure is worth more to Circle than funding our pools.

## Ecosystem impact

Two things, and the first is bigger than our product.

**Arc has no price feed.** Not a bad one — none. Every lending market, perpetual, prediction
market, treasury product and structured product on the chain needs one, and none of them can
ship without it. Circle's own prediction-market sample app has to bootstrap UMA because
there is nothing native to read. We built a pull-based, permissionless-to-read oracle and
milestone 3 is about handing it to the ecosystem rather than keeping it: independent
publishers, any pair on request, documented for third-party integration.

**Every partner stablecoin becomes tradeable.** The rate-scaling is currency-agnostic — the
measurements above cover five non-EUR corridors and the code path is identical for all of
them. Each new Circle partner stablecoin is a configuration change, not an engineering
project. That converts Circle's partner deals from announcements into working liquidity.

## Team

⚠ **Founders, bios, entity and location to be completed.** What the record supports: the
technical lead has shipped a production multi-tenant application with webhook-driven billing
and tenant isolation, and this codebase — stableswap math with Newton iteration, EIP-712
signature verification, an oracle with quorum and circuit breaker, 71 tests, a 259-day
backtest on real central-bank data, and a live testnet deployment that has settled both an
invoice and a forward — was built to a working, measured state.

⚠ **Decide before submitting:** legal entity and where incorporated; whether both founders
are full-time (Cohort 1 asked, and it correlates with selection); Circle Developer Console
email; GitHub, X, website, demo video; conflict-of-interest declaration.

An India-based team is fine here. Rialto performs no regulated activity: it is non-custodial
software with no fiat leg, no on- or off-ramp, and no discretionary control of user funds.
Questbook's terms state grantees "may not perform regulated activities themselves", which
this satisfies by construction.

---

## Risks, stated plainly

**A one-publisher oracle is a trusted oracle.** The contract supports M-of-N and the deploy
script takes a publisher list, but a first deployment at quorum 1 means the deployer can set
the rate, and therefore the price the pool trades at. On the testnet deployment that one key
is also the oracle admin, the pool treasury and the sole LP. This is the main open risk;
milestone 1 takes it to 2-of-3 and milestone 3 to an independent set. It is a coordination
problem, not a code problem. A related one: the current feed is the ECB's daily reference
rate re-attested every ten minutes to stay inside the pool's bound — a real value with an
implied frequency it does not have. Milestone 1 replaces it with an intraday source.

**Liquidity is the cold start.** The design does not create depth; it stops depth from
leaking. Bootstrapping is the team's own inventory plus whoever the measured +2.32% attracts.
That return is what makes the problem tractable rather than circular, but it is still the
hardest part of the first ninety days.

**Distribution is the real risk, and it is not a code problem.** Settling invoices needs
businesses with invoices to settle. The engine being correct does not produce them. What the
founders bring to that — an existing corridor, a trade relationship, a payments partner — is
the part of this application a reviewer should press hardest on, and it is ⚠ for the founders
to answer rather than something the repository can demonstrate.

**We may be wrong about the measurement, and it is falsifiable on purpose.** The comparison
runs both designs through identical trades on real ECB data and the harness is in the repo,
so anyone — including the teams already building FX on Arc — can re-run it, change the
assumptions, and show a different answer. A claim about pool design that could not be
checked would not be worth making.

**Two teams are ahead of us on Arc.** ViFi and Lunex are both live on testnet with FX pools,
and both have a head start on liquidity and relationships. Our position is not that they are
doing it wrong; it is that the primitive all three of us need does not exist yet, and we
built it. If they adopt the oracle, that is the grant working.

**A pool is only as good as its worst day.** The circuit breaker bounds a single bad
attestation to a 10% move while the previous one is fresh, widening with staleness to a hard
25% ceiling it never exceeds, and proportional withdrawal never consults the oracle, so a
dead feed stops trading rather than trapping LPs. Neither of those makes a compromised
publisher set harmless: `REVIEW.md` measures ~3.6% of the book as extractable in one print.

---

## Positioning notes for the founders

Cohort 1 disbursed $5K–$25K per team (median $10K). The ask is the programme maximum and the
note at the top says why; if a reviewer pushes back on size, milestone 1 alone is $20K,
inside that band, and is a coherent deliverable on its own. The open cohort was running at
roughly 1–3% acceptance (8 of 677 at the time of research).

The two things that most move an application are a **verified contract address on Arc** and
a **demonstration**. Both are now in hand, and the demonstration is two things at once: a
reproducible backtest on central-bank data showing the incumbent design losing a third of LP
capital a year on the corridors that matter, and a testnet deployment where a reviewer can
open the transaction that paid a payee exactly what they were billed. Very few applications
contain a number that someone else can check; fewer contain a hash.

Lead with the oracle gap, not the pool. "Arc has no price feed" is a fact a reviewer can
verify in thirty seconds — and from 16 September it is a fact about mainnet.
