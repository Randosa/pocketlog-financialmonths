// Unit tests for _applyTxLocally (booking.js): the optimistic in-memory update
// that makes an offline create/edit show up immediately, before the service
// worker replays the queued write. Pins the regression where an offline edit
// looked reverted because the list was reloaded from the stale API cache.
//
// booking.js is a classic feature-module script that only declares functions at
// the top level (nothing runs at load), so — like sw.test.js does for sw.js —
// we evaluate it in a vm context and reach _applyTxLocally directly. Every other
// global it names (document, api, toast, …) is only touched inside functions we
// never call here, so a minimal `appState` sandbox is enough.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const BOOKING_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'booking.js');

function loadApplyTxLocally(appState) {
  const src = readFileSync(BOOKING_PATH, 'utf8') + '\n;globalThis.__exports = { _applyTxLocally };';
  const sandbox = { appState };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__exports._applyTxLocally;
}

function makeState() {
  return {
    view: { year: 2026, month: 5 }, // month is 0-based → June
    ledger: {
      transactions: [
        { id: 1, amount: 10, desc: 'a', category_id: 2, date: '2026-06-10', type: 'out', tags: [] },
        { id: 2, amount: 20, desc: 'b', category_id: 3, date: '2026-06-11', type: 'in', tags: [] },
      ],
      all: [
        { id: 1, amount: 10, desc: 'a', category_id: 2, date: '2026-06-10', type: 'out', tags: [] },
        { id: 2, amount: 20, desc: 'b', category_id: 3, date: '2026-06-11', type: 'in', tags: [] },
      ],
    },
  };
}

describe('_applyTxLocally', () => {
  let appState, applyTxLocally;
  beforeEach(() => {
    appState = makeState();
    applyTxLocally = loadApplyTxLocally(appState);
  });

  describe('PUT (edit)', () => {
    it('updates the matching transaction in both pools and leaves others alone', () => {
      applyTxLocally('PUT', '1', {
        amount: 25.99,
        desc: 'changed',
        category_id: 7,
        date: '2026-06-10',
        type: 'out',
        tags: ['x'],
      });
      for (const pool of [appState.ledger.transactions, appState.ledger.all]) {
        const t = pool.find((x) => x.id === 1);
        expect(t.amount).toBe(25.99);
        expect(t.desc).toBe('changed');
        expect(t.category_id).toBe(7);
        expect(t.tags).toEqual(['x']);
        // untouched row stays as it was
        expect(pool.find((x) => x.id === 2).amount).toBe(20);
      }
    });

    it('coerces the amount to a Number', () => {
      applyTxLocally('PUT', '1', {
        amount: '12.50',
        desc: 'a',
        category_id: 2,
        date: '2026-06-10',
        type: 'out',
        tags: [],
      });
      expect(appState.ledger.transactions[0].amount).toBe(12.5);
    });

    it('copies the tags array so later mutation of the body does not leak in', () => {
      const tags = ['groceries'];
      applyTxLocally('PUT', '1', {
        amount: 10,
        desc: 'a',
        category_id: 2,
        date: '2026-06-10',
        type: 'out',
        tags,
      });
      tags.push('leaked');
      expect(appState.ledger.transactions[0].tags).toEqual(['groceries']);
    });

    it('is a no-op when no pool holds the id', () => {
      applyTxLocally('PUT', '999', {
        amount: 1,
        desc: 'x',
        category_id: 1,
        date: '2026-06-10',
        type: 'out',
        tags: [],
      });
      expect(appState.ledger.transactions).toHaveLength(2);
      expect(appState.ledger.all).toHaveLength(2);
    });

    it('tolerates a null `all` pool', () => {
      appState.ledger.all = null;
      expect(() =>
        applyTxLocally('PUT', '1', {
          amount: 5,
          desc: 'a',
          category_id: 2,
          date: '2026-06-10',
          type: 'out',
          tags: [],
        }),
      ).not.toThrow();
      expect(appState.ledger.transactions[0].amount).toBe(5);
    });
  });

  describe('POST (create)', () => {
    it('inserts a provisional row into the month pool when the date is in view', () => {
      applyTxLocally('POST', '', {
        amount: 9.5,
        desc: 'new',
        category_id: 4,
        date: '2026-06-15',
        type: 'out',
        tags: ['t'],
      });
      expect(appState.ledger.transactions).toHaveLength(3);
      const tx = appState.ledger.transactions[2];
      expect(tx.amount).toBe(9.5);
      expect(tx.desc).toBe('new');
      expect(tx.id).toBeLessThan(0); // provisional, distinct from real rows
      expect(tx.source_rule_id).toBeNull();
      // also lands in the global pool
      expect(appState.ledger.all).toHaveLength(3);
    });

    it('skips the month pool when the date is outside the displayed month', () => {
      applyTxLocally('POST', '', {
        amount: 3,
        desc: 'july',
        category_id: 4,
        date: '2026-07-01',
        type: 'out',
        tags: [],
      });
      // not shown in the month list…
      expect(appState.ledger.transactions).toHaveLength(2);
      // …but still queued/visible in the global pool
      expect(appState.ledger.all).toHaveLength(3);
    });

    it('tolerates a null `all` pool', () => {
      appState.ledger.all = null;
      expect(() =>
        applyTxLocally('POST', '', {
          amount: 1,
          desc: 'x',
          category_id: 1,
          date: '2026-06-02',
          type: 'out',
          tags: [],
        }),
      ).not.toThrow();
      expect(appState.ledger.transactions).toHaveLength(3);
    });
  });
});

// _populateCategorySelect fills every category <select> in the app. The
// `takenIds` argument is what keeps the goal and budget pickers from offering
// a category that is already spoken for — both are 1:1 with a category, so an
// occupied option can only ever end in a 409 after the user hits Save.
function loadPopulateCategorySelect(appState) {
  const src =
    readFileSync(BOOKING_PATH, 'utf8') + '\n;globalThis.__exports = { _populateCategorySelect };';
  const sandbox = {
    appState,
    _locale: () => 'de-DE',
    _escText: (s) => s,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__exports._populateCategorySelect;
}

describe('_populateCategorySelect', () => {
  const CATS = [
    { id: 1, name: 'Wohnen' },
    { id: 2, name: 'Auto' },
    { id: 3, name: 'Freizeit' },
  ];
  let sel, populate;

  // Parse the rendered markup back into {id, selected} pairs so the
  // assertions read as list contents rather than as HTML.
  const options = () =>
    [...sel.innerHTML.matchAll(/<option value="(\d+)"( selected)?>([^<]*)<\/option>/g)].map(
      (m) => ({ id: Number(m[1]), selected: !!m[2], name: m[3] }),
    );

  beforeEach(() => {
    sel = { innerHTML: '' };
    populate = loadPopulateCategorySelect({ ledger: { categories: CATS } });
  });

  it('lists every category, sorted by name, without a filter', () => {
    populate(sel, null);
    expect(options().map((o) => o.name)).toEqual(['Auto', 'Freizeit', 'Wohnen']);
  });

  it('preselects the alphabetically first option when nothing is requested', () => {
    populate(sel, null);
    expect(
      options()
        .filter((o) => o.selected)
        .map((o) => o.name),
    ).toEqual(['Auto']);
  });

  it('drops the categories in takenIds', () => {
    populate(sel, null, new Set([2]));
    expect(options().map((o) => o.name)).toEqual(['Freizeit', 'Wohnen']);
  });

  it('keeps the selected category listed even when it is taken', () => {
    // The edit case: the goal being edited occupies its own category.
    populate(sel, 2, new Set([1, 2]));
    expect(options().map((o) => o.name)).toEqual(['Auto', 'Freizeit']);
    expect(
      options()
        .filter((o) => o.selected)
        .map((o) => o.id),
    ).toEqual([2]);
  });

  it('falls back to the first free option when the requested one is taken', () => {
    populate(sel, 1, new Set([1]));
    // id 1 stays listed (it is the selectedId) — the fallback only kicks in
    // when the requested id is filtered out entirely.
    expect(
      options()
        .filter((o) => o.selected)
        .map((o) => o.id),
    ).toEqual([1]);
    populate(sel, 99, new Set([2]));
    expect(
      options()
        .filter((o) => o.selected)
        .map((o) => o.name),
    ).toEqual(['Freizeit']);
  });

  it('renders an empty list when every category is taken', () => {
    populate(sel, null, new Set([1, 2, 3]));
    expect(options()).toEqual([]);
  });
});
