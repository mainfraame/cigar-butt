import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONCEPTS, type FrameEntry } from '../data/sec.ts';
import { dec } from '../math/decimal.ts';

const frames = new Map<string, FrameEntry[]>();

vi.mock('../data/sec.ts', async importOriginal => {
  const actual = await importOriginal<typeof SecModule>();
  return {
    ...actual,
    frame: (concept: string) => Promise.resolve(frames.get(concept) ?? [])
  };
});

const { screenMarket } = await import('./screen.ts');

import type * as SecModule from '../data/sec.ts';

interface Filer {
  assetsCurrent: number;
  cik: number;
  goodwill?: number;
  intangibles?: number;
  liabilities: number;
  name: string;
  stockholdersEquity: number;
}

function load(...filers: Filer[]): void {
  frames.clear();
  const put = (concept: string, pick: (filer: Filer) => number | undefined) => {
    frames.set(
      concept,
      filers.flatMap(filer => {
        const val = pick(filer);
        return val === undefined
          ? []
          : [
              { cik: filer.cik, end: '2026-03-31', entityName: filer.name, val }
            ];
      })
    );
  };

  put(CONCEPTS.stockholdersEquity, filer => filer.stockholdersEquity);
  put(CONCEPTS.assetsCurrent, filer => filer.assetsCurrent);
  put(CONCEPTS.liabilities, filer => filer.liabilities);
  put(CONCEPTS.goodwill, filer => filer.goodwill);
  put(CONCEPTS.intangibles, filer => filer.intangibles);
}

const screen = () =>
  screenMarket({
    minNcavRatio: dec(0),
    minTangibleBook: dec(0),
    period: 'CY2026Q1I'
  });

beforeEach(() => {
  frames.clear();
});

describe('price-ranked screen', () => {
  it('ranks by balance-sheet shape when no price is joined', async () => {
    // All an unpriced screen can honestly rank on — and the reason every
    // candidate off it was a company whose balance sheet is only cash.
    load(
      {
        assetsCurrent: 300,
        cik: 1,
        liabilities: 110,
        name: 'Cash Shell',
        stockholdersEquity: 200
      },
      {
        assetsCurrent: 150,
        cik: 2,
        liabilities: 110,
        name: 'Operating Co',
        stockholdersEquity: 400
      }
    );

    const { rows } = await screen();

    expect(rows[0]?.entityName).toBe('Cash Shell');
  });
});

describe('inconsistent basis', () => {
  it('flags a row whose NCAV exceeds tangible book', async () => {
    // Impossible on one balance sheet: NCAV is equity less non-current
    // assets, tangible book is equity less goodwill and intangibles, and
    // those *are* non-current assets. Above 100% the two figures came from
    // different bases — almost always a non-controlling interest, where
    // StockholdersEquity is the parent's share alone while the assets and
    // liabilities are the whole consolidated group.
    load({
      assetsCurrent: 300,
      cik: 1,
      liabilities: 110,
      name: 'Up-C Inc.',
      stockholdersEquity: 66
    });

    const { rows } = await screen();

    expect(rows[0]?.basisInconsistent).toBe(true);
  });

  it('leaves an ordinary balance sheet unflagged', async () => {
    load({
      assetsCurrent: 300,
      cik: 1,
      liabilities: 110,
      name: 'Ordinary Inc.',
      stockholdersEquity: 400
    });

    const { rows } = await screen();

    expect(rows[0]?.basisInconsistent).toBe(false);
  });

  it('ranks an artifact below every measured ratio', async () => {
    // The artifact ratio is large by construction, so left alone it takes the
    // top of the page — exactly where the reader's attention goes.
    load(
      {
        assetsCurrent: 300,
        cik: 1,
        liabilities: 110,
        name: 'Up-C Inc.',
        stockholdersEquity: 66
      },
      {
        assetsCurrent: 300,
        cik: 2,
        liabilities: 110,
        name: 'Ordinary Inc.',
        stockholdersEquity: 250
      }
    );

    const { rows } = await screen();

    expect(rows.map(row => row.entityName)).toEqual([
      'Ordinary Inc.',
      'Up-C Inc.'
    ]);
  });

  it('drops a filer with no NCAV rather than flagging it', async () => {
    // A filer that never tagged Liabilities has no NCAV. That is a gap in the
    // evidence, not an inconsistency and not a zero — and a screen ranked by
    // a ratio cannot place a row that has none. `universeSize` still counts
    // it, so the gap between the two numbers stays visible.
    load({
      assetsCurrent: 300,
      cik: 1,
      liabilities: 0,
      name: 'Untagged Inc.',
      stockholdersEquity: 400
    });
    frames.set(CONCEPTS.liabilities, []);

    const { rows, universeSize } = await screen();

    expect(rows).toHaveLength(0);
    expect(universeSize).toBe(1);
  });
});
