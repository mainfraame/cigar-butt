import { McpServer } from '@modelcontextprotocol/server';

import { loadEnvFile, setupReport } from './config/store.ts';
import { renderSetup, startupBanner } from './setup/report.ts';
import { registerBrokerTools } from './tools/broker.ts';
import { registerCacheTools } from './tools/cache.ts';
import { registerCongressTools } from './tools/congress.ts';
import { registerJapanTools } from './tools/japan.ts';
import { registerMarketTools } from './tools/market.ts';
import { registerPortfolioTools } from './tools/portfolio.ts';
import { registerResearchTools } from './tools/research.ts';
import { registerSetupTools } from './tools/setup.ts';
import { registerTechnicalTools } from './tools/technical.ts';
import { registerUkTools } from './tools/uk.ts';
import { registerWatchTools } from './tools/watch.ts';

/** Kept in sync with package.json by the build; see tsdown.config.ts. */
const VERSION = '0.1.0';

/**
 * Instructions the client shows the model alongside the tool list. This is
 * where the method's discipline lives, because a model that calls the tools in
 * the wrong order gets confidently wrong answers out of correct tools.
 */
const INSTRUCTIONS = `
cigar-butt screens stocks against Benjamin Graham and Walter Schloss deep-value
criteria, using SEC filing data rather than aggregator figures.

Order of operations, which matters more than any single tool:

1. \`setup_status\` — credentials first. Every research tool refuses without them.
2. \`screen_market\` or a candidate list the user supplies. Never generate
   tickers from memory; valuations move, and a list assembled from training data
   will be confidently wrong in exactly the way that costs money.
3. \`check_disqualifiers\` on each candidate, BEFORE any valuation work. A name
   with an 8-K item 4.02, a Form 25, or a filing gap is dead regardless of how
   cheap it looks, and no ratio catches that.
4. \`analyze_ticker\` on the survivors. Every figure it returns carries the
   filing it came from and the date it was filed.
5. \`check_corporate_actions\` before pairing a filing's share count with a
   price. A split between those two dates makes every per-share figure wrong by
   the split factor, and a reverse split makes a name look cheap by exactly it.
6. \`short_interest\` to answer "why is it cheap?" with a fact rather than a
   narrative. It is context, not a veto.
7. \`build_allocation\` only for names actually verified above. A weighting
   implies a level of diligence a screen does not provide.
8. \`broker_positions\` when the user has a brokerage account, rather than
   having them retype their book. It reads every connected broker as one
   book — a name held at two brokers is one position — and its output carries
   a JSON block shaped for \`plan_rebalance\`. \`broker_connect\` first if
   nothing is connected yet.
9. \`plan_rebalance\` to turn targets plus current holdings into orders.

Rules that hold regardless of what the user asks for:

- A name goes in output only with a dated figure retrieved this session.
- A check reading "n/a" could not be computed. That is a gap in the evidence,
  not a passed or failed test — never report it as either.
- Enterprise value and net cash are meaningless for financials (SIC 6000-6799):
  deposits and the securities book are not spare cash. Use \`bank_call_report\`
  on those names — tangible common equity, noncurrent loans, and the allowance
  held against them are the tests that do work on a bank.
- Net-nets are rare in the US, and far less so in Japan. If a US screen comes
  up empty, that is a real finding — say so, and offer \`edinet_search\` rather
  than loosening filters until something qualifies.
- Flag correlation. Four shipping names in a 20-name book is not four bets.
- \`price_history_stats\` is price and volume only — how much of a name trades,
  how long a position would take to sell, how far it has fallen. It is outside
  the method: no statistic in it bears on whether a balance sheet is cheap, and
  none of it may be used to time a purchase. Its one veto is liquidity — a name
  you cannot exit is a name you cannot own, whatever the discount.
- Never turn a participation ratio into a dollar cost. Spread and market impact
  are not observable from anything here and are not estimated; the fee figures
  are statutory charges only and are a hundred times smaller than the real cost
  of trading a thin name.
- A combined book has no single tax treatment. Where accounts are taxed
  differently the handoff says \`unknown\`, and that is the honest answer, not a
  gap to fill: which account a sale comes out of is the user's choice and it
  decides whether the sale is reportable at all.
- Never state a tax liability, a tax rate, or a short/long-term
  characterisation. An account whose tax treatment reads \`unknown\` is
  undetermined — do NOT read it as taxable, and do not fill the gap yourself.
- This is not investment advice, and the server is not a financial advisor.
`.trim();

export function createServer(): McpServer {
  loadEnvFile();

  const server = new McpServer(
    { name: 'cigar-butt', version: VERSION },
    { instructions: INSTRUCTIONS }
  );

  // stdout belongs to the protocol; stderr is where a client's install output
  // and logs surface, so the sign-up links land in front of the user at the
  // moment they add the server rather than at their first refused tool call.
  process.stderr.write(`${startupBanner(setupReport())}\n`);

  // A prompt rather than only a tool: clients list prompts in a picker, so
  // "getting started" is discoverable without the model having to know to ask.
  server.registerPrompt(
    'getting-started',
    {
      description:
        'Every credential this server can use, whether it is configured, and ' +
        'step-by-step instructions for obtaining each one — including how to ' +
        'create an E*TRADE sandbox and production API key.',
      title: 'Set up cigar-butt'
    },
    () => ({
      messages: [
        {
          content: { text: renderSetup(), type: 'text' as const },
          role: 'user' as const
        }
      ]
    })
  );

  registerSetupTools(server);
  registerResearchTools(server);
  registerMarketTools(server);
  registerPortfolioTools(server);
  registerTechnicalTools(server);
  registerBrokerTools(server);
  registerCongressTools(server);
  registerJapanTools(server);
  registerUkTools(server);
  registerWatchTools(server);
  registerCacheTools(server);

  return server;
}
