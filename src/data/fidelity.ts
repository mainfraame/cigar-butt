import { gzipSync } from 'node:zlib';

import { cached } from '../cache/store.ts';
import { getCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import { dec, type Decimal } from '../math/decimal.ts';

/**
 * Fidelity, read-only, from the endpoints its own web app calls.
 *
 * Fidelity publishes no retail API. These are the JSON services behind
 * digital.fidelity.com, observed in a capture of the user's own session, and
 * they carry no compatibility promise: a field can be renamed on any release,
 * and the failure then looks like a missing figure rather than an error. That
 * is why every parser here reads optionally and reports what it could not
 * find, instead of defaulting.
 *
 * Authentication is the browser session. There is no key and no OAuth grant —
 * the user copies the `Cookie` header from a logged-in tab into
 * `FIDELITY_COOKIE`. It expires with the session, and an expired one comes back
 * as an HTML login page rather than a 401, which `post` turns into a message
 * the user can act on.
 *
 * Only Brokerage accounts are read. Workplace plans (401(k), acctType `WPS`)
 * are served by a different set of services that were not captured.
 */

const HOST = 'https://digital.fidelity.com';
const RATE = { rateKey: 'digital.fidelity.com', requestsPerSecond: 1 } as const;

/** Positions and balances are marks; five minutes spares a repeat call. */
const TTL_SNAPSHOT = 5 * 60;

export const FIDELITY_COOKIE = 'FIDELITY_COOKIE';

export function fidelityCookie(): string | undefined {
  return getCredential(FIDELITY_COOKIE)?.trim() || undefined;
}

/**
 * The `pico` / `picoString` request parameter: gzip, then base64, of a JSON
 * description of the accounts being asked about.
 *
 * It looks like opaque server state and is not. The web client builds it from
 * account records it already holds, and nothing in it is secret or signed —
 * which is what makes the positions and balances services callable at all.
 */
export function encodePico(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString(
    'base64'
  );
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const cookie = fidelityCookie();
  if (!cookie) {
    throw new Error(
      'No Fidelity session. Log in at digital.fidelity.com, copy the Cookie ' +
        `request header from any request in devtools, and store it as ${FIDELITY_COOKIE}.`
    );
  }

  try {
    return await fetchJson<T>(`${HOST}${path}`, {
      ...RATE,
      body,
      headers: {
        accept: 'application/json',
        cookie,
        origin: HOST,
        referer: `${HOST}/ftgw/digital/portfolio/positions`
      },
      method: 'POST'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An expired session is answered with the HTML login page, which fails
    // JSON parsing — so a parse failure here almost always means "log in
    // again", and saying that is more useful than a SyntaxError.
    if (/JSON|Unexpected token|401|403/i.test(message)) {
      throw new Error(
        'Fidelity rejected the session — it has most likely expired. Log in ' +
          `again and refresh ${FIDELITY_COOKIE}. (${message.slice(0, 120)})`,
        { cause: error }
      );
    }
    throw error;
  }
}

/* ---------------------------------------------------------------- accounts */

export interface FidelityAccountRef {
  readonly acctNum: string;
  readonly acctSubType: string;
  readonly acctType: string;
}

interface ContextResponse {
  getContext?: {
    person?: {
      assets?: { acctNum?: string; acctSubType?: string; acctType?: string }[];
    };
  };
}

/** Every Brokerage account on the login. Workplace plans are skipped. */
export async function listAccountRefs(): Promise<FidelityAccountRef[]> {
  const response = await cached(
    'fidelity-context',
    'accounts',
    TTL_SNAPSHOT,
    () => post<ContextResponse>('/ftgw/digital/portfolio/api/GetContext', {})
  );

  return (response.getContext?.person?.assets ?? []).flatMap(asset =>
    asset.acctNum && asset.acctType === 'Brokerage'
      ? [
          {
            acctNum: asset.acctNum,
            acctSubType: asset.acctSubType ?? 'Brokerage',
            acctType: asset.acctType
          }
        ]
      : []
  );
}

/* ---------------------------------------------------------------- balances */

type Num = number | string | undefined;

export interface RawBalanceEntry {
  account?: {
    acctName?: string;
    acctNum?: string;
    acctSubType?: string;
    acctType?: string;
    asOfDateTime?: Num;
    isIra?: boolean;
    legalConstructCode?: string;
    totalAcctMktVal?: Num;
  };
  balance?: {
    brokBalDetail?: {
      availToTradeDetail?: { cashAvailForTrade?: Num };
      availToWithdrawDetail?: { netUnsettledBalance?: Num };
      cashDetail?: { cashSettled?: Num; coreCash?: Num };
    };
  };
}

export interface FidelityBalance {
  readonly acctName: string | undefined;
  readonly acctNum: string;
  /** ISO date, from the snapshot's own timestamp. */
  readonly asOf: string | undefined;
  readonly cashAvailable: Decimal | undefined;
  readonly cashSettled: Decimal | undefined;
  readonly isIra: boolean | undefined;
  readonly legalConstructCode: string | undefined;
  readonly totalValue: Decimal | undefined;
  readonly unsettled: Decimal | undefined;
}

/**
 * Epoch timestamp to ISO date, in whichever unit Fidelity used.
 *
 * Its services mix them: the transaction filter takes seconds, and a
 * millisecond value read as seconds lands in the year 58,000. Anything above
 * 10^12 is milliseconds.
 */
export function epochDate(value: Num): string | undefined {
  const number = typeof value === 'string' ? Number(value) : value;
  if (number === undefined || !Number.isFinite(number) || number <= 0) {
    return undefined;
  }
  const ms = number > 1e12 ? number : number * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseBalance(
  entry: RawBalanceEntry
): FidelityBalance | undefined {
  const account = entry.account;
  if (!account?.acctNum) return undefined;
  const detail = entry.balance?.brokBalDetail;

  return {
    acctName: account.acctName,
    acctNum: account.acctNum,
    asOf: epochDate(account.asOfDateTime),
    cashAvailable: dec(detail?.availToTradeDetail?.cashAvailForTrade),
    cashSettled: dec(detail?.cashDetail?.cashSettled),
    isIra: account.isIra,
    legalConstructCode: account.legalConstructCode,
    totalValue: dec(account.totalAcctMktVal),
    unsettled: dec(detail?.availToWithdrawDetail?.netUnsettledBalance)
  };
}

export async function fetchBalances(
  accounts: readonly FidelityAccountRef[]
): Promise<FidelityBalance[]> {
  if (accounts.length === 0) return [];
  const key = accounts.map(account => account.acctNum).join(',');

  const response = await cached('fidelity-balances', key, TTL_SNAPSHOT, () =>
    post<RawBalanceEntry[]>('/ftgw/digital/balwebex/api/balances', {
      picoString: encodePico(
        accounts.map(account => ({
          account: {
            acctNum: account.acctNum,
            acctSubType: account.acctSubType,
            acctType: account.acctType
          }
        }))
      )
    })
  );

  return (Array.isArray(response) ? response : [])
    .map(parseBalance)
    .filter((balance): balance is FidelityBalance => balance !== undefined);
}

/* --------------------------------------------------------------- positions */

interface Cell {
  disp?: string;
  val?: Num;
}

export interface RawPositionRow {
  actNum?: string;
  cstBasStk?: { top?: Cell };
  curVal?: Cell;
  lstPrStk?: { top?: Cell };
  qty?: Cell;
  rowType?: string;
  sym?: { name?: string };
  totGLStk?: { top?: Cell };
}

export interface FidelityPosition {
  readonly acctNum: string;
  readonly costBasis: Decimal | undefined;
  readonly marketValue: Decimal | undefined;
  readonly price: Decimal;
  readonly quantity: Decimal;
  readonly ticker: string;
  readonly unrealisedGain: Decimal | undefined;
}

/**
 * Security rows out of the positions grid.
 *
 * The grid interleaves four row types — `ACCOUNT` headers, `POSITION` rows,
 * `POSITION_CORE` for the cash sweep, and `ACCOUNT_TOTAL` footers — and only
 * `POSITION` is a holding. Reading every row with a symbol would count the
 * core money-market sweep as a stock and a footer as a security called
 * "Account total".
 *
 * A row missing a quantity or a price is dropped rather than zeroed: an
 * unpriced position cannot be sized against, and a zero would understate the
 * book.
 */
export function parsePositionRows(
  rows: readonly RawPositionRow[]
): FidelityPosition[] {
  return rows.flatMap(row => {
    if (row.rowType !== 'POSITION') return [];
    const ticker = row.sym?.name?.trim().toUpperCase();
    const quantity = dec(row.qty?.val);
    const price = dec(row.lstPrStk?.top?.val);
    if (!ticker || !row.actNum || !quantity || !price) return [];

    return [
      {
        acctNum: row.actNum,
        costBasis: dec(row.cstBasStk?.top?.val),
        marketValue: dec(row.curVal?.val),
        price,
        quantity,
        ticker,
        unrealisedGain: dec(row.totGLStk?.top?.val)
      }
    ];
  });
}

interface PositionsResponse {
  rowData?: RawPositionRow[];
}

export async function fetchPositions(
  account: FidelityAccountRef
): Promise<FidelityPosition[]> {
  const response = await cached(
    'fidelity-positions',
    account.acctNum,
    TTL_SNAPSHOT,
    () =>
      post<PositionsResponse>(
        '/ftgw/digital/positions/poswebex/api/positions',
        {
          accts: [account.acctNum],
          pico: encodePico({
            accounts: [
              {
                accountId: account.acctNum,
                acctSubType: account.acctSubType,
                acctType: account.acctType
              }
            ]
          })
        }
      )
  );

  return parsePositionRows(response.rowData ?? []);
}
