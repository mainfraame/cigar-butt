import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { extractItem, filingText } from '../data/filing-text.ts';
import { resolveTicker, submissions } from '../data/sec.ts';
import { attempt, DISCLAIMER, requireCapabilities, text } from './shared.ts';

/** How much prose to return before truncating. */
const DEFAULT_LIMIT = 6000;

export function registerFilingTools(server: McpServer): void {
  server.registerTool(
    'read_filing',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Read the actual text of an SEC filing. `check_disqualifiers` ends by ' +
        'telling you to read something — an 8-K item 4.02, a 3.01, an auditor ' +
        'change — and this is how you read it.\n\n' +
        'The filing index cannot answer what an item says, only that it ' +
        'exists, and for some codes that is the whole question. Item 3.01 ' +
        'covers both "we are failing a listing rule" and "we have regained ' +
        'compliance", which are opposite facts filed under one number. Nothing ' +
        'short of the words distinguishes them.\n\n' +
        'Pass `item` to return just that section of an 8-K rather than the ' +
        'whole document, which usually bundles several unrelated disclosures.',
      inputSchema: z.object({
        accession: z
          .string()
          .max(32)
          .optional()
          .describe(
            'Exact accession number, e.g. `0000950170-25-060165`. Omit to take ' +
              'the most recent filing matching `form` and `item`.'
          ),
        form: z
          .string()
          .max(16)
          .default('8-K')
          .describe('Form type to search for when no accession is given.'),
        item: z
          .string()
          .max(8)
          .optional()
          .describe(
            'An 8-K item number such as `3.01`. Filters the search and scopes ' +
              'the text returned to that section.'
          ),
        maxChars: z.number().int().min(500).max(20_000).default(DEFAULT_LIMIT),
        ticker: z.string().min(1).max(10)
      }),
      title: 'Read the text of a filing'
    },
    ({ accession, form, item, maxChars, ticker }) =>
      attempt(async () => {
        const blocked = requireCapabilities('sec');
        if (blocked) return blocked;

        const company = await resolveTicker(ticker);
        if (!company) {
          return text(
            `No SEC filer matches the ticker ${ticker.toUpperCase()}.`
          );
        }

        const cik = String(company.cik_str);
        const { events } = await submissions(cik);

        const matches = accession
          ? events.filter(event => event.accessionNumber === accession)
          : events.filter(
              event =>
                event.form.toUpperCase() === form.toUpperCase() &&
                (item === undefined || event.items.includes(item))
            );

        const event = matches[0];
        if (!event) {
          return text(
            accession
              ? `No filing with accession ${accession} for ${company.ticker}.`
              : `No ${form}${item ? ` carrying item ${item}` : ''} in the ` +
                  `filing index for ${company.ticker}.`
          );
        }

        const body = await filingText(cik, event);
        if (!body) {
          return text(
            `Could not read the document for ${event.form} ` +
              `${event.accessionNumber} (filed ${event.filingDate}). The index ` +
              'names it but the file did not come back — open it directly at ' +
              'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' +
              `${cik}`
          );
        }

        const scoped = item ? extractItem(body, item) : undefined;
        const chosen = scoped ?? body;
        const truncated = chosen.length > maxChars;

        return text(
          `## ${company.title} — ${event.form}` +
            `${event.items.length > 0 ? ` (items ${event.items.join(', ')})` : ''}\n\n` +
            `Filed ${event.filingDate}` +
            `${event.reportDate ? `, reporting ${event.reportDate}` : ''}. ` +
            `Accession \`${event.accessionNumber}\`.\n\n` +
            (item && scoped === undefined
              ? `Item ${item} is listed in the index but no heading for it was ` +
                'found in the text, so the whole document follows. Filers ' +
                'format these by hand and some omit the heading.\n\n'
              : '') +
            `${chosen.slice(0, maxChars)}${truncated ? '…' : ''}\n\n` +
            (truncated
              ? `Truncated at ${maxChars} characters of ${chosen.length}. Raise ` +
                '`maxChars` or pass `item` to narrow it.\n\n'
              : '') +
            'This is the filing itself, not a summary of it. Quote it rather ' +
            'than paraphrase when the wording decides the question.' +
            DISCLAIMER
        );
      })
  );
}
