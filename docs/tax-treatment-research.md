# Account tax treatment: what the brokers expose, and what we may honestly do with it

`plan_rebalance` produces sell orders with no notion of the account they execute
in. Selling a five-bagger in a taxable account realises a capital gain; the same
sale in a Roth realises nothing. A deep-value book holds for years and then sells
into a closed discount, so this is not a rounding error — for a taxable account
it is frequently the largest single cost of executing the plan.

This document establishes what the two adapters can actually know, proposes a
neutral taxonomy for `BrokerAccount`, and argues for a **deliberately small**
behaviour change. Most of what could be built here should not be.

Everything below is marked **verified** (read in the vendor's own published
schema this session) or **inferred**.

---

## A. What the brokers actually expose

### A.1 E\*TRADE — account level

`GET /v1/accounts/list` (**verified**,
[Accounts API, developer.etrade.com](https://apisb.etrade.com/docs/api/account/api-account-v1.html)).
Three fields bear on this:

| Field             | Type   | Documented values                                              |
| ----------------- | ------ | -------------------------------------------------------------- |
| `accountType`     | string | 80-odd tokens, listed below                                    |
| `accountMode`     | string | `CASH, MARGIN, CHECKING, IRA, SAVINGS, CD`                     |
| `institutionType` | string | `BROKERAGE` — the only documented value, so it carries nothing |

`accountStatus` is `ACTIVE, CLOSED`. There is no separate registration field.

**IRA registrations do appear in `accountType`.** The full documented enum
(**verified**, quoted from the docs verbatim):

```
AMMCHK, ARO, BCHK, BENFIRA, BENFROTHIRA, BENF_ESTATE_IRA, BENF_MINOR_IRA,
BENF_ROTH_ESTATE_IRA, BENF_ROTH_MINOR_IRA, BENF_ROTH_TRUST_IRA, BENF_TRUST_IRA,
BRKCD, BROKER, CASH, C_CORP, CONTRIBUTORY, COVERDELL_ESA, CONVERSION_ROTH_IRA,
CREDITCARD, COMM_PROP, CONSERVATOR, CORPORATION, CSA, CUSTODIAL, DVP, ESTATE,
EMPCHK, EMPMMCA, ETCHK, ETMMCHK, HEIL, HELOC, INDCHK, INDIVIDUAL, INDIVIDUAL_K,
INVCLUB, INVCLUB_C_CORP, INVCLUB_LLC_C_CORP, INVCLUB_LLC_PARTNERSHIP,
INVCLUB_LLC_S_CORP, INVCLUB_PARTNERSHIP, INVCLUB_S_CORP, INVCLUB_TRUST,
IRA_ROLLOVER, JOINT, JTTEN, JTWROS, LLC_C_CORP, LLC_PARTNERSHIP, LLC_S_CORP,
LLP, LLP_C_CORP, LLP_S_CORP, IRA, IRACD, MONEY_PURCHASE, MARGIN, MRCHK,
MUTUAL_FUND, NONCUSTODIAL, NON_PROFIT, OTHER, PARTNER, PARTNERSHIP,
PARTNERSHIP_C_CORP, PARTNERSHIP_S_CORP, PDT_ACCOUNT, PM_ACCOUNT, PREFCD,
PREFIRACD, PROFIT_SHARING, PROPRIETARY, REGCD, ROTHIRA, ROTH_INDIVIDUAL_K,
ROTH_IRA_MINORS, SARSEPIRA, S_CORP, SEPIRA, SIMPLE_IRA, TIC, TRD_IRA_MINORS,
TRUST, VARCD, VARIRACD, INVALID
```

The important structural fact — and the reason the sandbox observation of
`MARGIN`, `INDIVIDUAL`, `CASH` was confusing — is that **`accountType` is not a
registration field.** It is a single column carrying at least four different
kinds of thing:

- registration (`INDIVIDUAL`, `JOINT`, `JTWROS`, `TRUST`, `ESTATE`)
- retirement plan type (`ROTHIRA`, `IRA_ROLLOVER`, `SEPIRA`, `SIMPLE_IRA`)
- **settlement mode** (`CASH`, `MARGIN`, `PDT_ACCOUNT`, `PM_ACCOUNT`)
- **product** (`CREDITCARD`, `HELOC`, `BRKCD`, `MUTUAL_FUND`, `INDCHK`)

`CASH` and `MARGIN` are therefore _not evidence of a taxable account_. They are
evidence that E\*TRADE had nothing better to put in the column. Any mapping that
reads "not an IRA token, therefore taxable" is wrong for exactly the values the
sandbox returns. This is the single most important finding in section A.

`accountMode` is the safety net: an account whose `accountType` is an unrecognised
token but whose `accountMode` is `IRA` is retirement money, and treating it as
taxable would understate cost. **We do not currently parse `accountMode`** —
`EtradeAccount` in `src/data/etrade.ts` captures `accountDesc`, `accountId`,
`accountIdKey`, `accountName`, `accountStatus`, `accountType` and
`institutionType` only. It needs to be added.

Two tokens I could not resolve from primary sources and am **inferring**:
`CONTRIBUTORY` is E\*TRADE's label for a contributory (Traditional) IRA, and
`ARO`, `CSA`, `HEIL`, `VARIRACD`, `PREFIRACD` are legacy product codes. The
`*IRACD` and `PREFIRACD` names strongly suggest IRA-registered certificates of
deposit, but the docs define none of them. They belong in the "cannot determine"
bucket, not in a guess.

### A.2 E\*TRADE — position level

`GET /v1/accounts/{accountIdKey}/portfolio` (**verified**,
[Portfolio API](https://apisb.etrade.com/docs/api/account/api-portfolio-v1.html)).

Position-level fields relevant to tax: `dateAcquired` (int64 epoch),
`pricePaid`, `costPerShare`, `totalCost`, `totalGain`, `totalGainPct`,
`commissions`, `otherFees`.

**Lots are individually addressable.** The query parameter `lotsRequired`
(default `false`) adds a `PositionLot` array to each position, with:

`positionLotId`, `price`, `termCode` (int32), `daysGain`, `marketValue`,
`totalCost`, `totalCostForGainPct`, `totalGain`, `lotSourceCode`, `originalQty`,
`remainingQty`, `availableQty`, `orderNo`, `legNo`, `acquiredDate` (int64),
`locationCode`, `exchangeRate`, `adjPrice`, `commPerShare`, `feesPerShare`,
`premiumAdj`, `shortType`.

So for E\*TRADE the holding period **is** obtainable, per lot, from
`acquiredDate`. `termCode` is almost certainly the short/long flag, but the docs
give it no value enum at all — it is `integer (int32)` with an empty "Possible
Values" cell. Deriving the term from `acquiredDate` ourselves is the only
defensible reading; trusting an undocumented integer is not.

No cost-basis _method_ (FIFO/LIFO/specific-lot) is exposed anywhere in the
Accounts or Portfolio API. That setting lives in the account profile on
etrade.com and is not reachable over this API. **Verified by absence** — I read
the full field list for both endpoints and it is not there.

We currently call `portfolio.json` with no query parameters, so we take the
default `lotsRequired=false` and the default `view=QUICK`, and `RawPosition` in
`src/data/etrade.ts` does not parse `dateAcquired` even though the default view
returns it.

### A.3 Alpaca — which API, and what each one knows

Alpaca ships two distinct products and the answer differs between them.

**Trading API** (the retail/self-directed one, `GET /v2/account`). **Verified**:
the response is `account_number`, `id`, `currency`, `status`, `created_at`,
`buying_power`, `cash`, `equity`, `last_equity`, `long_market_value`,
`short_market_value`, `portfolio_value`, `initial_margin`, `maintenance_margin`,
`last_maintenance_margin`, `multiplier`, `regt_buying_power`,
`non_marginable_buying_power`, `options_buying_power`, `options_trading_level`,
`options_approved_level`, `sma`, `accrued_fees`, `pending_reg_taf_fees`,
`pending_transfer_in`, `pending_transfer_out`, `intraday_adjustments`,
`balance_asof`, `account_blocked`, `trading_blocked`, `transfers_blocked`,
`trade_suspended_by_user`, `shorting_enabled`.

**There is no registration or tax field.** Alpaca has publicly launched IRA
accounts for Trading API users, but nothing in the `/v2/account` schema surfaces
which kind of account the key is pointed at. For an Alpaca Trading API adapter
the honest answer is therefore **`unknown`, always** — not `taxable`.

**Broker API** (the B2B one, `GET /v1/accounts`, `GET /v1/accounts/{id}`).
**Verified** from Alpaca's published OpenAPI schema:

```
AccountType:    enum ["trading","custodial","donor_advised","ira","trust",
                      "omnibus_non_disclosed","omnibus_sub","hsa","joint"]
                description: "The account type returned for the account."
AccountSubType: enum ["traditional","roth"]
                description: "IRA Account only"
```

Both `account_type` and `account_sub_type` appear in the **response** schema for
the account object, not merely on the creation request — I checked specifically,
because the IRA overview page only shows them in a create body. `account_type`
defaults to `trading` when omitted at creation, which means a `trading` value is
the vendor's own default rather than a positive determination; it is still the
best signal available and I would map it to taxable, noting the caveat.

This is a clean two-field taxonomy and it is the shape the neutral enum should be
able to absorb losslessly.

### A.4 Alpaca — position level

`GET /v2/positions` (**verified**, from the published example payload):
`asset_id`, `asset_class`, `asset_marginable`, `symbol`, `exchange`, `qty`,
`qty_available`, `side`, `avg_entry_price`, `cost_basis`, `current_price`,
`lastday_price`, `change_today`, `market_value`, `unrealized_pl`,
`unrealized_plpc`, `unrealized_intraday_pl`, `unrealized_intraday_plpc`.

No acquisition date. No lot identifier. No holding period. No lots endpoint —
Alpaca's position model is an average-cost aggregate and nothing more. `cost_basis`
is the aggregate position basis; `avg_entry_price` is that divided by quantity.

For Alpaca, **holding period is not knowable at all** from the positions API.
It could in principle be reconstructed from the activities/orders history, which
is a materially different and much more expensive piece of work, and it would
still be a reconstruction rather than the broker's own basis records.

### A.5 Comparison

|                                     | E\*TRADE                                               | Alpaca Trading API              | Alpaca Broker API       |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------- | ----------------------- |
| Registration exposed                | Yes, muddled into `accountType`                        | **No**                          | Yes, `account_type`     |
| Roth vs Traditional distinguishable | Yes (`ROTHIRA` vs `IRA`/`CONTRIBUTORY`/`IRA_ROLLOVER`) | No                              | Yes, `account_sub_type` |
| Fallback signal                     | `accountMode` = `IRA`                                  | none                            | none needed             |
| Value set size                      | ~80 tokens, mixed semantics                            | n/a                             | 9 types × 2 subtypes    |
| Position cost basis                 | `totalCost`, `costPerShare`                            | `cost_basis`, `avg_entry_price` | same as Trading         |
| Acquisition date (position)         | `dateAcquired`                                         | **No**                          | **No**                  |
| Acquisition date (lot)              | `acquiredDate` via `lotsRequired=true`                 | n/a — no lots                   | n/a — no lots           |
| Lots individually addressable       | Yes, `positionLotId`                                   | **No**                          | **No**                  |
| Holding period derivable            | Yes, from lot `acquiredDate`                           | **No**                          | **No**                  |
| Cost-basis method (FIFO/LIFO/spec)  | **Not exposed**                                        | **Not exposed**                 | **Not exposed**         |

Neither broker exposes the cost-basis election. That single gap is what kills
most of section C.

---

## B. The neutral taxonomy

### B.1 Proposal

```ts
/**
 * How a sale in this account is taxed.
 *
 * The question this answers, and the only one, is: does selling here realise a
 * currently reportable capital gain? `taxable` says yes; `roth`, `tax-deferred`
 * and `tax-sheltered` say no; `unknown` says the broker did not tell us.
 *
 * `unknown` is not a synonym for `taxable`. Defaulting an undetermined account
 * to taxable would fabricate a cost; defaulting it to sheltered would hide one.
 * Neither is a claim we are entitled to make, so it gets its own value and the
 * output says so in words.
 */
export type TaxTreatment =
  /** Roth IRA, Roth Individual K, Coverdell ESA, HSA — post-tax in, untaxed out. */
  | 'roth'
  /** Retirement money whose flavour the broker did not disclose. */
  | 'tax-sheltered'
  /** Traditional / rollover / SEP / SIMPLE IRA, 401(k), profit sharing. */
  | 'tax-deferred'
  | 'taxable'
  | 'unknown';

/**
 * Whether a sale here realises a reportable gain.
 * `undefined` for `unknown` — the three-state convention, not a boolean.
 */
export function realisesGain(treatment: TaxTreatment): boolean | undefined {
  if (treatment === 'unknown') return undefined;
  return treatment === 'taxable';
}
```

and on the contract:

```ts
export interface BrokerAccount {
  readonly description: string;
  readonly id: string;
  readonly number: string;
  readonly status: string;
  /** Never optional, never defaulted. An adapter that cannot tell says `unknown`. */
  readonly taxTreatment: TaxTreatment;
  /** The broker's own word, unchanged. `taxTreatment` is derived from it. */
  readonly type: string;
}
```

### B.2 Why five values and not three, or two

**Two (`sheltered` / `taxable`) is what the behaviour in section C actually
needs.** Everything `planRebalance` would do with this field is identical for a
Roth and a Traditional IRA: no realised gain either way. On behaviour alone,
two values plus `unknown` would be the right answer, and I want that stated
plainly rather than buried.

The case for going finer is that the _output_ should be able to say which, and
`type` alone cannot carry that — `type` is `ROTHIRA` for one broker and `ira` +
a separate subtype for another, and forcing every consumer to learn both
vocabularies is exactly what the adapter layer exists to prevent. Rendering
"Roth IRA" in a header is a fact worth stating, and it is the fact a user will
check the classification against.

**`tax-sheltered` is not a fudge; it is the E\*TRADE `accountMode === 'IRA'`
case.** When `accountType` is an unrecognised token (`PREFIRACD`, `ARO`) but
`accountMode` says `IRA`, we know with certainty that a sale realises nothing and
we know with certainty that we cannot say whether it is Roth. Collapsing that
into `tax-deferred` asserts a Traditional registration we have not established;
collapsing it into `unknown` throws away the one thing we do know and would
produce a spurious "tax treatment could not be determined" warning on an account
where it plainly was. Both errors are the rule-4 error in different directions.
A fifth value costs one line and removes both.

I stopped short of splitting further. `529`, `HSA` and `COVERDELL_ESA` fold into
`roth` because they share its behaviour on both questions this enum answers, and
because splitting them would create values that Alpaca Trading can never populate
and that change nothing downstream. Estate, trust and entity registrations fold
into `taxable`: the entity's own rate is not ours to model, and "a sale here is a
reportable event" remains true.

### B.3 Mapping tables

**E\*TRADE** (`src/broker/etrade-adapter.ts`), evaluated in this order — the
order is the whole design, because step 3 is the trap:

1. `accountType` in the Roth set → `roth`:
   `ROTHIRA`, `ROTH_INDIVIDUAL_K`, `ROTH_IRA_MINORS`, `CONVERSION_ROTH_IRA`,
   `BENFROTHIRA`, `BENF_ROTH_ESTATE_IRA`, `BENF_ROTH_MINOR_IRA`,
   `BENF_ROTH_TRUST_IRA`, `COVERDELL_ESA`.
2. `accountType` in the deferred set → `tax-deferred`:
   `IRA`, `IRA_ROLLOVER`, `CONTRIBUTORY`, `SEPIRA`, `SARSEPIRA`, `SIMPLE_IRA`,
   `INDIVIDUAL_K`, `MONEY_PURCHASE`, `PROFIT_SHARING`, `BENFIRA`,
   `BENF_ESTATE_IRA`, `BENF_MINOR_IRA`, `BENF_TRUST_IRA`, `TRD_IRA_MINORS`.
3. `accountMode === 'IRA'` → `tax-sheltered`. Reached only when `accountType`
   was not recognised above. `IRACD`, `PREFIRACD` and `VARIRACD` land here.
4. `accountType` in the plainly-taxable set → `taxable`:
   `INDIVIDUAL`, `JOINT`, `JTTEN`, `JTWROS`, `TIC`, `COMM_PROP`, `TRUST`,
   `ESTATE`, `CUSTODIAL`, `CONSERVATOR`, `BROKER`, and the entity registrations
   (`CORPORATION`, `PARTNERSHIP`, `LLC_*`, `LLP*`, `*_CORP`, `INVCLUB*`,
   `NON_PROFIT`, `PROPRIETARY`).
5. Anything else, including `CASH`, `MARGIN`, `PDT_ACCOUNT`, `PM_ACCOUNT`,
   `OTHER`, `INVALID`, and every banking product → `unknown`.

Step 5 is the point. `CASH` and `MARGIN` describe settlement, not tax, and the
sandbox returns them; a mapping that let them fall through to `taxable` would be
confidently wrong on the only data we have actually observed.

**Alpaca Broker API**: `account_type === 'ira'` → `account_sub_type === 'roth' ?
'roth' : account_sub_type === 'traditional' ? 'tax-deferred' : 'tax-sheltered'`;
`'hsa'` → `roth`; `'trading' | 'joint' | 'custodial' | 'trust' |
'donor_advised'` → `taxable`; omnibus types → `unknown`.

**Alpaca Trading API**: `unknown`, unconditionally, with a comment saying why —
`/v2/account` has no such field, and a future adapter author must not "fix" this
by assuming a paper key is a taxable account.

---

## C. What should change in behaviour

Four proposals, three of which I recommend rejecting.

### C.1 Realised gain on sells — **recommend, but only on full exits**

What we have per `Position`: aggregate `costBasis`, `shares`, `price`, and no
lot detail. What that supports:

**A full exit is exact and lot-independent.** If the entire position goes, every
lot goes, so the gain is `proceeds − costBasis` regardless of which lot-selection
method the account uses. That figure is honest arithmetic on two broker-reported
inputs and needs no assumption whatsoever.

**A partial sell is not computable and must not be estimated.** The gain on
selling 40 of 100 shares depends entirely on which 40 — under specific-lot
identification that is the account holder's choice, and the spread between the
best and worst lot on a name held for years is routinely larger than the gain
itself. The tempting shortcut is pro-rata average cost, and it is worse than
imprecise: **average cost is not a permitted basis method for individual
equities** (it is available for mutual funds and DRIP shares only). So a pro-rata
figure would not merely be an approximation of the right answer, it would be
computed by a method the IRS does not allow for the asset class. It has no
defensible label. Leave the field `undefined`.

Concretely:

```ts
interface Holding {
  readonly asOf: string;
  /** Broker-reported aggregate basis. `undefined` = the broker did not supply one. */
  readonly costBasis?: Decimal;
  readonly price: Decimal;
  readonly shares: Decimal;
  readonly ticker: string;
}

export interface RebalanceInput {
  // ...
  /** Omit when the caller does not know. Never defaulted to 'taxable'. */
  readonly taxTreatment?: TaxTreatment;
}

export interface Order {
  // ...existing fields unchanged...
  /** Broker-reported basis for the whole position. Absent = not supplied. */
  readonly costBasis?: number;
  /**
   * `estimatedProceeds − costBasis`, on a FULL exit only, and only when the
   * account is `taxable` and `costBasis` is known. Absent means "not computed",
   * never zero. Not a tax figure: no fees, no wash-sale or basis adjustment,
   * no holding-period split.
   */
  readonly gainOnExit?: number;
}
```

`mergeHoldings` must sum `costBasis` the way `netPositions` does — `undefined`
plus a value is that value, both `undefined` is `undefined` — and must **not**
sum to zero when no lot supplied one.

One caveat that is a live bug risk rather than a documentation nicety:
`netPositions` in `src/broker/contract.ts` adds `costBasis` across lots including
a short leg, and the aggregate basis of a netted long/short pair is meaningless.
If a netted position's constituent lots included a short, `costBasis` should come
back `undefined` rather than a summed number. The contract currently has no way
to know that after netting, so the fix belongs in `netPositions` where the lots
are still visible.

Effort: small. A field on `Holding`, two on `Order`, one branch in the exit path,
adapter plumbing for `costBasis` (E\*TRADE `totalCost` and Alpaca `cost_basis`
are both already fetched), and tests for the three states — known basis, absent
basis, partial sell. Half a day including the netting fix.

Worth it: yes. It is the one number in this whole document that can be computed
exactly from data we already hold, and for a strategy whose exits are the tax
event, it is the number that matters.

### C.2 Short-term versus long-term — **recommend not now**

Can we know it? For E\*TRADE, yes, per lot, from `acquiredDate` with
`lotsRequired=true`. For Alpaca, no, at all — there is no acquisition date on any
position endpoint of either API.

Two reasons not to do it yet, beyond the Alpaca gap.

First, **holding period is a property of a lot, not of a position**, and the
contract's `Position` is netted by design and correctly so. A position built over
three years straddles the one-year line, and any single short/long label on it is
false for part of it. Putting `holdingPeriod` on `Position` would encode a
category error into the contract's central type.

Second, the term only produces a _number_ when combined with a rate, and a rate
is the line in section D.

If it is wanted later, the shape is a new optional capability rather than a new
field:

```ts
readonly lots?: (accountId: string) => Promise<Lot[]>;
```

with `Lot` carrying `acquiredDate`, `shares`, `costBasis`, and adapters that
cannot supply lots simply not implementing it. That keeps the netted `Position`
honest and lets `undefined` mean what it means. It is a day or two of work and it
should wait for a concrete demand.

Until then the correct output is silence plus a note: _"Holding period is not
available from this broker, so no short/long-term split is shown."_

### C.3 Wash sales — **recommend a static note, not detection**

Is it a real risk in this tool's output? **Not within a single plan.**
`planRebalance` iterates the union of held and targeted tickers once and emits at
most one order per ticker. A sell and a buy of the same name in one plan is
structurally impossible. Anyone reading the wash-sale rule against a
`RebalancePlan` will find nothing, because there is nothing there to find.

The real exposure is in the two places a `RebalancePlan` cannot see:

- **Across runs.** Sell a loser this month; the screen re-selects it next month
  because it is now cheaper still. That is a 30-day repurchase and it is a very
  plausible sequence for a deep-value process, which by construction keeps
  liking names that keep falling. Detecting it needs a trade history we do not
  persist.
- **Across accounts.** A repurchase inside an IRA does not defer the loss, it
  **permanently disallows** it (Rev. Rul. 2008-5), and no basis adjustment
  restores it. Detecting that needs simultaneous visibility of two accounts, and
  the tool operates on one at a time.

So: detection is not possible from the inputs, and a "no wash sales detected"
line would be worse than no line — it would read as clearance for the two cases
that actually bite. Emit a fixed note whenever a taxable plan contains any sell
or exit, and make it name the two gaps rather than reassure:

> Sells in a taxable account may trigger the wash-sale rule if the same or a
> substantially identical security is bought within 30 days either side —
> including in another account, and including in an IRA, where the loss is
> disallowed permanently rather than deferred. This plan sees one account and
> one point in time and cannot check either.

Effort: one string and a condition. Do it as part of C.1.

### C.4 Tax-loss harvesting — **out of scope, and a different product**

It is genuinely well-matched to the strategy: a deep-value book holds fallen
names, so harvestable losses are abundant rather than scarce. That is exactly why
it should be resisted here.

What it would need, none of which we have: per-lot basis and dates on every
broker (Alpaca cannot), a persistent 30-day trade calendar, a notion of
"substantially identical" that spans share classes and ETFs, a replacement-
security universe to park proceeds in, and account-spanning visibility. And what
it would produce is not a fact but a _recommendation to trade for tax reasons at
a particular time_ — which is both investment advice and tax advice in one
sentence, and is squarely across the line in section D.

The adjacent thing that is in scope, free, and already available: `Position`
carries `unrealisedGain`. Reporting per-position unrealised gain and loss in
`broker_positions` is a statement of a broker-reported fact, and a user who wants
to harvest can read it and decide. That is the correct division of labour.

### C.5 Refuse or warn differently — **warn, never refuse**

Refusing to plan a rebalance in a taxable account would be a recommendation
wearing a safety costume: it would assert that the tax cost outweighs the
rebalance, which is a judgement about circumstances the tool explicitly does not
know. Emit the plan; annotate it.

One note per plan, selected by treatment, each stating a fact and nothing more:

- `taxable` — _"This account is taxable, so sells and exits below realise
  reportable gains or losses. Figures here are arithmetic on your broker's cost
  basis, not tax figures."_ Plus the C.3 wash-sale note if any sell or exit
  exists.
- `roth`, `tax-deferred`, `tax-sheltered` — _"This account is tax-sheltered, so
  sales below do not realise a reportable capital gain. No gain figures are
  shown."_ Naming the specific flavour where known.
- `unknown` — _"The tax treatment of this account could not be determined from
  the broker's data, so no assumption was made in either direction. Sells may or
  may not realise reportable gains."_

The `unknown` note is the load-bearing one. It is what stops the absence of a
gain figure from reading as "no gain".

---

## D. The line

The server is not a tax advisor for the same reason it is not an investment
advisor: it does not know the user's circumstances, and it is answering from a
transcript nobody is supervising.

**May state as fact** — each of these is a figure retrieved this session with a
source attached:

- the account's classification, attributed: _"E\*TRADE reports this account as
  ROTHIRA."_ Attribution matters; the classification is the broker's claim.
- cost basis as the broker reports it, labelled as theirs and not ours
- proceeds, `shares × price`, with the price's `asOf` as everywhere else
- on a full exit, the arithmetic difference of those two, labelled _"gain or loss
  on the position, at the broker's reported basis"_
- that a rule exists and that the tool cannot check it (the wash-sale note)
- that something could not be determined

**Must not do**, in any output, however hedged:

- apply a tax rate, or produce any figure denominated in tax owed
- characterise a dollar amount as short-term or long-term gain
- recommend a lot-selection method, or suggest changing the account's election
- advise on timing — "consider selling in January", "harvest before year end"
- assert a wash sale occurred, or assert one did not
- describe a Roth as "better" for the transaction, or a taxable account as worse
- reproduce a contribution limit, a bracket, or any other figure from model
  memory. The rule that a name needs a dated figure retrieved this session
  applies to tax parameters too, and we have no provider for them.

### Proposed constant

In `src/tools/shared.ts`, alongside `DISCLAIMER` and appended the same way —
once per response, on any tool that prints a tax classification or a gain figure:

```ts
export const TAX_NOTE =
  '\n\n*Not tax advice. Account classification and cost basis are reported as ' +
  'your broker records them, not computed here, and may differ from the basis ' +
  'on your 1099-B. Gain figures are arithmetic, not a tax liability: holding ' +
  'period, wash sales, basis adjustments and your own circumstances are not ' +
  'modelled. Confirm against your broker’s cost-basis records and a tax ' +
  'professional before acting.*';
```

Placement: `plan_rebalance`, the broker accounts tool, and the broker positions
tool. It sits _above_ `DISCLAIMER` in the output so the two read as a pair, and
it is appended by the same once-per-response rule and for the same reason — a
client may surface one tool result with no surrounding conversation.

The `INSTRUCTIONS` block in `src/server.ts` needs one line under the rules that
hold regardless of what the user asks: _"Never state a tax liability, a tax rate,
or a short/long-term characterisation. Account tax treatment reported as
`unknown` means undetermined — do not read it as taxable."_ That last clause is
aimed at the model, which will otherwise fill the gap on its own.

---

## Recommendation on scope

Do:

1. `TaxTreatment` on `BrokerAccount` per section B, required and never defaulted,
   with `accountMode` added to the E\*TRADE parse so step 3 of the mapping can
   run.
2. `costBasis` on `Holding`, `costBasis` and `gainOnExit` on `Order`, exits only,
   per C.1 — plus the `netPositions` short-leg fix.
3. The three treatment notes and the wash-sale note per C.3 and C.5.
4. `TAX_NOTE`, and the `INSTRUCTIONS` line.

Do not, now:

5. Holding period and any short/long split (C.2). Needs a lots capability, is
   impossible for Alpaca, and is a lot-level property that does not belong on a
   netted `Position`.
6. Tax-loss harvesting (C.4). Different product, and the parts we would have to
   invent are exactly the parts that constitute advice.
7. Wash-sale detection (C.3). Not computable from a single plan against a single
   account, and a false all-clear is worse than silence.

The whole of "do" is roughly a day, and (1) is a prerequisite for (2) being
correct rather than merely present.
