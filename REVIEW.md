# Product review

An adversarial pass over Rialto: what breaks it, what it costs, and what the numbers say
rather than what the pitch says. Every figure here was measured against the deployed
contracts on a real EVM, against a pool seeded with 1,164,600 USDC + 1,000,000 EURC — a
book of about **$2,329,200** at amp=200 and a 25bp fee.

---

## 1. Critical: the circuit breaker had an escape hatch — fixed

The oracle originally let its deviation cap **lapse entirely** once the previous observation
went stale, so that a genuine FX gap move could get through after a quiet weekend. The
reasoning was that a permanent cap would brick every pool reading the feed. That reasoning
was wrong, and expensively so: it handed a compromised publisher set a waiting game.

Measured, with the attacker sizing every trade optimally:

| Attack | Attacker takes | LPs lose |
|---|---|---|
| One +9.9% print (inside the cap) | $81,640 | 3.6% |
| One +11% print | blocked | — |
| +50% print after waiting out the window | $339,660 | 14.7% |
| **+900% print after waiting out the window** | **$878,700** | **37.8%** |

**Fix.** The allowance now widens with staleness but never disappears: 10% when fresh,
growing linearly, hard-capped at 25% however stale the feed is. EUR/USD's largest single-day
move in modern history is a few percent, so 25% is far outside anything an FX market does
while still bounding what one bad print is worth.

Re-measured against the fix:

| Attack | Result |
|---|---|
| One +9.9% print | $81,640 — unchanged, this is the irreducible case |
| +50% in one print after waiting | **blocked** |
| +900% in one print after waiting | **blocked** |
| Patient walk: max legal step every hour, milking each time | **converges at $74,819 (3.2%)** |

The patient attack is the interesting one. An attacker who walks the rate up 9.9% an hour
takes $71,677 on the first step and then **essentially nothing more** — by hour four the
cumulative take has plateaued. The first jump captures the mispricing; afterwards the pool's
composition has re-centred on the false rate and there is little left to take.

So the blast radius went from **37.8% of the book, in one transaction** to **~3.2%,
bounded, and requiring a public multi-hour walk that LPs can see and exit ahead of.**

**Residual risk, unfixable in code:** ~3.6% of the book is still extractable by a
compromised publisher set in a single print. Only a genuine M-of-N publisher set reduces
that, and that is a coordination problem. **A quorum-1 launch means the deployer can take
3.6% of their own LPs' capital whenever they like.** Anyone evaluating this should treat the
publisher set as the security model.

---

## 2. Material: the pool only beats incumbents up to a certain invoice size

All-in cost of settling one invoice, against the 1.1646 mid rate:

| Invoice | USDC needed | All-in spread | vs Wise at 50bp |
|---|---|---|---|
| EUR 1,000 | 1,167.52 | 25.0bp | saves $3 |
| EUR 5,000 | 5,837.73 | 25.0bp | saves $14 |
| EUR 25,000 | 29,191.61 | 26.0bp | saves $69 |
| EUR 100,000 | 116,810.72 | 30.0bp | saves $232 |
| EUR 250,000 | 292,268.32 | 38.0bp | saves $337 |
| **EUR 500,000** | **585,704.76** | **58.0bp** | **costs $493 more** |

At this depth the product wins comfortably up to about EUR 250,000 and **loses to Wise above
roughly EUR 400,000**. That is a liquidity constraint rather than a design flaw — the
crossover scales with the book — but it is a real limit and the pitch should not claim
otherwise. The honest positioning is SME invoices, not treasury-scale transfers.

---

## 3. Verified safe: sandwiching a payer is unprofitable

A payer settling a EUR 50,000 invoice, with an attacker front-running to push their cost to
the edge of their slippage bound:

| Payer's bound | Payer overpays | Attacker nets |
|---|---|---|
| 1% | $584 | **−$2,370** |
| 3% | $1,751 | **−$2,314** |
| 5% | $2,919 | **−$1,533** |

The attacker loses money in every case. At amp=200 with a 25bp fee, moving the price far
enough to hurt the payer costs more in fee and curvature than the sandwich extracts. Note
the asymmetry though: a payer with a loose bound can still overpay if someone happens to
trade ahead of them — that value goes to the LPs, not to an attacker. **Set a tight bound;
1% caps the damage at about 1%.**

---

## 4. Verified safe: no first-depositor or donation attack

Donating 500,000 USDC directly to the pool moves the token balance but not `reserve0`,
because reserves are tracked explicitly rather than inferred from `balanceOf`. A later
depositor still mints a normal share. The classic share-price inflation attack does not
apply.

**Minor:** donated tokens are stranded — there is no rescue function. Worth adding, but it
costs nobody anything except whoever donated.

---

## 5. The product hole no contract fixes

**A business with a euro invoice and a dollar bank account cannot use this.** They need USDC
first. Rialto settles FX between stablecoins; it does not do the fiat legs, deliberately —
that is what keeps it non-custodial and unlicensed, and it is why an India-based team can
build it at all. But it means the addressable user today is someone who *already holds
USDC*, which is a much smaller set than "businesses paying cross-border invoices".

That is the honest reason the milestones are written in settled volume and paying
businesses rather than TVL, and the honest answer to "why hasn't this eaten Wise" is that
Wise does the part we don't.

---

## Verdict

The engine is sound and now has a bounded failure mode where it previously had an unbounded
one. The measured LP return (+2.32%/yr) is real, and the arbitrage advantage over a
1:1-centred pool (513×) is the strongest evidence in the project.

The two things that decide whether it matters are neither of those, and neither is code:
**a real publisher set**, and **businesses with invoices who already hold USDC**.
