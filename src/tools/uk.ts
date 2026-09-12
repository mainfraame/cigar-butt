import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import {
  companyProfile,
  registerFlags,
  searchCompanies
} from '../data/companies-house.ts';
import { attempt, cell, DISCLAIMER, text } from './shared.ts';

/**
 * UK Companies House. Register facts, not valuation — see the module comment
 * in `../data/companies-house.ts` for why the numbers are not here.
 */

export function registerUkTools(server: McpServer): void {
  server.registerTool(
    'uk_company_search',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Find a UK company on the Companies House register by name, and get its ' +
        'company number for `uk_company_status`. Searches every incorporated ' +
        'company, so a common name returns dormant shells and dissolved ' +
        'namesakes alongside the one you want — read the description column.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(15),
        query: z
          .string()
          .min(2)
          .max(160)
          .describe('Company name or part of one.')
      }),
      title: 'Search UK companies'
    },
    ({ limit, query }) =>
      attempt(async () => {
        const hits = await searchCompanies(query, limit);

        if (hits.length === 0) {
          return text(
            `No UK company matching "${query}".` +
              ' Companies House indexes the registered legal name, which often ' +
              'differs from a trading or brand name.' +
              DISCLAIMER
          );
        }

        const rows = hits
          .map(
            hit =>
              `| ${hit.title} | \`${hit.companyNumber}\` | ${hit.description} |`
          )
          .join('\n');

        return text(
          `## UK companies matching "${query}"\n\n` +
            `| Name | Number | Register entry |\n|---|---|---|\n${rows}\n\n` +
            'Pass a company number to `uk_company_status`.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'uk_company_status',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'The disqualifier check for a UK company, from the Companies House ' +
        'register: whether it still exists, whether it is in liquidation, ' +
        'administration or facing strike-off, whether its accounts are overdue, ' +
        'whether it has insolvency history, and whether its assets are pledged ' +
        'as security. This is the UK analogue of `check_disqualifiers` and ' +
        'should be run BEFORE any valuation work, for the same reason: a name ' +
        'these catch is dead regardless of how cheap it looks.\n\n' +
        'It does NOT return financials. UK accounts are filed as iXBRL or PDF ' +
        'documents rather than structured data, and a listed company’s real ' +
        'annual report goes to the FCA’s National Storage Mechanism, not here.',
      inputSchema: z.object({
        companyNumber: z
          .string()
          .min(2)
          .max(16)
          .describe(
            'Companies House number, e.g. "00445790". Zero-padded to eight ' +
              'digits automatically; Scottish and Northern Irish numbers keep ' +
              'their SC/NI prefix.'
          )
      }),
      title: 'UK company disqualifier check'
    },
    ({ companyNumber }) =>
      attempt(async () => {
        const profile = await companyProfile(companyNumber);
        const flags = registerFlags(profile);
        const fatal = flags.filter(flag => flag.severity === 'disqualify');

        const summary =
          fatal.length > 0
            ? `**DISQUALIFIED: ${fatal.map(flag => flag.label).join('; ')}.** Stop ` +
              'here — do not compute valuations for this name.'
            : flags.length > 0
              ? `No hard disqualifier. ${flags.length} item(s) to read before ` +
                'trusting the accounts.'
              : 'Register is clean: active, accounts filed on time, no charges ' +
                'and no insolvency history.';

        const rows = flags
          .map(flag => `| ${flag.severity} | ${flag.label} | ${flag.detail} |`)
          .join('\n');

        return text(
          `## ${profile.companyName} (${profile.companyNumber})\n\n` +
            `Status **${profile.status}**` +
            `${profile.statusDetail ? ` — ${profile.statusDetail}` : ''} · ` +
            `${cell(profile.type)} · incorporated ${cell(profile.incorporatedOn)} · ` +
            `${cell(profile.jurisdiction)}\n\n` +
            `SIC: ${profile.sicCodes.length > 0 ? profile.sicCodes.join(', ') : '—'}\n\n` +
            `${summary}\n\n` +
            (flags.length > 0
              ? `| Severity | Finding | Detail |\n|---|---|---|\n${rows}\n\n`
              : '') +
            `Next accounts due: ${cell(profile.accountsNextDue)}.\n\n` +
            '**The register carries no figures.** For the balance sheet, open the ' +
            "company's filing history on Companies House, or the FCA National " +
            'Storage Mechanism if it is listed. This server computes asset tests ' +
            'from SEC EDGAR (US) and EDINET (Japan) only.' +
            DISCLAIMER
        );
      })
  );
}
