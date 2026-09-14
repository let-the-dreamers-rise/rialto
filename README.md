# Rialto

**Pay a foreign invoice in one transaction.**

A supplier bills you €5,000. You hold dollars. Today that costs 40–60bp through a payments
provider or 200–300bp through a bank, takes one to three days, and arrives with nothing
linking it back to the invoice. Rialto settles it onchain at **25bp**, at the FX rate that
actually exists, and the payee receives exactly €5,000 — not "about" €5,000.

For importers, exporters and agencies paying cross-border invoices: the businesses too small
for a bank's FX desk.

**[Arc mainnet goes live on 16 September 2026](https://www.arc.network/blog/arc-mainnet-goes-live-on-september-16-2026),
and there is still no price oracle deployed on Arc.** Circle has announced partner
stablecoins in eight currencies, none of which trades anywhere near 1.00, and a venue that
cannot read a price has only one number to centre on. That is a mainnet-day problem, not a
someday problem.

**Live demo:** https://rialto-arc.netlify.app

None of it is possible without reading the real FX rate on-chain, and Arc ships with no price
oracle. So that came first. The whole stack is now deployed and source-verified on Arc testnet:

| Contract | Address | What it does |
|---|---|---|
| `RialtoOracle` | [`0x391c0539…8c5754f`](https://testnet.arcscan.app/address/0x391c05393778eae959cf16296e308d5538c5754f) | Signed FX feed, publisher quorum |
| `OracleRateSource` | [`0xda0a00a8…b4d18198`](https://testnet.arcscan.app/address/0xda0a00a82455d6a28b4695be97e6fdbfb4d18198) | Binds a pool to a pair |
| `RialtoPool` | [`0x089879ab…3b1f9cfc`](https://testnet.arcscan.app/address/0x089879abc2a71e003a71eb9047acd0d63b1f9cfc) | Rate-anchored stableswap, 25bp |
| `RialtoSettlement` | [`0xd8c925d0…39923899`](https://testnet.arcscan.app/address/0xd8c925d0f500356bb8f87ac52faf4c9439923899) | Exact-output invoice settlement |
| `RialtoRouter` | [`0x978e8fe2…242a1172`](https://testnet.arcscan.app/address/0x978e8fe239ed8c7b669687afa55a6310242a1172) | Multi-hop, up to 4 hops |
| `RialtoForward` | [`0xf49f0ba2…4fde0751`](https://testnet.arcscan.app/address/0xf49f0ba2e427ee045755199ebf63dbc64fde0751) | Collateralised rate locks |

## A rate lock, opened and settled on Arc

Not a diagram. An importer locked EUR 1,000 at **1.1622** — the ECB reference rate of
2026-09-04 — against a writer who took the other side. Both posted 5 USDC of margin. At
maturity the feed carried **1.1652**, the ECB print of 2026-09-09, and the position settled
against it: buying the euros at that rate would have cost 1,165.20 USDC instead of the
1,162.20 the lock had fixed, so the forward paid the importer the **3.00 USDC** difference out
of the writer's margin.

| Step | Transaction |
|---|---|
| Counterparty funded | [`0x723661d8…d408a94e`](https://testnet.arcscan.app/tx/0x723661d873fefa2568256ad5566d40c1ce9fc862321a070cf2ff14edd408a94e) |
| Writer posts the offer | [`0x635b6721…8cb2e4f3`](https://testnet.arcscan.app/tx/0x635b6721bff0c235354f17cf09d215c6716bd47afd03ef7c85925f7e8cb2e4f3) |
| Importer locks the rate | [`0x55c35848…0826cbfb`](https://testnet.arcscan.app/tx/0x55c358481f46fb298726c5560840f00df4a7a3b858714816f1cc375d0826cbfb) |
| Settlement rate posted | [`0x4e79b342…75a31aac`](https://testnet.arcscan.app/tx/0x4e79b3426cf4ea118e8293e046211b0f2bf3c278750e89c5ccb2969475a31aac) |
| Settled against the oracle | [`0x15e2659a…e459742`](https://testnet.arcscan.app/tx/0x15e2659a25163842ea43763f3628a5b33f2a60da7fde508dd1cb0e928e459742) |

Both rates are real ECB reference prints. Two things are compressed and the script says so in
its header: the attestation's `observedAt` is the chain's clock rather than the ECB
publication date, because the oracle rejects a timestamp more than `MAX_CLOCK_SKEW` out; and
the tenor is minutes rather than thirty days, so one run covers the whole lifecycle. The
payout, the collateral accounting and the oracle read are not compressed. Reproduce with
`node scripts/live-forward.mjs arc-testnet` — or rehearse it for free first with
`scripts/dry-run-forward.sh`, which asserts a clean local chain before it starts.

## An invoice, settled

The flow the front page promises now runs on Arc too. The pool is seeded with a full faucet
drip — 23.18 USDC against EUR 20.00, balanced in value at the oracle rate rather than in
units — and a payer holding only dollars settled a euro invoice against it:

| | |
|---|---|
| Invoice | `INV-2026-114`, EUR 1.00 |
| Payee received | **exactly EUR 1.00** |
| Payer paid | 1.164 USDC at an effective 1.1624 |
| All-in | **27bp** over mid: the 25bp fee plus 2bp of slippage |
| Protocol earned | 0.001253 EURC — 12.53bp, on-chain in `protocolFees1` |

Two transactions: [seeding](https://testnet.arcscan.app/tx/0x4602393ec99e4361870f2f3af02ba01061cf03c20942c58d1e3808ccbb2574a6)
and [settlement](https://testnet.arcscan.app/tx/0xa0fe947cc439648f461bf556d0ad6f84d85135120b16fa94877f46171e356a96).
Payer, payee and LP are three separate addresses — an invoice settled from and to the same
wallet proves nothing. Reproduce with `npm run invoice`, or rehearse it free with
`scripts/dry-run-invoice.sh`.

**The book is tiny and the 27bp is honest because of it.** Circle's faucet meters testnet
EURC at 20 per request, so that drip is the whole pool. A trade worth 5% of the book costing
2bp of slippage is the rate-anchored curve doing exactly what the measurements below predict:
liquidity sitting at the price that exists. A 1:1 stableswap holding the same two tokens
would price this invoice off 1.00.

**What has not run on-chain is the router.** Multi-hop needs a second seeded pool, and a
second corridor needs testnet liquidity we do not have. It is deployed, verified and covered
by ten tests; it has not routed a live trade, and that distinction is worth more than a
claim that everything works.

Reading the rate takes one call and no permission:

```solidity
(uint256 rate, uint64 observedAt) =
    IRialtoOracle(0x391c05393778eae959cf16296e308d5538c5754f)
        .getRate(keccak256("EUR/USD"), 900);   // reverts if older than your bound
```

All six are **source-verified on Arcscan**, so the code at those addresses can be read
rather than trusted. An update costs **0.00093 USDC** — measured, with the transaction linked
from the demo page, on a warm storage slot; the first write to a new pair costs more. Anyone
on Arc can read the feed — it is not ours to keep, and nothing on that chain could read an FX
rate before it existed.

Reproduce the verification with `npm run verify`.

### What feeds it, and what that is not

`npm run publish` fetches the current ECB reference rate and posts it. That is the whole
publisher, and it is worth being precise about what it gives you.

**Who holds the publisher's key.** The site posts on a schedule (every ten minutes, from
`site/netlify/functions/publish-rate.mjs`) with a key it generated itself on first run and
keeps in Netlify Blobs — the site's own storage. The key has never been printed, mailed or
pasted anywhere; the only thing that leaves is the address, at
[`/api/publisher`](https://rialto-arc.netlify.app/api/publisher), currently
`0xA00adD79b3e315A5F3c4bC393550343fF1A7BEed`. Two things have to be true for it to post:
the oracle admin must have authorised it, and it must hold gas. Both are true: it was
authorised in [`0x157fe1ef…`](https://testnet.arcscan.app/tx/0x157fe1efbdcd44edf514bd8b70e370b6c412a9f1e04ab9730ae0cbd477e90732)
and its first unattended post was
[`0x6d132dea…`](https://testnet.arcscan.app/tx/0x6d132dea02e147523324661889cfe939fb3c0327cda642a762672cf0d80db703)
— the ECB print of the day, fetched and signed by the site on its own schedule.

```bash
npm run authorise -- 0xA00adD79b3e315A5F3c4bC393550343fF1A7BEed      # setPublisher + 3 USDC gas
GAS_ONLY=1 npm run authorise -- 0xA00a…BEed                          # just top it up
```

Anyone can top it up from [faucet.circle.com](https://faucet.circle.com) (Arc, USDC) — it
is an address, not a secret. At the measured cost that is about 0.13 USDC a day.

The deployer key still holds the oracle admin role, the pool treasury and the LP position,
and exists on one machine. `REVIEW.md` §6 is blunt about that.

A pull feed is only as fresh as whoever posts to it. `getRate` reverts past the bound the
*caller* names, so a feed nobody updates stops trades rather than settling them at
yesterday's price — that is the safety property working, and the demo page shows the feed as
**stale** rather than **live** when it happens, because a green badge over a two-day-old
print is the one claim on that page a reviewer could disprove in a single call.

**The ECB publishes once a day.** The pool settles against a 15-minute bound, so the
publisher re-attests the same value every ten minutes to keep the feed inside it — about
0.13 USDC a day at the measured cost. An hourly publisher would leave the feed outside that
bound for 45 minutes in every 60. That keeps a demo honest-looking while being, strictly, a
daily number held inside an intraday bound. A
production feed takes intraday quotes from several independent publishers — which is also
the only thing that makes the M-of-N quorum mean anything, since a quorum of one publisher
reading one source is a trusted feed with extra steps. Both limitations are in `REVIEW.md`
and neither is solved by this deployment.

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
half, and collectable only to the treasury address. At the 25bp this charges, a 50% share is
**12.5bp of every unit of volume routed** — 1,250 USDC per million settled. The split never
changes the trader's price; it comes out of the fee, not on top of it. The settled invoice
above paid the protocol 0.001253 EURC, which is 12.53bp and is readable on the pool right now
as `protocolFees1`.

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
| `scripts/deploy-instruments.mjs` | Adds pool, settlement, router and forward to an oracle already live |
| `scripts/live-forward.mjs` | Opens, fills and settles a real forward; writes the tx record the demo page reads |
| `scripts/dry-run-forward.sh` | Rehearses that lifecycle on a verified-clean local chain first |
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

All six contracts are **deployed and source-verified on Arc testnet**, against the live USDC
(`0x3600…0000`) and EURC (`0x89B5…D72a`). The oracle carries a real EUR/USD print and the
forward carries a position that was opened, filled by a second party and settled against that
feed. The pool is seeded and has settled a euro invoice for a payer holding only dollars, with
the protocol's 12.5bp share sitting on the contract. The one path not exercised on-chain is
multi-hop routing, which needs a second seeded corridor.

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
