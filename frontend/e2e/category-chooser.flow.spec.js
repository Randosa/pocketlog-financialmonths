// The category chooser that replaced the five category <select>s.
//
// Nothing in the suite covered how a category is *picked* before this file —
// the other specs only assert which categories are on offer. Four behaviours
// carry the design and none of them show up in a screenshot of one state:
//
//   1. The chip row is capped at two rows, with the rest behind the search.
//      Uncapped, a 20-category account turns the field into half the form.
//   2. Ranking follows the form's type, so booking an expense does not lead
//      with the category that only ever carries income.
//   3. A type switch re-picks the *suggested* category but never overrides a
//      category the user tapped.
//   4. A name nobody has yet opens the category modal prefilled and hands the
//      finished category back selected — the dead end this replaced.
//
// The tag chooser learned the same type-awareness, so that is pinned here too.
const { test, expect } = require('@playwright/test');
const {
  loginViaApi,
  bootIntoApp,
  expectNoRawKeys,
  catChipLabels,
  catChooserOffers,
  chooseCategory,
  chosenCategoryId,
} = require('./helpers');

const RUN = Date.now();
// One category booked only as income, one only as expenses. Their ranking
// against each other is the whole point of the type split.
const EARN = `ChooserEarn ${RUN}`;
const SPEND = `ChooserSpend ${RUN}`;
const EARN_TAG = `ChooserEarnTag${RUN}`;
const SPEND_TAG = `ChooserSpendTag${RUN}`;
const FRESH = `ChooserFresh ${RUN}`;

// Seed both sides. The income category gets more bookings than the expense
// one, so ranking by the total alone would put it first on an expense form —
// only a type-aware ranking gets this right.
async function seed(page) {
  return page.evaluate(
    async ([earn, spend, earnTag, spendTag]) => {
      const made = {};
      for (const name of [earn, spend]) {
        const cat = await api('POST', '/categories', { name, icon: 'package', color: '#9e9b96' });
        made[name] = cat.id;
      }
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < 8; i++) {
        await api('POST', '/transactions', {
          amount: '10.00',
          desc: `${earn} ${i}`,
          category_id: made[earn],
          date: today,
          type: 'in',
          tags: [earnTag],
        });
      }
      for (let i = 0; i < 4; i++) {
        await api('POST', '/transactions', {
          amount: '5.00',
          desc: `${spend} ${i}`,
          category_id: made[spend],
          date: today,
          type: 'out',
          tags: [spendTag],
        });
      }
      // Ten more expense-only tags, so the chooser's ten visible slots are
      // genuinely contested and an income-only tag has to earn its way in.
      for (let i = 0; i < 10; i++) {
        await api('POST', '/transactions', {
          amount: '1.00',
          desc: `filler ${spendTag} ${i}`,
          category_id: made[spend],
          date: today,
          type: 'out',
          tags: [`${spendTag}F${i}`],
        });
      }
      await loadCategories();
      await loadTags();
      await loadAndRender();
      return made;
    },
    [EARN, SPEND, EARN_TAG, SPEND_TAG],
  );
}

const chipRowCount = (page) =>
  page.evaluate(() => {
    const tops = new Set(
      [...document.querySelectorAll('#catSuggestions .cat-suggestion')].map((c) => c.offsetTop),
    );
    return tops.size;
  });

const tagChips = (page) => page.evaluate(() => appState.tagChooser.transaction.shown.slice());

test('category chooser: capped rows, type-aware ranking, and create-on-no-match', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);
  await seed(page);

  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);

  // --- 1. Two rows, and the hint accounts for everything not shown ---
  await expect
    .poll(() => chipRowCount(page), { message: 'chip row capped to two rows' })
    .toBeLessThanOrEqual(2);
  const shown = await catChipLabels(page, 'transaction');
  const total = await page.evaluate(() => appState.ledger.categories.length);
  expect(shown.length).toBeLessThan(total);
  await expect(page.locator('#catSuggestionsHint')).toBeVisible();
  await expect(page.locator('#catSuggestionsHint')).toContainText(String(total - shown.length));

  // --- 2. Ranking follows the type. The income category has twice the
  //        bookings of the expense one, so a count-only ranking would put it
  //        ahead on an expense form too — the split is what keeps it back.
  //        Asserted as their order relative to each other: the suite account
  //        is shared, so absolute positions depend on what other specs left. ---
  const rankOf = async (name) => {
    const at = await page.evaluate(
      (n) => appState.catChooser.transaction.shown.findIndex((c) => c.name === n),
      name,
    );
    return at < 0 ? Infinity : at;
  };

  await page.evaluate(() => window.setType('out'));
  await expect.poll(() => rankOf(SPEND)).toBeLessThan(await rankOf(EARN));

  await page.evaluate(() => window.setType('in'));
  await expect.poll(() => rankOf(EARN)).toBeLessThan(await rankOf(SPEND));

  // --- 3. The suggested pick follows the type; a deliberate one does not.
  //        "Follows the ranking" rather than "is category X": which category
  //        tops the list depends on what the shared suite account holds, but
  //        the suggestion must always be whatever the ranking put first. ---
  const topRanked = () =>
    page.evaluate(() => {
      const v = appState.catChooser.transaction;
      return v.shown.length ? v.shown[0].id : null;
    });
  expect(await chosenCategoryId(page, 'transaction')).toBe(await topRanked());

  await chooseCategory(page, 'transaction', SPEND);
  const spendId = await page.evaluate(
    (n) => appState.ledger.categories.find((c) => c.name === n).id,
    SPEND,
  );
  expect(await chosenCategoryId(page, 'transaction')).toBe(spendId);
  await page.evaluate(() => window.setType('out'));
  expect(
    await chosenCategoryId(page, 'transaction'),
    'a tapped category survives a type switch',
  ).toBe(spendId);
  await page.evaluate(() => window.setType('in'));
  expect(
    await chosenCategoryId(page, 'transaction'),
    'and survives switching back, unlike the suggestion it replaced',
  ).toBe(spendId);

  // --- 4. Search reaches past the two visible rows ---
  expect(await catChooserOffers(page, 'transaction', EARN)).toBe(true);

  // --- The tag chooser ranks the same way. It renders its top ten
  //        alphabetically, so the visible *order* says nothing — membership
  //        does. The seed puts ten expense-only tags in the way, so an
  //        income-only tag can only make the cut on an income form; without
  //        those fillers a small account would show every tag and the
  //        assertion would pass for the wrong reason. ---
  await page.evaluate(() => window.setType('out'));
  await expect.poll(() => tagChips(page)).toContain(SPEND_TAG);
  expect(await tagChips(page), 'income-only tag is not suggested on an expense').not.toContain(
    EARN_TAG,
  );
  await page.evaluate(() => window.setType('in'));
  await expect.poll(() => tagChips(page)).toContain(EARN_TAG);

  await expectNoRawKeys(page, 'category chooser');

  // The filler tags exist only to contest the ten visible slots. Leaving a
  // dozen behind on the suite-shared account would silently change what other
  // specs see, so they go again here.
  await page.evaluate(
    async ([spendTag]) => {
      for (let i = 0; i < 10; i++) {
        try {
          await api('DELETE', `/tags/${encodeURIComponent(spendTag + 'F' + i)}`);
        } catch (e) {
          /* already gone */
        }
      }
      await loadTags();
    },
    [SPEND_TAG],
  );

  await page.evaluate(() => window.closeModal({ force: true }));
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('category chooser: a name nobody has opens the category modal and comes back selected', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await page.fill('#inputAmount', '42');

  // No match: the create chip carries the typed name.
  await page.fill('#catSearch', FRESH);
  const createChip = page.locator('#catSuggestions .cat-create');
  await expect(createChip).toHaveCount(1);
  await expect(page.locator('#catSuggestions .cat-suggestion:not(.cat-create)')).toHaveCount(0);

  // Unlike a tag, a category is not created silently: it gets the modal, so
  // its icon and colour are a decision rather than a default that then shows
  // up in every report. The name is carried over, not retyped.
  await createChip.click();
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#catEditName')).toHaveValue(FRESH);

  await page.evaluate(() => window.saveCategoryEdit());
  await expect(page.locator('#catModalOverlay')).not.toHaveClass(/open/);

  // Back in the booking, with the new category selected and the draft intact —
  // that return is the dead end this replaced.
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#catSuggestions .cat-suggestion.is-chosen')).toHaveText(FRESH);
  await expect(page.locator('#inputAmount')).toHaveValue(/42/);
  await expect(page.locator('#catSearch'), 'the query is spent').toHaveValue('');

  // And it saves through.
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  await expect
    .poll(() =>
      page.evaluate((n) => {
        const cat = appState.ledger.categories.find((c) => c.name === n);
        return cat ? appState.ledger.transactions.some((t) => t.category_id === cat.id) : false;
      }, FRESH),
    )
    .toBe(true);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
