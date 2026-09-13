import type { TaxTreatment } from './contract.ts';

/**
 * Mapping a broker's own account vocabulary onto tax treatment.
 *
 * Kept out of the adapters because the trap is shared and subtle: several
 * brokers report settlement mode and registration type through the *same*
 * field, so a mapping that treats "not a retirement token" as taxable is
 * confidently wrong. Everything unrecognised falls through to `unknown`.
 */

/** Post-tax in, untaxed out. A sale realises nothing reportable. */
const ETRADE_ROTH = new Set([
  'BENFROTHIRA',
  'BENF_ROTH_ESTATE_IRA',
  'BENF_ROTH_MINOR_IRA',
  'BENF_ROTH_TRUST_IRA',
  'CONVERSION_ROTH_IRA',
  'COVERDELL_ESA',
  'ROTHIRA',
  'ROTH_INDIVIDUAL_K',
  'ROTH_IRA_MINORS'
]);

/** Pre-tax in, taxed on withdrawal. A sale inside still realises nothing. */
const ETRADE_DEFERRED = new Set([
  'BENFIRA',
  'BENF_ESTATE_IRA',
  'BENF_MINOR_IRA',
  'BENF_TRUST_IRA',
  'CONTRIBUTORY',
  'INDIVIDUAL_K',
  'IRA',
  'IRA_ROLLOVER',
  'MONEY_PURCHASE',
  'PROFIT_SHARING',
  'SARSEPIRA',
  'SEPIRA',
  'SIMPLE_IRA',
  'TRD_IRA_MINORS'
]);

/** Registrations where a sale does realise a reportable gain. */
const ETRADE_TAXABLE = new Set([
  'BROKER',
  'COMM_PROP',
  'CONSERVATOR',
  'CORPORATION',
  'CUSTODIAL',
  'ESTATE',
  'INDIVIDUAL',
  'JOINT',
  'JTTEN',
  'JTWROS',
  'NON_PROFIT',
  'PARTNERSHIP',
  'PROPRIETARY',
  'TIC',
  'TRUST'
]);

/**
 * E*TRADE's `accountType` is not a registration field.
 *
 * Its value set mixes registration (`INDIVIDUAL`, `JTWROS`), plan type
 * (`ROTHIRA`, `SEPIRA`), **settlement mode** (`CASH`, `MARGIN`, `PDT_ACCOUNT`)
 * and even banking products (`CREDITCARD`, `HELOC`). The sandbox returns
 * `MARGIN` and `CASH`, which say nothing about tax at all — so the order below
 * matters, and step 5 is the point of the whole function.
 *
 * `accountMode === 'IRA'` catches retirement accounts whose type token is not
 * in either list (`IRACD`, `PREFIRACD`, `VARIRACD`): we then know for certain a
 * sale realises nothing, and know for certain we cannot say which flavour.
 */
export function etradeTaxTreatment(
  accountType: string | undefined,
  accountMode?: string
): TaxTreatment {
  const type = accountType?.trim().toUpperCase() ?? '';

  if (ETRADE_ROTH.has(type)) return 'roth';
  if (ETRADE_DEFERRED.has(type)) return 'tax-deferred';
  if (accountMode?.trim().toUpperCase() === 'IRA') return 'tax-sheltered';
  if (ETRADE_TAXABLE.has(type)) return 'taxable';
  if (/^(LLC|LLP|INVCLUB)/.test(type) || type.endsWith('_CORP'))
    return 'taxable';

  // CASH, MARGIN, PDT_ACCOUNT, PM_ACCOUNT, OTHER, INVALID and every banking
  // product land here. Letting them fall through to `taxable` would be
  // confidently wrong on the only values we have actually observed.
  return 'unknown';
}

/**
 * Alpaca's **Broker** API. The Trading API has no registration field at all, so
 * an adapter built on it must return `unknown` unconditionally rather than
 * assume a paper key means a taxable account.
 */
export function alpacaTaxTreatment(
  accountType: string | undefined,
  accountSubType?: string
): TaxTreatment {
  const type = accountType?.trim().toLowerCase() ?? '';
  const sub = accountSubType?.trim().toLowerCase() ?? '';

  if (type === 'hsa') return 'roth';
  if (type === 'ira') {
    if (sub === 'roth') return 'roth';
    if (sub === 'traditional') return 'tax-deferred';
    return 'tax-sheltered';
  }
  if (
    ['custodial', 'donor_advised', 'joint', 'trading', 'trust'].includes(type)
  ) {
    return 'taxable';
  }
  return 'unknown';
}

/** How the treatment should read in tool output. */
/**
 * Fidelity reports registration as a legal construct code (`ROTHIRA`) and an
 * `isIra` flag.
 *
 * Only two things are asserted, because only two are safe. A code naming Roth
 * is Roth. Any other IRA is tax-deferred: Traditional, Rollover, SEP and SIMPLE
 * all shelter growth and tax the withdrawal, and an inherited Roth still names
 * Roth. A non-IRA account is left `unknown` rather than called taxable.
 */
export function fidelityTaxTreatment(
  legalConstructCode: string | undefined,
  isIra: boolean | undefined
): TaxTreatment {
  if (legalConstructCode?.toUpperCase().includes('ROTH')) return 'roth';
  if (isIra === true) return 'tax-deferred';
  return 'unknown';
}

export function describeTaxTreatment(treatment: TaxTreatment): string {
  switch (treatment) {
    case 'roth': {
      return 'Roth — a sale here realises no reportable gain';
    }
    case 'tax-deferred': {
      return 'Tax-deferred — a sale here realises no currently reportable gain';
    }
    case 'tax-sheltered': {
      return 'Retirement account, flavour undisclosed — a sale realises no reportable gain';
    }
    case 'taxable': {
      return 'Taxable — a sale here realises a reportable capital gain';
    }
    case 'unknown': {
      return 'Tax treatment undetermined — the broker did not say, and this is NOT the same as taxable';
    }
  }
}
