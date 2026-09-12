# Trading costs: what we can state, what we can only model, and what we must not

`allocate` subtracts a caller-supplied `perTradeCost` before sizing. `planRebalance`
models no cost at all and reports `estimatedProceeds` gross. Both are defensible
only by accident, and for opposite reasons: the commission `allocate` is
subtracting is, at both brokers this server speaks to, **actually zero**, while
the cost `planRebalance` is silently omitting is not the commission at all.

The finding that organises this whole document: for a deep-value micro-cap book,
**the published fee is a rounding error and the bid-ask spread is the trade
cost**, and the ratio between them is roughly two orders of magnitude. On a
$10,000 sale the all-in regulatory charge is about **$0.41**. The round-trip
spread on a name with a few hundred thousand dollars of daily volume is
plausibly **$400 to $800**. Building a precise model of the $0.41 while saying
nothing about the $600 would be worse than building nothing, because a printed
"estimated cost" is read as _the_ cost.

Everything below is marked **verified** (read this session in the primary
source, with the URL) or **inferred**. Section B additionally marks **modelled**
— arithmetic from a published model, which is a third kind of thing and must
never be printed beside the other two without saying so.

---

## A. What the costs actually are

### A.1 The statutory fees are not broker-specific

This is the structural fact that decides the code design in section C. Two of
the three regulatory charges are set by the SEC and FINRA, are identical at
every US broker, and are **sell-side only**. Only the commission and the venue
surcharge differ between brokers.

| Charge                     | Rate                                                                 | Side           | Effective                | Source                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------- | -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC Section 31 fee         | **$20.60 per $1,000,000** of covered sales (`principal × 0.0000206`) | Sells only     | **2026-04-04**           | [SEC Fee Rate Advisory FY2026, 2026-02-27](https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2)                                    |
| FINRA Trading Activity Fee | **$0.000195 per share**, capped **$9.79 per transaction**            | Sells only     | **2026-01-01**           | [FINRA fee adjustment schedule, SR-FINRA-2024-019](https://www.finra.org/rules-guidance/rule-filings/sr-finra-2024-019/fee-adjustment-schedule) |
| FINRA CAT fee              | **$0.000001 per executed equivalent share**                          | **Both sides** | 2026-05-01 to 2026-12-31 | [SR-FINRA-2026-010, CAT Fee 2026-1](https://www.finra.org/rules-guidance/rule-filings/sr-finra-2026-010)                                        |

All **verified**. Sell-side-only for Section 31 and the TAF is stated in FINRA's
own words: "members shall be assessed a TAF for the **sale** of covered
securities"
([TAF FAQ](https://www.finra.org/rules-guidance/guidance/faqs/trading-activity-fee)).
CAT is the only buy-side regulatory charge, and at $0.000001 per share it is
$0.001 on a thousand shares.

The TAF has a de-minimis exemption — no fee when the execution price per share
is below the TAF rate itself. At $0.000195 that never binds, including on
sub-penny OTC names.

**These figures go stale, and Section 31 goes stale violently.** The rate has
been **$27.80 → $0.00 → $20.60 per million in sixteen months**: it was zeroed on
2025-05-14 once the SEC had collected its full FY2025 appropriation
([FY2025 advisory](https://www.sec.gov/rules-regulations/fee-rate-advisories/2025-2)),
and restored to $20.60 on 2026-04-04. The current rate holds "until 60 calendar
days after Congress enacts legislation establishing the SEC's fiscal 2027
appropriation" — so the next change is appropriation-driven and not on a
predictable date. The TAF, by contrast, has a **published forward schedule**:
2027 $0.000232 / $11.61 cap, 2028 $0.000240 / $12.05, 2029 onward $0.000249 /
$12.50. Any constant encoding these must carry its effective date and must say
so in output. See C.2.

### A.2 Per broker

|                                             | **E\*TRADE**                                                                                                                       | **Alpaca**                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Online US-listed equity, market or limit    | **$0**                                                                                                                             | **$0**                                                                                                          |
| Tiered by share count or order type         | No — $0 at both the 0–29 and 30+ trades/quarter tiers                                                                              | No                                                                                                              |
| Broker-assisted                             | **+$25** per trade, plus commission and fees                                                                                       | n/a — API only                                                                                                  |
| **OTC / OTCBB / grey market / OTC foreign** | **$6.95**, or **$4.95** at 30+ trades/quarter                                                                                      | **$0** — no OTC surcharge                                                                                       |
| Directed order to an ECN via E\*TRADE Pro   | $0.005 per share                                                                                                                   | n/a                                                                                                             |
| Section 31 pass-through                     | `principal × $0.0000206`, rounded to the next penny                                                                                | `$0.0000206 × trade value`                                                                                      |
| TAF pass-through                            | $0.000195/share, cap $9.79                                                                                                         | $0.000195/share, cap $9.79 (capped at 50,205 shares)                                                            |
| CAT pass-through                            | **Not published**                                                                                                                  | $0.000003/share (NMS); OTC counts 1 share = 0.01 equivalent shares                                              |
| Sub-$1 price-based surcharge                | **None found** — see below                                                                                                         | **None found**                                                                                                  |
| ADR custody fee                             | $0.005–$0.05 per share, annual, netted from dividends                                                                              | "typically $0.01 to $0.05 per share"                                                                            |
| Partial fill across days                    | **One commission per trading day.** An order executing over more than one trading day "may be subject to an additional commission" | No per-fill charge; fees computed on exact executed quantity, aggregated daily per account, rounded up to $0.01 |
| Schedule as of                              | Page dated **2026-09-12**                                                                                                          | PDF **"Revised on September 1, 2026"**                                                                          |
| Source                                      | [Pricing and Rates](https://us.etrade.com/what-we-offer/pricing-and-rates)                                                         | [Brokerage Fee Schedule (PDF)](https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf)               |

All **verified** from those two pages this session.

**The sub-$1 surcharge does not exist as a price rule.** The widely repeated
belief that E\*TRADE charges extra for stocks under a dollar could not be
confirmed: the pricing page contains no "under $1", "less than $1", "penny" or
"low-priced" rule. E\*TRADE's surcharge is defined by **venue** — OTC, OTCBB,
grey market, OTC-traded foreign — not by price. In practice most sub-$1 names
are OTC and so catch the $6.95, but a sub-$1 _NYSE- or Nasdaq-listed_ stock is
$0 under the published schedule. Treat the price-based version of this belief as
unverified and do not encode it.

**Two discrepancies worth recording.** Alpaca's schedule, revised 2026-09-01,
passes through CAT at $0.000003/share against FINRA's current $0.000001 — three
times the rate, covered by their disclaimer that the amount charged "may differ
from, or exceed, the actual fee paid". E\*TRADE publishes no CAT line at all and
carries a broad reservation that it "shall have the right to determine such fees
in its reasonable discretion, and such fees may differ from or exceed the actual
third-party fees". So a pass-through figure is the broker's published charge,
not a statutory one, and must be attributed to the broker.

**Also not found:** an E\*TRADE brokerage fee-schedule PDF. The only fee PDF in
their Agreement Library is the bank-side one; the brokerage schedule exists only
as the HTML page above, which the Client Agreement refers to as "the
then-effective Fee Schedule" without linking it. Any scraper built against it is
building against a marketing page.

### A.3 Worked: sell 1,000 shares at $10

|                                    | E\*TRADE, listed | E\*TRADE, OTC | Alpaca    |
| ---------------------------------- | ---------------- | ------------- | --------- |
| Commission                         | $0.00            | $6.95         | $0.00     |
| Section 31 (`$10,000 × 0.0000206`) | $0.21            | $0.21         | $0.21     |
| TAF (`1,000 × $0.000195`)          | $0.20            | $0.20         | $0.20     |
| CAT                                | not published    | not published | $0.003    |
| **Total**                          | **$0.41**        | **$7.36**     | **$0.41** |

The buy side of the same trade is **$0.00** at both for a listed name, $0.003
CAT at Alpaca, and $6.95 at E\*TRADE if the name is OTC.

Hold onto the $0.41. It is the number section B has to be compared against.

---

## B. The cost that dwarfs it

### B.1 Quoted spreads

The best hard measurement of the small-cap end is the SEC/FINRA Tick Size Pilot
**Control Group** — untreated, and therefore an ordinary measurement of small-cap
spreads under penny ticks
([Assessment of the Plan to Implement a Tick Size Pilot Program, July 2018](https://www.finra.org/sites/default/files/tick-size-pilot-assessment.pdf),
**verified**). Universe: market cap ≤ $3.0bn, price ≥ $2, consolidated ADV ≤ 1m
shares.

|                                                            | Average quoted spread                              |
| ---------------------------------------------------------- | -------------------------------------------------- |
| Large cap (Almgren et al. 2005, ~700k Citigroup US orders) | **0.11% median, 0.14% mean**                       |
| Tick Pilot Control Group, all                              | **83.2 bps (0.83%)** — "about six cents per share" |
| Control Group, thinnest pre-Pilot class                    | **156.5 bps (1.56%)**                              |

That is a **6× to 12× ratio** from large cap to small cap, and it is measured,
not modelled.

Two things stop this being the answer for our universe, and both push the
number up. First, the Control Group's consolidated average daily **value**
traded per symbol was **$3,845,544** — this "small cap" dataset is about
**nineteen times more liquid** than the $200k-a-day name a deep-value screen
routinely surfaces. Second, no regulatory or peer-reviewed source found this
session publishes a quoted-spread table by market-cap decile extending below
$3bn. That is a genuine gap and it is not fillable by extrapolation.

The one practitioner figure located — Verdad citing Novy-Marx's effective-spread
work, ~50 bps one-way micro cap / 30 bps small / 20 bps large since 2000
([Verdad, 2022-06-13](https://verdadcap.com/archive/accosting-transactions)) —
comes from universes typically $50M–$500M cap with ~$700k daily volume, not the
bottom of the barrel, and reads low for a $200k-ADDV name.

**Effective spread is about 58% of quoted** for small caps: the Tick Pilot
Control Group's E/Q ratio was **0.5814** pre-Pilot, with share-weighted price
improvement of **$0.0205** inside a six-cent quote (**verified**, Figs 23–26).
But that ratio is measured on *marketable retail-sized flow*, which is precisely
the flow that gets internalised and price-improved. It is not a discount that
transfers to a $25,000 accumulation, and applying it as one would be the
document's own version of the error it is warning about.

### B.2 Why cost scales with position size, and how

The standard model is the square-root law: `I = Y · σ_daily · √(Q / V_daily)`.

The exponent is exceptionally well established. A complete survey of the Tokyo
Stock Exchange — every stock, every trader, full order-book reconstruction —
finds `⟨δ⟩ = 0.489` (SEM 0.0015) across stocks and `0.493` per trader, with
prefactor `⟨c⟩ = 0.842`
([Sato & Kanazawa, arXiv:2411.13965](https://arxiv.org/pdf/2411.13965),
**verified**). Their own plain-language calibration: buying **1% of a stock's
daily volume typically moves the price by about 10% of its daily volatility**.
Their survey table shows δ ≈ 0.5 replicated across LSE, US ANcerno data,
European equities, futures and Bitcoin. A 2026 AAPL walk-forward study puts the
prefactor at **0.63–0.77 raw, ~0.34 after a tape-anonymity correction**
(arXiv:2606.24019, **verified**, preprint).

The dissent matters and cuts the safe way. Almgren et al. explicitly **reject**
β = 1/2 at 95% confidence and adopt **β = 0.600 ± 0.038** for temporary impact,
with η = 0.142 — but caveat that their data "consists entirely of large-cap
stocks in the US markets"
([Direct Estimation of Equity Market Impact, Risk 2005](https://www.cis.upenn.edu/~mkearns/finread/costestim.pdf),
**verified**). A 3/5 exponent gives _larger_ costs at large Q/V, which is exactly
where a micro-cap accumulation sits, so 3/5 is the conservative reading.

**Worked, and labelled modelled.** A $50,000 position in a name with $200,000
average daily dollar volume is Q/V = 0.25. At Y = 0.7 and an assumed σ = 4%
daily: `0.7 × 4% × √0.25 = 1.4%`, or $700. At Y = 0.34 it is 0.68% ($340); at
Y = 1.0, 2.0% ($1,000). Add a round-trip spread crossing that is plausibly
200–500 bps on such a name, and the round trip lands somewhere around **4% to
8%** — call it $2,000 to $4,000 on a $50,000 position, against **$0.82** of
regulatory fees for the two legs. That is the ratio the whole document turns on.

Every one of those numbers is **modelled**, not measured. The coefficient is
calibrated on large caps and applied twenty times outside its sample; σ = 4% is
an assumption, not a citation (Almgren's large-cap sample averaged 2.68% and
nothing found measures micro-cap daily vol). This arithmetic belongs in this
document to establish the _order of magnitude_. It must not be printed in tool
output — see C.5.

**Patience does not help.** The square-root law is approximately schedule
invariant. Spreading the same $50,000 over ten sessions: Q/V over the window
falls to 0.025, but σ over ten days rises by √10, and the product is unchanged.
Working an order slowly reduces the _risk_ of the execution and buys you the
passive side of the spread; it does not reduce square-root impact. This is the
most counter-intuitive fact in the literature and the reason a "just work it
slowly" note would be false comfort.

**There is no published participation threshold.** The 1% / 5% / 10%-of-ADV
figures in circulation are desk convention, and no primary source found this
session states one. Two citable anchors exist instead, and they should be the
ones any warning is written against:

- Almgren's sample of _institutional_ orders had a median of **0.62% of ADV**
  and a mean of 1.51% (**verified**, Table 2). That is the observed operating
  range of the desks whose data calibrated the model.
- Verdad's own capacity modelling caps participation at **10% of median daily
  volume per session** (**verified**).

Above roughly 10% of ADV every model located is extrapolating outside its data,
and the one study that measured very large orders found impact **convex** in
size — meaning the concave square-root law _understates_ the cost there
(Frazzini, Israel & Moskowitz, **verified**).

### B.3 Is any of it estimable from data this server can reach?

**The spread: no. Verified against every provider in the pool.**

| Provider                      | Bid/ask on a free key                                                                                                                                                                                                 | Daily volume                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Tiingo                        | **No** — `/iex/{ticker}` returns `bidPrice`/`askPrice`, but the docs mark them "IEX Entitlement Required" and they are `null` without an IEX exchange agreement, on **any** plan                                      | Yes — EOD `volume` / `adjVolume`                       |
| Alpaca                        | **Partly** — `/v2/stocks/{s}/quotes/latest` gives `bp`/`ap`/`bs`/`as`, but free is **IEX venue only**, or SIP at ≥15 minutes old. OTC "only with a special subscription currently available only for broker partners" | Yes — bars `v`                                         |
| Polygon (now **massive.com**) | **No** — `/v3/quotes` and `/v2/last/nbbo` are Stocks Advanced ($199/mo). Basic is end-of-day aggregates                                                                                                               | Yes — `/v2/aggs/.../prev` `v`, all plans               |
| Finnhub                       | **No** — `/stock/bidask` and the NBBO endpoint are premium; `/quote` has no bid/ask                                                                                                                                   | **No** — `/stock/candle` is now premium too            |
| Twelve Data                   | No                                                                                                                                                                                                                    | Yes — `/time_series`                                   |
| Alpha Vantage                 | No — bid/ask is `REALTIME_BULK_BID_ASK_PRICES`, premium plus a separate entitlement                                                                                                                                   | Yes — `TIME_SERIES_DAILY` (but `_ADJUSTED` is premium) |
| EODHD                         | No                                                                                                                                                                                                                    | Yes, but free is 20 calls/day on six demo tickers      |
| FMP                           | Unverified — `/stable/aftermarket-quote` is described as carrying bid and ask, but the docs render client-side and the field names could not be read                                                                  | Yes                                                    |

All **verified** except the FMP row.

And even where a quote is technically reachable, it is the wrong quote for our
names. IEX is a single venue; its own best claim is being on both sides of the
NBBO **30% of the time**, and that claim is scoped to the **Russell 3000**,
which excludes the entire micro-cap tail and all OTC. Alpaca's own field
documentation says a `bp` or `ap` of `0` "means the security has no active
bid/ask" — for a thin name that is the _expected_ state, not an error. OTC names
have no exchange quote at all, from anyone, on any free tier.

So the spread is not observable here, and modelling it would require a
coefficient nobody has calibrated on this universe. Both halves of the estimate
are unavailable. That is the finding, and it settles section C.

**Volume: yes, and one source is already in the codebase.** `src/data/finra.ts`
already parses `averageDailyVolumeQuantity` into `ShortInterestRow.averageDailyVolume`,
dated to `settlementDate`, free and with no credential. It is a **published**
figure, which suits this codebase better than a computed one — though it is
bi-monthly and so up to six weeks stale, and it is in shares, so it needs a
dated price to become dollar volume. Once `src/data/bars.ts` lands, a rolling
median dollar volume from daily bars is the better source: fresher, and a median
is the right statistic because a single block print distorts a mean. Either way
the input exists.

### B.4 Does turnover-driven cost actually matter at a Schloss holding period?

This is the part of the question that deserves a real answer rather than a
warning, and the answer is: **on the turnover arithmetic, no — but the arithmetic
has three conditions attached and one of them is not under the holder's
control.**

The best evidence is Novy-Marx & Velikov, "A Taxonomy of Anomalies and their
Trading Costs" (RFS 2016, 29(1):104–147;
[NBER WP 20721](https://www.nber.org/system/files/working_papers/w20721/w20721.pdf),
**verified**). They cost the full CRSP cross-section using Hasbrouck's
generalized effective spread and sort anomalies by turnover.

|                        | Gross, monthly | Cost, monthly | Net, monthly         |
| ---------------------- | -------------- | ------------- | -------------------- |
| Value (book-to-market) | 0.47% (t=2.68) | **0.05%**     | 0.42% (t=2.39)       |
| Gross profitability    | 0.40%          | 0.03%         | 0.37%                |
| Short-run reversals    | 0.37%          | —             | **−1.28% (t=−6.02)** |
| Seasonality            | 0.84%          | —             | **−0.62%**           |

At factor level: **HML costs 5.45 bps/month** on 1.99%/yr turnover; **UMD costs
48.39 bps/month** on 24.64%/yr. A ninefold difference, driven entirely by
turnover. Their conclusion: strategies with one-sided monthly turnover below 50%
"continue to generate statistically significant net spreads… Few of the
strategies with higher turnover do."

Apply it. Sixty to a hundred names held three to five years is roughly **25%
annual turnover**. Even at the section B.2 modelled round-trip of 6% — about ten
times NM&V's universe average, which is the right direction of adjustment for a
micro cap — that is **1.5% per year**. Real, and survivable against a value
premium the literature puts in the mid single digits.

So the honest answer is that at a genuine multi-year hold this is a
**second-order** cost, and dressing it up as the main event would be wrong. But
it becomes first-order in three specific ways, and these are what the tooling
should actually be careful about:

1. **The hold period is doing all the work.** 6% round trip is 1.5%/yr over four
   years and 12%/yr over six months. A round-trip cost quoted without a holding
   period attached is as meaningless as a price without an `asOf` — the same
   error, in the same shape, as the one rule 3 exists to prevent. A screen that
   re-runs monthly and churns on threshold crossings is not the strategy NM&V
   measured, whatever it is called.
2. **Forced turnover is not optional turnover.** Deep-value micro caps get
   acquired, delisted, reverse-split and go bankrupt — several of which
   `scanDisqualifiers` exists to catch. That turnover happens on someone else's
   schedule, into a bid nobody chose.
3. **Capacity binds long before cost does.** Triangulating the verified points —
   Verdad's finding of "very little alpha generation above about $200 million in
   AUM" and their own micro-cap soft-closes at $50–125M, Perritt MicroCap
   closing at roughly $494M — capacity for a diversified, liquidity-respecting
   US micro-cap value book is in the **low hundreds of millions**, not billions.
   The frequently cited break-even figures of $83bn for HML
   (Frazzini/Israel/Moskowitz, **verified**) are long/short factor exposures
   across the full cap spectrum measured on a large institution's own executions
   in large caps, and must not be read as micro-cap capacity. NM&V make exactly
   this criticism of them: FIM's study is "limited to larger stocks".

The uncomfortable resolution of the FIM-versus-NM&V dispute, for this server's
purposes: FIM's 12 bps is what a $100bn manager with a trading desk and
multi-week patience achieves in large caps. **The user of this tool is the
"average trader" in FIM's own taxonomy, not the institution.** NM&V's
spread-based measure is far closer to their reality, and even NM&V's sample is
value-weighted CRSP rather than the bottom decile.

One finding here is directly actionable and is the highest-leverage thing in the
document: NM&V measure the **buy/hold spread** — a looser exit threshold than the
entry threshold — as "the single most effective simple cost mitigation
strategy", beating staggered rebalancing. That is rebalance logic, not cost
reporting. See C.6.

---

## C. What should change in the code

### C.1 `BrokerAdapter` gains `feeSchedule()` — **recommend, small**

Not a `costModel()` that computes a cost. A **data structure the adapter
publishes**, consumed by one shared estimator. The reason is A.1: Section 31 and
the TAF are statutory and identical everywhere, so putting them in each adapter
duplicates the two numbers most likely to go stale into every integration and
guarantees they diverge. The adapter should supply only what actually differs.

```ts
/** One broker's published equity commissions. Statutory fees are not here. */
export interface FeeSchedule {
  /** ISO date the figures were last read from the broker's own page. */
  readonly checked: string;
  /** Flat commission per online equity order on a US-listed name. */
  readonly commission: Decimal;
  /**
   * Per-share charge the broker passes through on BOTH sides, e.g. CAT.
   * `undefined` means the broker publishes none — not that it charges none.
   */
  readonly perShareBothSides: Decimal | undefined;
  /**
   * Commission on an OTC-quoted name, where the broker prices it separately.
   * `undefined` means no separate OTC rule is published.
   */
  readonly otcCommission: Decimal | undefined;
  /** The page the figures came from. Printed with them, never inferred. */
  readonly source: string;
}
```

On the contract, alongside `environmentLabel` and the other synchronous
metadata:

```ts
/** Published commissions. Static data — no network, no credential. */
readonly feeSchedule: () => FeeSchedule;
```

Synchronous and non-optional. There is no useful `undefined` here: a brokerage
whose commissions cannot be stated should not be an adapter. E\*TRADE's entry
carries `commission: ZERO`, `otcCommission: dec('6.95')`,
`perShareBothSides: undefined`; Alpaca's carries `commission: ZERO`,
`otcCommission: undefined`, `perShareBothSides: dec('0.000003')`.

The `checked` date is not decoration. A fee schedule read a year ago is exactly
the undated figure this codebase refuses everywhere else, and it should be
printed in output the same way `asOf` is.

### C.2 A shared `src/portfolio/fees.ts` — **recommend, small**

The statutory rates as named constants with their effective dates and sources,
plus one pure function. It belongs under `portfolio/` rather than `broker/`
because the data flow is one-way — `broker` sits beside `data`, and `portfolio`
is downstream of both, so a `portfolio` module may read a `FeeSchedule` type from
`broker/contract.ts` without creating the cycle `import/no-cycle` forbids.

```ts
/** Sells only. Set by the SEC and identical at every US broker. */
export const SEC_SECTION_31 = {
  effective: '2026-04-04',
  perDollar: dec('0.0000206'),
  source: 'https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2'
} as const;

/** Sells only. Set by FINRA, with a per-transaction cap. */
export const FINRA_TAF = {
  cap: dec('9.79'),
  effective: '2026-01-01',
  perShare: dec('0.000195'),
  source:
    'https://www.finra.org/rules-guidance/rule-filings/sr-finra-2024-019/fee-adjustment-schedule'
} as const;

export interface OrderCost {
  /** The OLDEST schedule date used, matching `ValueMetrics.asOf`. */
  readonly asOf: string;
  readonly commission: Decimal;
  readonly regulatory: Decimal;
  readonly total: Decimal;
}

export function orderCost(
  order: { principal: Decimal; shares: Decimal; side: 'buy' | 'sell' },
  schedule: FeeSchedule
): OrderCost;
```

`asOf` being the **oldest** of the three dates is deliberate and copies
`ValueMetrics.asOf`: a fee estimate is only as current as its stalest input, and
here the stalest input is usually the broker's page rather than the statutory
rate.

**Staleness is the real design problem, not the arithmetic.** Section 31 has
been three different numbers in sixteen months and there is no free API for it.
The honest treatment is to hardcode it with its `effective` date, print that date
beside every figure, and have `orderCost` degrade rather than lie once the date
is old: past roughly fourteen months from `effective`, return the figure with a
note that the rate is likely superseded, or return `undefined` for the
regulatory component. Do not silently keep charging a rate that was zeroed. The
FY2027 advisory is expected between February and April 2027, and the TAF steps
to $0.000232 / $11.61 on 2027-01-01 — both belong in the `Before you finish`
review list in `CLAUDE.md`, alongside the TTL and provider rules.

### C.3 `planRebalance` annotates orders — **recommend, but do not redefine the existing field**

Yes, annotate. No, do not change what `estimatedProceeds` means. Silently
redefining a field from gross to net is how a caller starts reporting a
different number without anyone noticing, and it is the same class of error as
collapsing `undefined` into `false`. Add fields instead:

```ts
/**
 * Published commission plus statutory transaction fees for this order.
 *
 * Absent means no fee schedule was supplied — NOT that the order is free. It
 * is also not the cost of trading: the spread and the impact of the order are
 * both larger by roughly two orders of magnitude on a thin name, and neither
 * is observable from the data this server can reach.
 */
readonly estimatedFees?: number;
/** `estimatedProceeds − estimatedFees`, sells and exits only. */
readonly netProceeds?: number;
```

fed by a new optional `RebalanceInput.feeSchedule?: FeeSchedule`. When it is
absent both fields are `undefined` and a note says costs were not modelled —
never zero, per rule 4. When it is present, net the fees into `netCashFlow` and
`cashAfter` too: the figures are exact and free, and there is no reason for the
plan's cash arithmetic to be knowably wrong even by $8.

Reporting gross proceeds today does overstate what a sell delivers, but by
$0.41 on $10,000. The reason to fix it is not materiality — it is that having
the exact number present is what licenses the tool to say, credibly, that this
is _not_ the number that matters.

### C.4 `allocate`'s `perTradeCost` — **recommend leaving it alone**

The finding in A.2 defuses this. At both brokers, the buy-side commission on a
US-listed name is genuinely $0, and there is no buy-side Section 31 or TAF at
all — only CAT, at $0.003 on a thousand shares. The current default of `0` is
therefore **correct**, not a crude approximation, and replacing a
caller-supplied zero with a broker-derived zero is a change that produces the
same number through more machinery.

Two things are worth doing instead, both cheap:

- Fix the parameter's description in `src/tools/portfolio.ts`, which currently
  says only "Per-trade commission, subtracted before sizing". It should say that
  $0 is correct for a US-listed name at E\*TRADE and Alpaca, that an OTC-quoted
  name costs $6.95 at E\*TRADE, and that the parameter exists for brokers that
  still charge.
- If `feeSchedule()` is built for C.3 anyway, defaulting `perTradeCost` from
  `brokerAdapter(id).feeSchedule().commission` is two lines and costs nothing.
  It just will not change any output today.

What must **not** be built here is per-name OTC detection to decide between $0
and $6.95. It would mean a listing-status call per candidate — `src/data/reference.ts`
has the Polygon endpoint — spending a rate-limited request to resolve a $6.95
figure. Not worth it. Say it in the description and let the user set the
parameter.

### C.5 The liquidity warning — **recommend, and it is the important one**

There is a defensible way to warn, and it works precisely because it involves no
model at all: **report the order as a fraction of the name's published average
daily volume, and say how many days of that volume it is.** Both are division.
Both carry dates. Neither predicts anything.

```ts
/**
 * Order notional as a fraction of the name's average daily dollar volume.
 * `undefined` when no dated volume figure was available — a gap in the
 * evidence, not a liquid name.
 */
readonly participationOfAdv?: number;
/** Notional ÷ average daily dollar volume, in trading days. */
readonly daysOfVolume?: number;
```

`daysOfVolume` is the better of the two to lead with, for the same reason
`daysToCover` already works in `short_interest`: "this exit is 4.2 days of the
name's entire average volume" is a fact a reader can act on without being told
what to do, and it needs no threshold to be meaningful. The codebase already has
the vocabulary and the shape.

The volume input, in order of preference: a rolling median of daily dollar volume
from `src/data/bars.ts` once it exists (fresher, and a median resists a single
block print), falling back to FINRA's `averageDailyVolume`, which is already
fetched, free, dated to `settlementDate` and up to six weeks stale. Whichever is
used, its date rides with the figure.

**Wording of the note matters more than the threshold**, because B.2 established
that no published threshold exists. Anchor it to the two citable facts rather
than to an invented line:

> `PLCE`: this order is 1.8 days of the name's average daily volume (FINRA, as
> of 2026-08-31). Published market-impact models are calibrated on orders around
> 0.6% of a day's volume; nothing here estimates what your order would actually
> execute at.

Emit it per order above some stated fraction, and state the fraction as a
reporting choice rather than a safety threshold. Never write "safe", "unsafe",
"illiquid" as a verdict, or "you cannot sell this".

And never **refuse** to emit an order on liquidity grounds. Refusing would assert
that the execution cost outweighs the rebalance, which is a judgement about
circumstances the tool does not know — the same argument the tax document
reaches in its C.5, and it lands the same way here. Emit the plan; annotate it.

### C.6 The buy/hold spread — **flag, do not build here**

NM&V's measured best mitigation is a wider exit threshold than the entry
threshold. `planRebalance` already half-implements the shape: `driftTolerance` is
a de-minimis filter, and exits deliberately bypass it because a name that failed
the screen should leave regardless. Turning that into a genuine buy/hold spread
is a change to _when a name leaves the book_, which is strategy, not cost
reporting — it belongs to whoever owns the rebalance logic, and it should be
argued on Schloss's terms rather than smuggled in as a transaction-cost feature.
Recorded here because it is the single highest-leverage item the research turned
up, and because it is cheap once someone decides it is wanted.

### C.7 What must not be attempted

- **A dollar spread or impact estimate, in any output.** Both inputs are
  missing: B.3 verified that no provider in the pool exposes a usable bid/ask on
  a free key, and B.2 found no impact coefficient calibrated anywhere near this
  universe. A number built from those would be a large-cap model extrapolated
  twentyfold, printed in a table beside `$0.41` figures that are exact to the
  penny, and read as equally exact.
- **A predicted fill price, an "expected execution cost", or a suggested
  execution schedule** (VWAP, TWAP, participation rate). The last of these is
  additionally _wrong_ as advice: B.2's schedule invariance means working an
  order slowly does not reduce square-root impact.
- **A verdict that an order is executable or safe.** Report the ratio; do not
  grade it.
- **Applying the 0.58 effective/quoted ratio as a discount.** It was measured on
  internalised retail marketable flow, not on accumulation in a thin name.
- **A net-of-cost return, or a break-even holding period.** That combines a
  modelled cost with an implied return, and the result is advice with a number
  attached.
- **Any fee figure from model memory.** Section 31 has been $27.80, $0.00 and
  $20.60 within sixteen months. Rule 3 applies to fee rates exactly as it
  applies to prices, and the constants in C.2 are the session-retrieved figure
  with its date, not a remembered one.

---

## D. The line

The distinction that governs everything here is the one section B keeps
marking: a **published figure** and a **modelled figure** are different kinds of
thing, and this codebase already has a convention for keeping kinds of thing
apart. `ScreenCheck.pass` is `boolean | undefined` because a missing line item
is not a failed test. The same discipline says a modelled execution cost is not
a fee, and printing them in one column would be the same error in a new place.

**May state as fact**, each being a figure retrieved this session with a source
and a date attached:

- a broker's published commission, attributed and dated: _"E\*TRADE publishes
  $0 for online US-listed equity trades and $6.95 for OTC (schedule read
  2026-09-12)."_
- a statutory rate with its effective date: _"SEC Section 31, $20.60 per million
  of principal on sales, effective 2026-04-04."_
- exact arithmetic on those — `principal × rate`, `shares × rate`, the TAF cap
- a pass-through the broker publishes, attributed to the broker rather than to
  the regulator, because A.2 found Alpaca's CAT figure is 3× the statutory one
- order notional as a multiple of a dated, published average daily volume
- that a figure could not be computed, and why

**Must not do**, however hedged:

- state or imply a bid-ask spread the server did not fetch — and it cannot fetch
  one
- produce any dollar figure for market impact, slippage, or expected execution
  cost
- predict a fill price, or describe a price as achievable
- characterise an order as safe, unsafe, executable or too large
- present the fee estimate as the cost of trading. This is the specific
  misreading the whole document exists to prevent, and it is the one a
  well-formatted table invites
- quote a fee rate from memory, or carry a stale one silently past its
  effective window

### Proposed constant

In `src/tools/shared.ts`, beside `DISCLAIMER` and `TAX_NOTE`, appended by the
same once-per-response rule and for the same reason — a client may surface one
tool result with no surrounding conversation. It sits **above** `TAX_NOTE`, so
the three read as a sequence from narrowest to broadest.

```ts
/**
 * Appended to any tool that prints an estimated fee or a liquidity ratio.
 *
 * The fee figures are exact and the temptation is therefore to read them as
 * the cost of the trade. On a thinly traded name they are roughly two orders
 * of magnitude too small: the bid-ask spread and the price the order itself
 * moves are the real cost, and neither is observable from any data source
 * this server can reach. Saying so beside the number is the only honest way
 * to print the number at all.
 */
export const COST_NOTE =
  '\n\n*Fees shown are published commissions and statutory transaction ' +
  'charges only, at the rates and dates named. They are not the cost of ' +
  'trading. For a thinly traded name the bid-ask spread and the price your ' +
  'own order moves are typically far larger, and this server cannot observe ' +
  'either — no quote provider it can reach exposes a bid and ask for these ' +
  'names. Nothing here predicts a fill price or says an order can be filled.*';
```

Placement: `plan_rebalance`, `build_allocation`, and any tool that prints
`daysOfVolume`.

And one line in `INSTRUCTIONS` in `src/server.ts`, under the rules that hold
regardless of what the user asks, aimed at the model rather than the user —
because the model will otherwise fill the gap on its own, exactly as it would
with `unknown` tax treatment:

> Estimated fees are commissions and statutory charges only. Never present them
> as the cost of executing a plan, and never estimate a spread, a slippage
> figure or a fill price — on a micro cap the spread is routinely a hundred
> times the fees, and this server cannot observe it.

---

## Recommendation on scope

Ranked by value per unit of work.

**Build:**

1. **Days-of-volume and participation on every order (C.5).** The single
   largest cost of running this strategy is the one nobody has a number for, and
   this is the only way to surface it that involves no model, no prediction and
   no invented threshold. It is division on two dated figures. Half a day once a
   volume source is wired; FINRA's `averageDailyVolume` is already parsed and
   costs nothing, and `src/data/bars.ts` supersedes it when it lands.
2. **`COST_NOTE` and the `INSTRUCTIONS` line (D).** An hour, and it is a
   prerequisite for (1) and (3) rather than a follow-up: a ratio printed without
   it invites the model to convert it into a dollar estimate.
3. **`feeSchedule()` on the contract, `src/portfolio/fees.ts`, and
   `estimatedFees` / `netProceeds` on `Order` (C.1–C.3).** Half a day. It earns
   its place less because $0.41 matters than because having the exact figure
   present is what makes the claim in (2) credible rather than a hedge. Build it
   with the staleness degradation, or it becomes a source of confidently wrong
   numbers within a year.
4. **The `perTradeCost` description fix (C.4).** Ten minutes. The current text
   invites a user to invent a commission that does not exist.

**Do not build:**

5. **Any dollar spread, slippage or market-impact estimate.** Verified: no
   provider in the pool exposes a bid/ask on a free key, OTC has no exchange
   quote from anyone, IEX has no quote at all for thin names roughly 70% of the
   time even inside the Russell 3000, and no impact coefficient exists that is
   calibrated within twenty times of this universe. Both halves are missing, and
   a plausible-looking number beside exact fee figures is worse than silence.
6. **Bid/ask fetching, on any provider.** Follows from (5). Tiingo's fields need
   an IEX exchange agreement rather than a paid plan; Polygon's are $199/month;
   Finnhub's and Alpha Vantage's are premium; Alpaca's free feed is one venue
   and excludes OTC entirely.
7. **A broker-derived replacement for `allocate`'s `perTradeCost`.** The number
   it would derive is $0 at both brokers.
8. **Per-name OTC detection** to choose between E\*TRADE's $0 and $6.95. A
   rate-limited network call per candidate to resolve $6.95.
9. **Cost-adjusted position sizing** — trimming a name because it is illiquid.
   That is portfolio construction, it breaks equal weight, and `CLAUDE.md` is
   explicit that equal weight _is_ the method rather than a default to be
   improved on.

**Flagged, owned elsewhere:** the buy/hold spread (C.6) is the highest-leverage
finding in the research and belongs to the rebalance logic, not to cost
reporting.

**Goes stale — review dates:**

- **SEC Section 31**, $20.60/million effective 2026-04-04. Appropriation-driven
  and volatile; the FY2027 advisory is expected February–April 2027.
- **FINRA TAF**, $0.000195 / $9.79 cap. Steps to $0.000232 / $11.61 on
  2027-01-01, then $0.000240 / $12.05 in 2028 and $0.000249 / $12.50 from 2029.
- **FINRA CAT**, $0.000001/share, expires **2026-12-31**.
- **Both broker schedules**, read 2026-09-12 and revised 2026-09-01
  respectively. Neither has a stable versioned URL; E\*TRADE's exists only as an
  HTML marketing page.

**Incidental, unrelated to costs but found while verifying:** `polygon.io` now
301-redirects to `massive.com`. The API paths are unchanged, but the doc links
in `src/data/prices.ts` and `src/data/reference.ts` point at a redirect.
