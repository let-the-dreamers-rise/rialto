# Rialto

**Pay a foreign invoice in one transaction.**

A supplier bills you €5,000. You hold dollars. Today that costs 40–60bp through a payments
provider or 200–300bp through a bank, takes one to three days, and arrives with nothing
linking it back to the invoice. Rialto settles it onchain at **25bp**, at the FX rate that
actually exists, and the payee receives exactly €5,000 — not "about" €5,000.

For importers, exporters and agencies paying cross-border invoices: the businesses too small
for a bank's FX desk.

**Live demo:** https://rialto-arc.netlify.app

None of it is possible without reading the real FX rate on-chain, and Arc ships with no price
oracle. So that came first, and it is live now:

| Contract | Address |
|---|---|
| `RialtoOracle` | [`0x391c05393778eae959cf16296e308d5538c5754f`](https://testnet.arcscan.app/address/0x391c05393778eae959cf16296e308d5538c5754f) |
| `RialtoPool` | [`0xee754d16908335a13c0c2b938a8c897a9cf694c4`](https://testnet.arcscan.app/address/0xee754d16908335a13c0c2b938a8c897a9cf694c4) |
| `OracleRateSource` | [`0xda0a00a82455d6a28b4695be97e6fdbfb4d18198`](https://testnet.arcscan.app/address/0xda0a00a82455d6a28b4695be97e6fdbfb4d18198) |

Reading the rate takes one call and no permission:

```solidity
(uint256 rate, uint64 observedAt) =
    IRialtoOracle(0x391c05393778eae959cf16296e308d5538c5754f)
        .getRate(keccak256("EUR/USD"), 900);   // reverts if older than your bound
```

All three are **source-verified on Arcscan**, so the code at those addresses can be read
rather than trusted. An update costs **0.0017 USDC**. Anyone on Arc can read the feed — it is
not ours to keep, and nothing on that chain could read an FX rate before it existed.

Reproduce the verification with `npm run verify`.

---

# Rialto

**The FX layer for Circle's partner stablecoins, on Arc.**

Circle has announced partner stablecoins in BRL, MXN, PHP, ZAR, JPY, KRW, CAD and AUD.
Those currencies trade at roughly 5, 17, 57, 16, 150, 1400, 1.4 and 1.5 to the dollar.

The only venue design deployed on Arc today is a Curve-style stableswap, whose invariant is
flat — cheap — around *equal balances*, meaning a price of **1.00**. None of those
currencies is anywhere near 1.00.

So we measured what that does, over a year of real ECB observations, on six corridors,
executing on a real EVM against the deployed contracts:

| Corridor | Range | 1:1 stableswap | Rate-anchored | Lost to arbitrageurs (1:1) |
|---|---|---|---|---|
| USD/BRL | 14.0% | **−33.36%** | +0.31% | 1,014,751 |
| USD/ZAR | 13.5% | **−35.05%** | +0.40% | 1,021,560 |
| USD/PHP | 10.4% | **−35.68%** | −0.29% | 880,996 |
| USD/INR | 10.3% | **−33.01%** | −0.32% | 809,667 |
| USD/TRY | 17.8% | **−39.04%** | −1.20% | 931,393 |
| EUR/USD | 5.6% | −4.83% | −0.17% | 151,118 |

**A third of the liquidity, per year.** On EUR/USD the incumbent design is merely wrong. On
the corridors that stablecoin payments are actually for, it is a shredder — and those are
precisely the currencies Circle has been signing partner-stablecoin deals to support.

Circle's partner-stablecoin strategy has no functioning venue on Circle's own chain.

That is not a criticism of the teams already building FX on Arc — ViFi Labs and Lunex are
both live on testnet, and both are working under the same constraint. **No price oracle is
deployed on Arc.** Circle's own prediction-market sample has to bootstrap UMA for the same
reason. Nobody can anchor a pool to a rate the chain cannot read, so every design has to
approximate one, and the table above is what that approximation costs — whoever deployed
the pool.

So the oracle comes first, and it is permissionless to read. It makes our pools work. It
would make theirs work too.

The reason nobody fixed it is specific and checkable in thirty seconds: **Arc ships with no
price oracle.** You cannot centre a pool on a rate you cannot read. So Rialto is three
things — the oracle Arc is missing, an FX engine centred on the real rate, and invoice
settlement on top.

> Method note, stated because it cuts against us: corridors are sampled weekly rather than
> daily, which gives both pools one fifth of the retail flow and therefore one fifth of the
> fee income. That makes the rate-anchored column look *worse* than the daily EUR/USD run,
> where it returns **+2.32%**. The comparison between columns is unaffected — both pools see
> identical trades.

## What settling an invoice looks like

```
payee issues   EUR 5,000, ref INV-2026-114, expires in 30 minutes
payer sends    one transaction, bounded at 6,500 USDC
                 │
                 ├── oracle rate carried in and verified on-chain
                 ├── exact-output swap: the payee gets 5,000 EURC, not "about" 5,000
                 └── InvoiceSettled(ref, payer, payee, amountIn, amountOut, effectiveRate)
payee receives exactly EUR 5,000, sub-second, reconciled by reference
```

Three things there are not swaps. A swap is denominated in what you put *in*; an invoice is
denominated in what the payee gets *out*. A swap pays the caller; an invoice pays a third
party. And a swap emits amounts, where reconciliation needs the reference on-chain beside
them. `swapExactOut` and `RialtoSettlement` exist because of those three gaps.

**Priced as an FX provider, not a DEX.** 25bp all-in: roughly half of Wise and an order of
magnitude under a bank. A 4bp stableswap fee leaves most of the spread on the table and pays
liquidity too little to show up.

## Why this design can be deep, and a 1:1 pool cannot

Amplification concentrates liquidity at the curve's centre. Every stableswap has to keep it
moderate, because concentration is a bet that the pair stays near that centre and a peg
leaving it at high amplification is ruinous.

**A rate-anchored pool has no peg to leave.** The centre tracks the rate. So the constraint
that caps amplification everywhere else does not apply, and the same capital can quote much
larger tickets:

| Invoice | amp=200 | amp=1000 | amp=5000 | amp=20000 |
|---|---|---|---|---|
| $100,000 | 30.0bp | 26.0bp | 25.0bp | 25.0bp |
| $250,000 | 38.0bp | 27.0bp | 25.0bp | 25.0bp |
| $500,000 | **58.0bp** | 31.0bp | **26.0bp** | 25.0bp |

On a $2.33M book, raising amplification takes a $500,000 invoice from *losing* to Wise
(58bp) to comfortably beating it (26bp) — the same liquidity, serving institutional tickets.

It is a trade, not a free lunch, and the year-long run prices it: the rate-anchored pool
returns **+1.87% at amp 5000 against +2.32% at amp 200**. About 45bp of LP yield buys
better-than-half the spread on large tickets. For a payments venue that is plainly worth it,
because large tickets are where the volume is.

What is *not* a trade is what the same change does to the 1:1 design:

| Over 259 days, amp 5000 | 1:1 stableswap | Rate-anchored |
|---|---|---|
| Lost to arbitrageurs | **4,126,168 (177% of the book)** | 29,981 (1.3%) |
| LP return vs holding | −1.54% | **+1.87%** |
| Closing EURC reserve | **7,457** of 1,000,000 | 1,384,741 |

The 1:1 pool churns nearly twice its own book to arbitrageurs over the year and finishes
holding 7,457 euros of the million it opened with. Concentrating liquidity at a price that
never occurs simply concentrates the losses. **The rate anchor is the precondition for
depth**, which is the whole argument for building the oracle first.

## Two things spot execution cannot fix

**An invoice has terms.** "R$1,000,000, due in 30 days" means the payer learns their dollar
cost a month after agreeing the price. BRL ranged 14% over the year measured above; TRY
ranged 17.8%. Against that, being 25bp cheaper than a bank is noise — a business does not
lie awake over a quarter of a percent, it lies awake over the three percent it cannot
predict. That is why exporters accept bad forward rates from banks: certainty is worth more
than price. `RialtoForward` is a collateralised, cash-settled rate lock on the oracle, so an
importer can fix today's rate for a payment due next month.

**The pair you need usually has no pool.** A Brazilian importer paying a Philippine supplier
needs BRL→PHP, which will never exist: liquidity for every ordered pair is N² pools. Routing
through USDC inverts that — **N corridors give N(N−1)/2 pairs.** Six pools is fifteen pairs;
Circle's eight announced partner stablecoins would be twenty-eight, from eight pools.
`RialtoRouter` solves a route *backwards* from the payee, because an invoice is denominated
in what the payee receives, so delivering exactly ₱250,000 means asking the PHP pool what
USDC it needs and then asking the BRL pool what that costs.

## The oracle Arc is missing

Pull-based, not push-based. Publishers sign rate observations off-chain; whoever needs a
rate carries it in with the transaction that uses it, and the contract verifies a quorum of
publisher signatures on-chain.

- **No keeper infrastructure.** A push feed needs someone paying gas to update a price
  nobody may read. Here an update costs nothing until a trade depends on one.
- **Fresh at the point of use**, and the *caller* states its own staleness bound — a pool
  settling a trade wants seconds, a dashboard can accept minutes.
- **Ordered by observation, not arrival**, so a late-arriving stale attestation cannot
  rewind the feed.
- **Circuit breaker**: a move beyond 10% is refused while the previous observation is still
  fresh, but a genuine gap move is allowed through after an hour — otherwise an FX weekend
  would brick every pool reading the feed.

Any lending market, perp or prediction market on Arc needs this too. It is not specific to
the pool.

## The engine: a rate-anchored stableswap

Same Curve invariant, same amplification, same fee — applied to rate-scaled reserves.

It also generalises past EUR. Circle's partner stablecoins — BRL, MXN, JPY, ZAR, PHP —
trade at roughly 5, 17, 150, 18 and 56 to the dollar. A 1:1 stableswap cannot hold them at
all. A rate-scaled one treats them exactly like EUR.

**Revenue.** The swap fee splits between LPs and a protocol treasury, capped in the code at
half. At 4bp with a 50% share, the protocol earns 2bp of every unit of volume routed. The
split never changes the trader's price — it is taken out of the fee, not added to it.

**Safety.** Proportional withdrawal deliberately does not consult the oracle. If the feed
stalls, swapping halts but every LP can still take their share of the reserves out. A design
where a dead oracle traps funds is worse than one where it only stops trading.

## Does it actually pay?

`scripts/simulate.mjs` runs two pools that are identical in every respect except where their
liquidity sits — pool A fixed at 1.00 (an ordinary stableswap), pool B reading the oracle —
through **259 real trading days of ECB EUR/USD reference rates**. Each day the rate moves, a
profit-maximising arbitrageur takes whatever mispricing each pool offers, and identical
retail flow crosses both. Everything executes on a real EVM against the deployed contracts;
the arbitrageur calls `quote()` and `swap()` like anyone else.

Both seeding scenarios are reported, including the one that gives the 1:1 pool its own best
case, because a comparison that only flatters the new design is not evidence.

| Over 259 trading days, at 25bp | A — 1:1 stableswap | B — rate-anchored |
|---|---|---|
| LP return vs holding | −1.25% | **+2.32%** |
| Lost to arbitrageurs | 1,513,948 USDC | 2,948 USDC |
| Protocol revenue | 81,498 USDC | 66,425 USDC |
| Closing EURC reserve | 74,177 | 853,572 |

Seeded at 1,171,500 USDC + 1,000,000 EURC each — a book of about 2.33M USDC.

**+2.32% a year to liquidity, measured**, against a design that loses money. That is the
number that decides whether a venue exists at all: nobody supplies inventory to lose 1.25%.
And the second row is where it comes from — 513× less value leaking to arbitrageurs.

The closing reserve says the same thing in plainer terms. The 1:1 pool ends the year holding
74,177 EURC of the million it started with, because every EUR/USD move made its euro side
the cheap side. It is not really a EUR/USD venue by then.

At the DeFi-style 4bp this project started with, the same run gives −4.29% and +0.41%: the
rate-anchored design still wins by 4.7 points, but +0.41% is below a Treasury bill and no
liquidity would show up for it. Pricing it as an FX provider rather than a DEX is what makes
the venue viable, and it is still half of Wise.

Giving the 1:1 pool its own best case — seeded at equal *token* counts, where a 1:1 curve is
flattest — does not save it.

Two things stated against interest. The 1:1 pool shows *higher* protocol revenue (81,498 vs
66,425) precisely because arbitrageurs churn it — fee income taken out of its own LPs; a
pool that loses its LPs money does not keep its liquidity, and a fee stream with no
liquidity behind it is worth nothing. And +2.32% is a real return, not a windfall: the claim
is that one design is viable and the other bleeds, not that market-making is free.

Reproduce with `npm run simulate`; raw output in `results/`.

Data: European Central Bank, series `EXR.D.USD.EUR.SP00.A`, fetched to
`test/fixtures/eurusd-ecb.json`.

## Layout

| Path | What |
|---|---|
| `contracts/src/RialtoOracle.sol` | Pull-based signed FX feed, M-of-N publishers |
| `contracts/src/RialtoPool.sol` | Rate-anchored stableswap, LP token, protocol fee |
| `contracts/src/RialtoSettlement.sol` | Invoice settlement: exact-output, third-party payee, on-chain reference |
| `contracts/src/RialtoRouter.sol` | Multi-hop exact-output routing: settle between currencies sharing no pool |
| `contracts/src/RialtoForward.sol` | Collateralised, cash-settled FX forwards — lock a rate for an invoice with terms |
| `contracts/src/RateSource.sol` | Oracle-backed and fixed rate sources |
| `packages/sdk` | Pair ids, attestation signing, unit handling, the arbitrage search |
| `scripts/simulate.mjs` | The 259-day EUR/USD comparison |
| `scripts/simulate-corridors.mjs` | The same comparison across six real FX corridors |
| `scripts/deploy.mjs` | Local and Arc testnet, using the live USDC and EURC on Arc |
| `test/` | 71 tests across the oracle, pool, settlement, router and forwards |
| `REVIEW.md` | Adversarial review: what breaks it, measured |

## Run it

```bash
npm install
npm run node        # a local chain with Arc's chain id
npm test            # 71 tests
npm run simulate    # the 259-day EUR/USD comparison
npm run corridors   # six corridors: BRL, ZAR, PHP, INR, TRY, EUR
npm run preflight   # check Arc testnet will take the deployment
```

## Status

Contracts, SDK and simulation run against a chain configured with Arc's chain ID and gas
semantics. Arc **testnet** deployment is wired and preflighted — the live USDC
(`0x3600…0000`) and EURC (`0x89B5…D72a`) are read and confirmed on-chain — and needs a
funded deployer.

**Forwards are a derivative, and that is a different legal posture.** The spot pools are
plainly non-custodial software. A rate lock has a stronger claim to being a regulated
product in most jurisdictions, even though the contracts are permissionless and hold no
discretion. Anyone deploying this or running a front end for it should take advice first;
the spot side does not carry the same question.

**Forwards are bounded, not margined.** Payout is capped at the losing side's collateral, so
no position can go bad debt and nobody loses more than they posted. The cost is that a move
past the collateral leaves the winner under-compensated — `Settled.capped` records exactly
that. Uncapped exposure would need margin calls and a keeper network to be safe, and
shipping that as a first version would be dishonest.

**Trust, stated plainly.** A one-publisher oracle is a trusted oracle. The contract supports
M-of-N and the deployment script takes a publisher list, but a first deployment with quorum
1 means the deployer can set the rate, and therefore the price the pool trades at. Anyone
evaluating this should read that as the main open risk; independent publishers are the fix,
and they are a coordination problem rather than a code problem.

Non-custodial throughout: no fiat, no on- or off-ramp, no discretionary control of user
funds. The treasury can adjust the fee split within a hard-coded ceiling and can be
transferred; it cannot touch reserves.
