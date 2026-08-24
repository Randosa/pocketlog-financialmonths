// Inline tag chooser in the booking form and the recurring-rule editor.
//
// Both forms used to hold a pill field plus a "+" that opened the tag picker
// modal. That is gone: the search field over the chip row *is* the selection
// now, and the picker is left to the ledger's bulk actions. Nothing else in
// the suite touches this — the smoke spec's only tag interaction is the
// settings rename modal — so without this file the app's primary way of
// attaching a tag to a booking has no coverage at all.
//
// Covered in sequence:
//   1. Overview: chips render, tapping one marks it (aria-pressed) instead of
//      writing a pill somewhere else, so a tag is never shown twice.
//   2. The marked chip keeps its slot — the row must not reflow under a
//      finger mid-tap (the bug that made the *next* tag look selected).
//   3. Tapping it again takes the tag off; with no pills that is the only way.
//   4. Search runs over every tag, not just the frequent ones on display.
//   5. A query that matches nothing offers to create it; the new tag lands
//      selected and the field clears.
//   6. The tag actually reaches the API on save.
//   7. Editing that booking shows its tags marked, including one that is not
//      among the frequent ones.
//   8. The recurring editor has the same field and row.
//   9. The ledger's bulk picker — the one place the tag modal is still
//      reachable — works the same way, and its staged selection reaches the
//      marked rows on „Ubernehmen".
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, expectNoRawKeys } = require('./helpers');

const RUN = Date.now();
// Deliberately unlikely to collide with the seeded tags, and unlikely to be
// among the ten most-used — that is what makes step 7 meaningful.
const FRESH = `FlowChooser${RUN}`;
const TX_DESC = `FlowChooserTx ${RUN}`;

const chipTexts = (page) =>
  page.$$eval('#tagSuggestions .tag-suggestion', (els) => els.map((e) => e.textContent.trim()));

test('booking form: chips are the selection, search reaches every tag, create works', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // Two tags that exist but are not attached to anything, so the chooser has
  // something to find and the counts stay at zero.
  await page.evaluate(async () => {
    for (const name of ['ChooserAlpha', 'ChooserBeta']) {
      await api('POST', '/tags', { name });
    }
    await loadTags();
  });

  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#tagSearch')).toBeVisible();
  // The pill field and its "+" are gone; the row carries the state instead.
  await expect(page.locator('#tagsWrap')).toHaveCount(0);
  await expect(page.locator('#tagPickerBtn')).toHaveCount(0);

  const chips = page.locator('#tagSuggestions .tag-suggestion');
  await expect(chips.first()).toBeVisible();
  const before = await chipTexts(page);
  expect(before.length).toBeGreaterThan(0);

  // 1 + 2: marking a chip flips its state and leaves the row order alone.
  const target = chips.nth(1);
  const targetName = (await target.textContent()).trim();
  await expect(target).toHaveAttribute('aria-pressed', 'false');
  await target.click();
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  expect(await chipTexts(page)).toEqual(before);
  expect(await page.evaluate(() => appState.form.tags)).toEqual([targetName]);

  // 3: the same chip takes it off again.
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => appState.form.tags)).toEqual([]);

  // 4: search finds a tag regardless of whether it was on display.
  await page.fill('#tagSearch', 'chooserb');
  await expect(
    page.locator('#tagSuggestions .tag-suggestion', { hasText: 'ChooserBeta' }),
  ).toHaveCount(1);
  await page.locator('#tagSuggestions .tag-suggestion', { hasText: 'ChooserBeta' }).click();
  expect(await page.evaluate(() => appState.form.tags)).toEqual(['ChooserBeta']);

  // 5: no match at all -> create, which selects it and clears the field.
  await page.fill('#tagSearch', FRESH);
  const createChip = page.locator('#tagSuggestions .tag-create');
  await expect(createChip).toHaveCount(1);
  await createChip.click();
  await expect(page.locator('#tagSearch')).toHaveValue('');
  expect(await page.evaluate(() => appState.form.tags)).toEqual(['ChooserBeta', FRESH]);
  // Back in overview both selected tags lead the row.
  expect((await chipTexts(page)).slice(0, 2)).toEqual(['ChooserBeta', FRESH]);

  await expectNoRawKeys(page, 'booking form with tag chooser');

  // 6: the tags survive the save.
  await page.fill('#inputAmount', '3,50');
  await page.fill('#inputDesc', TX_DESC);
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  const row = page.locator('#transactionList .tx-row', { hasText: TX_DESC });
  await expect(row).toBeVisible();
  const saved = await page.evaluate(async (desc) => {
    const all = await api('GET', '/transactions');
    return all.find((t) => t.desc === desc)?.tags ?? null;
  }, TX_DESC);
  expect(saved).not.toBeNull();
  expect([...saved].sort()).toEqual(['ChooserBeta', FRESH].sort());

  // 7: reopening shows them marked even though neither is a frequent tag.
  const id = await row.getAttribute('data-id');
  await page.evaluate((txId) => window.editTransaction(Number(txId)), id);
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  const marked = await page.$$eval('#tagSuggestions .tag-suggestion[aria-pressed="true"]', (els) =>
    els.map((e) => e.textContent.trim()).sort(),
  );
  expect(marked).toEqual(['ChooserBeta', FRESH].sort());

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});

test('recurring rule editor uses the same chooser', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // Its own tag: workers share the instance, so this test must not depend on
  // another one having populated the row first.
  const recTag = `RecChooser${RUN}`;
  await page.evaluate(async (name) => {
    try {
      await api('POST', '/tags', { name });
    } catch (e) {
      /* a rerun against the same instance already has it */
    }
    await loadTags();
  }, recTag);

  await page.evaluate(() => window.openRecurringModal());
  await expect(page.locator('#recurringModalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#recTagSearch')).toBeVisible();
  // Same replacement as the booking form: no pill field, no picker button.
  await expect(page.locator('#recTagsWrap')).toHaveCount(0);
  await expect(page.locator('#recTagPickerBtn')).toHaveCount(0);

  const recChips = page.locator('#recTagSuggestions .tag-suggestion');
  await expect(recChips.first()).toBeVisible();
  await recChips.first().click();
  const picked = (await recChips.first().textContent()).trim();
  await expect(recChips.first()).toHaveAttribute('aria-pressed', 'true');
  // The rule's selection lives with the rule, not in the picker's state.
  expect(await page.evaluate(() => appState.recurring.tags)).toEqual([picked]);

  await expectNoRawKeys(page, 'recurring editor with tag chooser');
  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});

test('bulk picker: same one-field chooser, staged selection reaches the marked rows', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  const desc = `FlowBulkTag ${RUN}`;
  const made = `BulkChooser${RUN}`;
  const id = await page.evaluate(async (d) => {
    const cats = await api('GET', '/categories');
    const tx = await api('POST', '/transactions', {
      amount: 4.2,
      desc: d,
      category_id: cats[0].id,
      date: new Date().toISOString().slice(0, 10),
      type: 'out',
    });
    await loadAndRender();
    return tx.id;
  }, desc);

  // The long-press gesture is the ledger's own and unchanged here; what this
  // covers is the selection bar's button and everything behind it.
  await page.evaluate((txId) => {
    enterSelectionMode();
    toggleSelect(Number(txId));
  }, id);
  await page.click('[data-action="openBulkAddTags"]');
  await expect(page.locator('#tagPickerOverlay')).toHaveClass(/open/);

  // The separate "Neuer Tag" row with its "+" is gone; one field does both.
  await expect(page.locator('#tagPickerNew')).toHaveCount(0);
  await expect(page.locator('.tag-create-row')).toHaveCount(0);
  await expect(page.locator('#tagPickerFilter')).toBeVisible();

  // A name nobody has yet gets the create chip, and creating selects it.
  await page.fill('#tagPickerFilter', made);
  const createChip = page.locator('#tagPickerChips .tag-create');
  await expect(createChip).toHaveCount(1);
  await createChip.click();
  await expect(page.locator('#tagPickerFilter')).toHaveValue('');
  expect(await page.evaluate(() => appState.tagPicker.selection)).toEqual([made]);
  // Selection is the chip's accent state here too, not a list somewhere else.
  await expect(
    page.locator('#tagPickerChips .tag-picker-chip.selected', { hasText: made }),
  ).toHaveCount(1);

  await expectNoRawKeys(page, 'bulk tag picker');

  await page.click('[data-action="commitTagPicker"]');
  await expect(page.locator('#tagPickerOverlay')).not.toHaveClass(/open/);

  await expect
    .poll(async () =>
      page.evaluate(async (txId) => {
        const all = await api('GET', '/transactions');
        return all.find((t) => t.id === Number(txId))?.tags ?? [];
      }, id),
    )
    .toEqual([made]);

  // Remove mode offers only what is actually on the marked rows, and never
  // the create chip — removing cannot invent a tag.
  await page.evaluate((txId) => {
    enterSelectionMode();
    toggleSelect(Number(txId));
  }, id);
  await page.click('[data-action="openBulkRemoveTags"]');
  await expect(page.locator('#tagPickerOverlay')).toHaveClass(/open/);
  expect(
    await page.$$eval('#tagPickerChips .tag-picker-chip', (els) =>
      els.map((e) => e.textContent.trim()),
    ),
  ).toEqual([made]);
  await page.fill('#tagPickerFilter', `${made}XYZ`);
  await expect(page.locator('#tagPickerChips .tag-create')).toHaveCount(0);
  await expect(page.locator('#tagPickerHint')).toBeVisible();

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});
