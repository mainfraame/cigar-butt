import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { screenMarket } from '../analysis/screen.ts';
import { dec, out, ZERO } from '../math/decimal.ts';
import { allocate } from '../portfolio/allocate.ts';
import { planRebalance } from '../portfolio/rebalance.ts';
import {
  attempt,
  cell,
  COST_NOTE,
  DISCLAIMER,
  pct,
  requireCapabilities,
  TAX_NOTE,
  text,
  usd
} from './shared.ts';

import type { Order } from '../portfolio/rebalance.ts';

/** Renders one side of a rebalance plan; empty sections are omitted entirely. */
export function orderTable(
  title: string,
  orders: readonly Order[],
  { withGain = false }: { withGain?: boolean } = {}
): string {
  if (orders.length === 0) return '';

  // Columns appear only when there is something to put in them. Participation
  // needs `averageDailyVolume` on the holding and fees are sell-side only, so
  // a fixed layout would print a column of em-dashes on most plans — and an
  // em-dash where a cost belongs reads as "zero cost" to a hurried eye.
  const showParticipation = orders.some(
    order => order.participation !== undefined
  );
  const showFees = orders.some(
    order => order.estimatedFees !== undefined && order.estimatedFees > 0
  );

  const rows = orders
    .map(order => {
      const cells = [
        order.ticker,
        String(order.shares),
        usd(order.price),
        usd(order.estimatedProceeds),
        ...(showParticipation
          ? [
              order.participation === undefined
                ? cell(undefined)
                : pct(order.participation)
            ]
          : []),
        ...(showFees
          ? [
              order.estimatedFees === undefined
                ? cell(undefined)
                : usd(order.estimatedFees)
            ]
          : []),
        usd(order.currentValue),
        usd(order.targetValue),
        pct(order.driftFraction),
        order.asOf,
        ...(withGain
          ? [
              cell(
                order.costBasis === undefined ? undefined : usd(order.costBasis)
              ),
              cell(
                order.gainOnExit === undefined
                  ? undefined
                  : usd(order.gainOnExit)
              )
            ]
          : [])
      ];
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');

  const headings = [
    'Ticker',
    'Shares',
    'Price',
    'Notional',
    ...(showParticipation ? ['Session %'] : []),
    ...(showFees ? ['Statutory fees'] : []),
    'Now',
    'Target',
    'Drift',
    'As of',
    ...(withGain ? ['Cost basis', 'Gain'] : [])
  ];

  const head =
    `| ${headings.join(' | ')} |\n` +
    `|${headings.map(() => '---').join('|')}|\n`;

  return `### ${title}\n\n${head}${rows}\n\n`;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be an ISO date, e.g. 2026-09-12')
  .describe(
    'The date this price is as of. Required — an undated price cannot be sized against.'
  );

const positiveMoney = z.number().positive().finite();

const candidateSchema = z.object({
  asOf: isoDate,
  price: positiveMoney.describe('Current price per share.'),
  ticker: z.string().min(1).max(10),
  weight: z
    .number()
    .positive()
    .finite()
    .optional()
    .describe(
      'Relative weight. Omit for equal weight, which is what the method calls for — ' +
        'Schloss deliberately distrusted per-name conviction.'
    )
});

const holdingSchema = z.object({
  asOf: isoDate,
  averageDailyVolume: z
    .number()
    .nonnegative()
    .finite()
    .optional()
    .describe(
      'Typical dollar volume in a session, from `price_history_stats`. Supply ' +
        'it to learn what share of a normal day each order represents — the ' +
        'cost that actually matters, and the only one computable without ' +
        'bid/ask data no free provider exposes.'
    ),
  costBasis: z
    .number()
    .nonnegative()
    .finite()
    .optional()
    .describe(
      'What the whole position cost, as the broker records it. Omit when ' +
        'unknown — it is only used to state the gain on a full exit, and a ' +
        'guessed basis would produce a figure nobody could check.'
    ),
  price: positiveMoney.describe('Price the position is currently marked at.'),
  shares: z.number().nonnegative().finite(),
  ticker: z.string().min(1).max(10)
});

const targetSchema = z.object({
  asOf: isoDate,
  price: positiveMoney,
  ticker: z.string().min(1).max(10),
  weight: z
    .number()
    .nonnegative()
    .finite()
    .describe('Fraction of the portfolio. Normalised across the target list.')
});

export function registerPortfolioTools(server: McpServer): void {
  server.registerTool(
    'build_allocation',
    {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description:
        'Turn a verified candidate list and a cash balance into whole-share position ' +
        'targets. Equal weight by default, with a per-name cap and whole-share ' +
        'rounding that always rounds down, so the plan can never exceed the balance. ' +
        'Only pass names you have actually verified with `analyze_ticker`: a weighting ' +
        'implies a level of diligence a screen does not provide.',
      inputSchema: z.object({
        allowFractionalShares: z
          .boolean()
          .default(false)
          .describe('Most brokers settle whole lots; off by default.'),
        availableCash: positiveMoney.describe('Cash available to deploy.'),
        candidates: z.array(candidateSchema).min(1).max(200),
        maxPositionFraction: z
          .number()
          .positive()
          .max(1)
          .default(0.1)
          .describe(
            'Hard ceiling on any one name, as a fraction of the balance.'
          ),
        perTradeCost: z
          .number()
          .nonnegative()
          .finite()
          .default(0)
          .describe(
            'Per-trade commission. Zero is correct at both supported brokers ' +
              'for a listed equity buy — there is no buy-side statutory fee at ' +
              'all — so raise it only for an OTC name (E*TRADE charges $6.95) ' +
              'or a broker that still bills commission.'
          )
      }),
      title: 'Build an allocation'
    },
    args =>
      Promise.resolve(
        attempt(() => {
          const plan = allocate({
            allowFractionalShares: args.allowFractionalShares,
            availableCash: dec(args.availableCash) ?? ZERO,
            candidates: args.candidates.map(candidate => ({
              asOf: candidate.asOf,
              price: dec(candidate.price) ?? ZERO,
              ticker: candidate.ticker.toUpperCase(),
              weight: dec(candidate.weight)
            })),
            maxPositionFraction: dec(args.maxPositionFraction) ?? ZERO,
            perTradeCost: dec(args.perTradeCost) ?? ZERO
          });

          const rows = plan.lines
            .map(
              line =>
                `| ${line.ticker} | ${line.shares} | ${usd(line.price)} | ${usd(line.cost)} | ${pct(line.weight)} | ${line.asOf} |`
            )
            .join('\n');

          return Promise.resolve(
            text(
              `## Allocation\n\n` +
                `| Ticker | Shares | Price | Cost | Weight | Price as of |\n|---|---|---|---|---|---|\n${rows}\n\n` +
                `Deployed ${usd(plan.deployedCash)} of ${usd(args.availableCash)}; ` +
                `${usd(plan.residualCash)} left as cash after ${usd(plan.totalCommission)} in commissions.\n\n` +
                (plan.notFunded.length > 0
                  ? `### Not funded\n\n${plan.notFunded
                      .map(entry => `- **${entry.ticker}**: ${entry.reason}`)
                      .join('\n')}\n\n`
                  : '') +
                (plan.warnings.length > 0
                  ? `### Warnings\n\n${plan.warnings.map(w => `- ${w}`).join('\n')}\n\n`
                  : '') +
                'Equal weight is the method, not a default to be improved on: the ' +
                'strategy works statistically across many names, and any weighting ' +
                'that expresses conviction is a different strategy.' +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'plan_rebalance',
    {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description:
        'Compare current holdings against a target allocation and produce the buys, ' +
        'sells and full exits that close the gap. Compares market value, not share ' +
        'count, so a name that has re-rated shows as overweight. Sells are reported ' +
        'before buys because the proceeds fund them, and the plan says explicitly ' +
        'when the buys are not fundable from cash plus proceeds.',
      inputSchema: z.object({
        allowFractionalShares: z.boolean().default(false),
        availableCash: z
          .number()
          .nonnegative()
          .finite()
          .default(0)
          .describe('Uninvested cash, folded into the portfolio value.'),
        driftTolerance: z
          .number()
          .min(0)
          .max(1)
          .default(0.05)
          .describe(
            'Ignore drift below this fraction of target. Exits are never suppressed by it.'
          ),
        holdings: z.array(holdingSchema).max(500),
        minTradeValue: z
          .number()
          .nonnegative()
          .finite()
          .default(0)
          .describe('Suppress orders whose notional is below this.'),
        targets: z.array(targetSchema).max(500),
        taxTreatment: z
          .enum(['roth', 'tax-deferred', 'tax-sheltered', 'taxable', 'unknown'])
          .default('unknown')
          .describe(
            'How a sale in this account is taxed. `broker_accounts` reports it. ' +
              'Leave `unknown` if you do not know — it is NOT a synonym for ' +
              'taxable, and claiming taxable would fabricate a cost.'
          )
      }),
      title: 'Plan a rebalance'
    },
    args =>
      Promise.resolve(
        attempt(() => {
          const plan = planRebalance({
            allowFractionalShares: args.allowFractionalShares,
            availableCash: dec(args.availableCash) ?? ZERO,
            driftTolerance: dec(args.driftTolerance) ?? ZERO,
            holdings: args.holdings.map(holding => ({
              asOf: holding.asOf,
              averageDailyVolume: dec(holding.averageDailyVolume),
              costBasis: dec(holding.costBasis),
              price: dec(holding.price) ?? ZERO,
              shares: dec(holding.shares) ?? ZERO,
              ticker: holding.ticker.toUpperCase()
            })),
            minTradeValue: dec(args.minTradeValue) ?? ZERO,
            targets: args.targets.map(target => ({
              asOf: target.asOf,
              price: dec(target.price) ?? ZERO,
              ticker: target.ticker.toUpperCase(),
              weight: dec(target.weight) ?? ZERO
            })),
            taxTreatment: args.taxTreatment
          });

          return Promise.resolve(
            text(
              `## Rebalance plan\n\n` +
                `Portfolio value ${usd(plan.portfolioValue)} including ${usd(args.availableCash)} cash.\n\n` +
                orderTable('Sell', plan.sells) +
                orderTable('Exit (held, not in targets)', plan.exits, {
                  withGain: true
                }) +
                orderTable('Buy', plan.buys) +
                `Net cash flow ${usd(plan.netCashFlow)}; cash after execution ${usd(plan.cashAfter)}.\n\n` +
                (plan.unchanged.length > 0
                  ? `### Within tolerance — no order\n\n${plan.unchanged
                      .map(
                        entry =>
                          `- ${entry.ticker} (${pct(entry.driftFraction)} drift)`
                      )
                      .join('\n')}\n\n`
                  : '') +
                (plan.notes.length > 0
                  ? `### Notes\n\n${plan.notes.map(note => `- ${note}`).join('\n')}\n\n`
                  : '') +
                (plan.exits.some(order => order.gainOnExit !== undefined)
                  ? 'The gain column appears on full exits only. Every lot goes, ' +
                    'so the figure is exact whatever basis method the account ' +
                    'uses. It is deliberately absent on partial sells: the gain ' +
                    'depends on which shares go, and average cost is not a ' +
                    'permitted basis method for individual equities, so a ' +
                    'pro-rata number would have no defensible meaning.\n\n'
                  : args.taxTreatment === 'unknown'
                    ? 'No gain figures: the account\u2019s tax treatment was not ' +
                      'given. `unknown` is not taken to mean taxable — that ' +
                      'would fabricate a cost. `broker_accounts` reports it.\n\n'
                    : '') +
                'Execute the sells before the buys. Selling is the harder half of ' +
                'this method: a name that has closed its discount has done its job, ' +
                'and holding it past that point is a different decision than the one ' +
                'that bought it.' +
                // The note explains figures. With none on the page it is
                // boilerplate pointing at nothing — and the useful reply is
                // the one input that produces the figure.
                (() => {
                  const orders = [...plan.sells, ...plan.exits, ...plan.buys];
                  const hasCost = orders.some(
                    order =>
                      order.participation !== undefined ||
                      (order.estimatedFees !== undefined &&
                        order.estimatedFees > 0)
                  );
                  return hasCost
                    ? COST_NOTE
                    : '\n\n*No order carries a participation figure. Pass ' +
                        '`averageDailyVolume` on each holding — ' +
                        '`price_history_stats` reports it — to learn what share ' +
                        'of a normal session each order would be. That is the ' +
                        'execution cost that actually matters on a thin name, ' +
                        'and it is the only part of it computable from any ' +
                        'source configured here.*';
                })() +
                TAX_NOTE +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'screen_market',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Screen every SEC filer that reported in a quarter, using the XBRL `frames` ' +
        'endpoint. Five requests total regardless of universe size. Computes tangible ' +
        'book and NCAV for the whole market from primary filing data — no commercial ' +
        'screener. Returns candidates ranked by NCAV as a share of tangible book. ' +
        'It attaches NO prices: pairing a stale quote with a filing figure is the ' +
        'mistake this server exists to prevent, so run `analyze_ticker` on the ' +
        'survivors to get a dated price and a verdict.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        maxPriceToBook: z
          .number()
          .positive()
          .optional()
          .describe(
            'Cap on price over tangible book. Requires `withPrices`. Schloss ' +
              'wanted 0.6–0.8; 1.0 is the outer edge of the method.'
          ),
        minNcavRatio: z
          .number()
          .min(0)
          .max(5)
          .default(0.5)
          .describe(
            'Require NCAV to be at least this fraction of tangible book. Higher means ' +
              'closer to a pure liquid-balance-sheet company.'
          ),
        minTangibleBook: z
          .number()
          .nonnegative()
          .default(50_000_000)
          .describe(
            'Floor on tangible book in dollars. Below roughly $50M of market cap, ' +
              'spreads eat the return.'
          ),
        period: z
          .string()
          .regex(
            /^CY\d{4}(Q[1-4]I?)?$/,
            'Format is CY2026Q1I for an instantaneous (balance-sheet) frame.'
          )
          .describe(
            'Reporting period, e.g. CY2026Q1I. Balance-sheet concepts need the ' +
              'trailing I. Use a quarter old enough that most filers have reported.'
          ),
        withPrices: z
          .boolean()
          .default(false)
          .describe(
            'Join a whole-market close and rank by price over tangible book — ' +
              "Schloss's actual filter. One extra request buys every US close. " +
              'Without it the screen can only rank balance-sheet shape, which ' +
              'puts pure-cash balance sheets on top and buries the profitable ' +
              'business trading under its book.'
          )
      }),
      title: 'Screen the whole market'
    },
    ({
      limit,
      maxPriceToBook,
      minNcavRatio,
      minTangibleBook,
      period,
      withPrices
    }) =>
      attempt(async () => {
        const blocked = requireCapabilities('sec');
        if (blocked) return blocked;

        const { priceAsOf, priced, rows, universeSize } = await screenMarket({
          maxPriceToBook: dec(maxPriceToBook),
          minNcavRatio: dec(minNcavRatio),
          minTangibleBook: dec(minTangibleBook),
          period,
          withPrices
        });

        const shown = rows.slice(0, limit);
        const table = shown
          .map(row =>
            withPrices
              ? `| ${row.ticker ?? '—'} | ${row.entityName} | ` +
                `${usd(out(row.marketCap, 0))} | ${usd(out(row.tangibleBook, 0))} | ` +
                `**${out(row.priceToTangibleBook, 2)}** | ` +
                `${cell(out(row.priceToNcav, 2))} | ${row.periodEnd} |`
              : `| ${row.entityName} | ${row.cik} | ${usd(out(row.tangibleBook, 0))} | ` +
                `${usd(out(row.ncav, 0))} | ${pct(out(row.ncavToTangibleBook))}` +
                `${row.basisInconsistent ? ' ⚠' : ''} | ${row.periodEnd} |`
          )
          .join('\n');

        return text(
          `## Market screen — ${period}\n\n` +
            `${universeSize} filers reported \`StockholdersEquity\` for this period; ` +
            `${rows.length} cleared the filters; showing ${shown.length}.\n\n` +
            (withPrices
              ? `| Ticker | Company | Market cap | Tangible book | P/TBV | P/NCAV | Period end |\n|---|---|---|---|---|---|---|\n${table}\n\n`
              : `| Company | CIK | Tangible book | NCAV | NCAV/TBV | Period end |\n|---|---|---|---|---|---|\n${table}\n\n`) +
            (withPrices
              ? `Prices are the closes for **${priceAsOf ?? 'an unknown session'}**, ` +
                `joined to ${priced.toLocaleString('en-US')} of the ${universeSize.toLocaleString('en-US')} ` +
                'filers by ticker. A filer the join missed — no ticker in the SEC ' +
                'index, a share count it never tagged, or no trade that session — ' +
                'is absent from this list rather than shown unpriced. Ranked ' +
                'cheapest first by price over tangible book.\n\n' +
                '**Market cap here is a vendor join, not a filing.** The share ' +
                'count comes from XBRL and the price from a quote, and for an ADR ' +
                'those are different units — `analyze_ticker` cross-checks each ' +
                'name and will say so.\n\n'
              : '') +
            '**These are candidates, not results.** ' +
            (withPrices
              ? 'A price alone does not make a name cheap: the balance sheet may ' +
                'be about to be consumed, and the filing index may already say ' +
                'the name is dead. '
              : 'No price is attached, so nothing here says a name is cheap — ' +
                'only that its balance sheet is the right shape. ') +
            'Run `check_disqualifiers` and then `analyze_ticker` on each name ' +
            'before it goes anywhere near a portfolio.\n\n' +
            (shown.some(row => row.basisInconsistent)
              ? '⚠ **A ratio above 100% is not a measurement.** NCAV cannot exceed ' +
                'tangible book on a consistently drawn balance sheet — NCAV is ' +
                'equity less non-current assets, tangible book is equity less ' +
                'goodwill and intangibles, and those are non-current assets. ' +
                'Above 100% means the two figures came from different bases, ' +
                'almost always a non-controlling interest: `StockholdersEquity` ' +
                "is the parent's share alone while assets and liabilities are the " +
                'whole consolidated group, which is how an Up-C is built. Those ' +
                'rows sort last here for that reason. They are not disqualified — ' +
                'read the actual balance sheet with `analyze_ticker`, which pins ' +
                'every line item to one filing.\n\n'
              : '') +
            (rows.length < 15
              ? 'Fewer than 15 names cleared. Asset-based screens empty out after a ' +
                'broad rally, and the universe may simply not contain enough ' +
                'qualifying names right now. Loosening the filters until it does ' +
                'means you are no longer running this strategy.\n'
              : '') +
            DISCLAIMER
        );
      })
  );
}
