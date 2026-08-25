// Savings-goal lifecycle against a running PocketLog build.
//
// Pins the 1:1 category↔goal contract end-to-end: progress is derived from
// the linked category's bookings (never stored), a category that already
// carries a goal is no longer offered when creating the next one (the 409
// itself lives in the backend suite), the category cannot be deleted while the
// goal references it, and deleting the goal leaves the bookings untouched.
const { test, expect } = require('@playwright/test');
const {
  loginViaApi,
  bootIntoApp,
  expectNoRawKeys,
  gotoPanel,
  catChooserOffers,
  chooseCategory,
  chosenCategoryId,
} = require('./helpers');

const RUN = Date.now();
const CAT = `FlowGoalCat ${RUN}`;
const GOAL = `FlowGoal ${RUN}`;
const TX_DESC = `FlowGoalTx ${RUN}`;

test('goal progress, category conflicts and delete protection', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // --- A dedicated category, so the progress math sees only this run ---
  await page.evaluate(() => window.openCatModal());
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await page.fill('#catEditName', CAT);
  await page.evaluate(() => window.saveCategoryEdit());
  await expect(page.locator('#catModalOverlay')).not.toHaveClass(/open/);

  // --- Goal on that category: save up to 500 starting today ---
  await page.evaluate(() => window.openGoalModal());
  await expect(page.locator('#goalModalOverlay')).toHaveClass(/open/);
  await page.fill('#goalEditName', GOAL);
  await chooseCategory(page, 'goal', CAT);
  await page.fill('#goalEditInitial', '0');
  await page.fill('#goalEditTarget', '500');
  await page.evaluate(() => window.saveGoalEdit());
  await expect(page.locator('#goalModalOverlay')).not.toHaveClass(/open/);

  await gotoPanel(page, 'goals');
  const card = page.locator('#goalsViewList .goal-card', { hasText: GOAL });
  await expect(card).toBeVisible();
  await expectNoRawKeys(page, 'goals view');

  // --- An income booking in the category drives the derived progress:
  //     100 of 500 → the card shows 20 % ---
  await gotoPanel(page, 'transactions');
  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await page.evaluate(() => window.setType('in'));
  await page.fill('#inputAmount', '100');
  await page.fill('#inputDesc', TX_DESC);
  await chooseCategory(page, 'transaction', CAT);
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  await gotoPanel(page, 'goals');
  await expect(card).toContainText('20');

  // --- 1:1 contract, enforced before the user can act on it: a fresh create
  //     picker no longer lists the category that already carries a goal, so
  //     the twin cannot be built in the first place. The 409 behind it stays
  //     pinned in the backend suite (test_goals.py); the category turning up
  //     here again would mean the picker went back to offering an option that
  //     can only fail on Save. ---
  await page.evaluate(() => window.openGoalModal());
  await expect(page.locator('#goalModalOverlay')).toHaveClass(/open/);
  expect(await catChooserOffers(page, 'goal', CAT)).toBe(false);
  // The name follows the picker while it is still the form's own suggestion.
  await expect(page.locator('#goalEditName')).toHaveValue(
    await page.evaluate(
      () =>
        appState.ledger.categories.find((c) => c.id === appState.catChooser.goal.selectedId).name,
    ),
  );
  // …and it arrives selected, so it is a starting point rather than something
  // the user has to clear first. The shell focuses on a timer, hence the poll.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const f = document.getElementById('goalEditName');
        return f.value.slice(f.selectionStart, f.selectionEnd);
      }),
    )
    .toBe(await page.evaluate(() => document.getElementById('goalEditName').value));
  await page.evaluate(() => window.closeGoalModal());

  // --- …while editing that same goal keeps its own category listed and
  //     selected, and leaves the name the user gave it alone. ---
  await page.evaluate((name) => {
    const goal = appState.goals.list.find((g) => g.name === name);
    window.openGoalModal(goal.id);
  }, GOAL);
  await expect(page.locator('#goalModalOverlay')).toHaveClass(/open/);
  expect(await catChooserOffers(page, 'goal', CAT)).toBe(true);
  await expect(page.locator('#goalEditName')).toHaveValue(GOAL);
  await page.evaluate(() => window.closeGoalModal());

  // --- Delete protection: the category is blocked while the goal (and the
  //     booking) reference it ---
  await page.evaluate((name) => {
    const cat = appState.ledger.categories.find((c) => c.name === name);
    window.openCatModal(cat.id);
  }, CAT);
  await expect(page.locator('#catModalOverlay')).toHaveClass(/open/);
  await page.click('#catDeleteBtn');
  await page.click('.confirm-yes');
  await expect(page.locator('#toastHost .toast.error').last()).toBeVisible();
  await page.evaluate(() => window.closeCatModal());
  await expect
    .poll(() =>
      page.evaluate((name) => appState.ledger.categories.some((c) => c.name === name), CAT),
    )
    .toBe(true);

  // --- Deleting the goal keeps the bookings ---
  await page.evaluate((name) => {
    const goal = appState.goals.list.find((g) => g.name === name);
    window.openGoalModal(goal.id);
  }, GOAL);
  await expect(page.locator('#goalModalOverlay')).toHaveClass(/open/);
  await page.click('#goalDeleteBtn');
  await page.click('.confirm-yes');
  await expect(page.locator('#goalModalOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#goalsViewList .goal-card', { hasText: GOAL })).toHaveCount(0);

  await page.evaluate((q) => window.onSearch(q), TX_DESC.toLowerCase());
  await expect(page.locator('#searchResultsList')).toContainText(TX_DESC);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
