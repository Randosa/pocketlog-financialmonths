// The drawer's two management lists — categories and tags.
//
// Nothing in the suite touched the drawer before this file. Two behaviours
// worth pinning live here:
//
//   1. The filter field is conditional. It costs a full row of a 300px panel,
//      so it appears only above DRAWER_FILTER_MIN entries and goes away again
//      when the list shrinks back under it. A threshold that silently drifts
//      would either clutter every short list or strand a long one, and neither
//      shows up in a screenshot of the state you happen to be in.
//   2. The tag rows are operable by keyboard. They were pointer-only while the
//      category rows beside them were not, and the CSS had focus states that
//      could never fire.
//
// Also covered: filtering narrows the list, and a query that matches nothing
// says so with different copy than an account that has nothing yet.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys } = require('./helpers');

const RUN = Date.now();
// Comfortably over the threshold on its own, so the count does not depend on
// what other specs left behind.
const TAGS = Array.from({ length: 14 }, (_, i) => `DrawerTag${RUN}_${String(i).padStart(2, '0')}`);
const ODD = `DrawerOdd${RUN}`;

const openTagPanel = async (page) => {
  await page.evaluate(() => window.openDrawer && window.openDrawer());
  await page.evaluate(() => window.drawerNav('dpTags'));
  await expect(page.locator('#dpTags')).toBeVisible();
};

const rowCount = (page) => page.locator('#tagList .cat-pill-edit').count();

// Distance from the "create" button to whatever follows it. The list is not
// the button's adjacent sibling any more — the filter field sits between them
// — so the gap comes from a different rule in each state and zero in one of
// them is a real regression, not a cosmetic one.
const gapBelowCreateButton = (page) =>
  page.evaluate(() => {
    const btn = document.querySelector('#dpTags .save-btn');
    const wrap = document.getElementById('dpTagSearchWrap');
    const next = wrap.hidden ? document.getElementById('tagList') : wrap;
    return next.getBoundingClientRect().top - btn.getBoundingClientRect().bottom;
  });

test('drawer tag list: filter appears with the list, and rows work by keyboard', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // Start from a known set: whatever this account already has, plus enough of
  // our own to clear the threshold.
  await page.evaluate(
    async (names) => {
      for (const name of names) {
        try {
          await api('POST', '/tags', { name });
        } catch (e) {
          /* a rerun against the same instance already has it */
        }
      }
      await loadTags();
    },
    [...TAGS, ODD],
  );

  await openTagPanel(page);
  await expect(page.locator('#dpTagSearchWrap')).toBeVisible();
  expect(await gapBelowCreateButton(page), 'gap with the field shown').toBeGreaterThan(0);
  const total = await rowCount(page);
  expect(total).toBeGreaterThan(10);

  // Filtering narrows to the one row that matches.
  await page.fill('#dpTagSearch', ODD.toLowerCase());
  await expect(page.locator('#tagList .cat-pill-edit')).toHaveCount(1);
  await expect(page.locator('#tagList .cat-pill-edit')).toHaveText(ODD);

  // A miss reads as a miss, not as an empty account.
  await page.fill('#dpTagSearch', `${ODD}-nothing-matches-this`);
  await expect(page.locator('#tagList .cat-pill-edit')).toHaveCount(0);
  await expect(page.locator('#tagList')).toHaveText(/gefunden|found/i);

  await page.fill('#dpTagSearch', '');
  await expect(page.locator('#tagList .cat-pill-edit')).toHaveCount(total);

  await expectNoRawKeys(page, 'drawer tag panel');

  // The row takes focus and Enter opens the rename modal on it — it was a bare
  // div with a click listener before.
  const first = page.locator('#tagList .cat-pill-edit').first();
  const name = (await first.textContent()).trim();
  await first.focus();
  await expect(first).toBeFocused();
  await first.press('Enter');
  await expect(page.locator('#tagModalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#tagEditName')).toHaveValue(name);
  await page.evaluate(() => closeTagModal());
  await expect(page.locator('#tagModalOverlay')).not.toHaveClass(/open/);

  // Back under the threshold the field goes away, and it must not leave a
  // filter running behind it with no control left to clear.
  await page.evaluate(async (names) => {
    for (const n of names) {
      try {
        await api('DELETE', `/tags/${encodeURIComponent(n)}`);
      } catch (e) {
        /* already gone */
      }
    }
    await loadTags();
  }, TAGS);
  await openTagPanel(page);
  // The account is shared with the other specs, so "our tags are gone" does
  // not guarantee the list dropped under the threshold. Assert the rule the
  // field actually follows — visible exactly while the list is long enough —
  // rather than a count this spec cannot own.
  const remaining = await rowCount(page);
  const overThreshold = remaining > 10;
  await expect(page.locator('#dpTagSearchWrap'))[overThreshold ? 'toBeVisible' : 'toBeHidden']();
  if (!overThreshold) {
    expect(await page.evaluate(() => appState.drawer.filter.tags)).toBe('');
  }
  // The list must not butt against the button — with the field hidden it
  // contributes no margin of its own, which is the case that regressed.
  expect(await gapBelowCreateButton(page), 'gap below the create button').toBeGreaterThan(0);

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});
