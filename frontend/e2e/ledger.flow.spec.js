// Ledger-level behaviour: the month you are looking at and the booking you add
// to it. Nothing in the suite drove the month navigation before this file.
//
// The regression it pins: a new booking's date used to default to *today*
// regardless of the month on screen. Browsing back to add something you forgot
// therefore filed it under today, the list reloaded the month you were still
// looking at, and the app reported "saved" while nothing appeared.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, chooseCategory } = require('./helpers');

const RUN = Date.now();
const BACKFILL = `FlowBackfill ${RUN}`;
const TODAY_DESC = `FlowToday ${RUN}`;

const monthLabel = (page) => page.locator('#monthLabelText').innerText();
const viewedMonth = (page) =>
  page.evaluate(() => ({ y: appState.view.year, m: appState.view.month }));

test('a booking added while browsing an earlier month lands in that month', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // --- Adding to the current month still dates itself today ---
  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  const today = await page.evaluate(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  await expect(page.locator('#inputDate')).toHaveValue(today);
  await page.fill('#inputAmount', '7');
  await page.fill('#inputDesc', TODAY_DESC);
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#transactionList')).toContainText(TODAY_DESC);

  // --- Two months back, and the form follows the view ---
  await page.evaluate(() => window.changeMonth(-1));
  await page.evaluate(() => window.changeMonth(-1));
  await expect
    .poll(() => viewedMonth(page))
    .toEqual(
      await page.evaluate(() => {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - 2);
        return { y: d.getFullYear(), m: d.getMonth() };
      }),
    );
  const label = await monthLabel(page);

  await page.click('.fab');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  const dateValue = await page.inputValue('#inputDate');
  const { y, m } = await viewedMonth(page);
  expect(
    dateValue.startsWith(`${y}-${String(m + 1).padStart(2, '0')}-`),
    `date ${dateValue} must fall inside the month on screen (${label})`,
  ).toBe(true);

  // --- …and the saved booking is visible in the month that reported it ---
  await page.fill('#inputAmount', '13,37');
  await page.fill('#inputDesc', BACKFILL);
  await chooseCategory(
    page,
    'transaction',
    await page.evaluate(() => appState.ledger.categories[0].name),
  );
  await page.click('#submitBtn');
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  expect(await monthLabel(page), 'saving does not navigate away').toBe(label);
  await expect(
    page.locator('#transactionList'),
    'the booking appears in the month that just reported it saved',
  ).toContainText(BACKFILL);

  // The one from the current month is elsewhere, not lost — the two really
  // did land in different months.
  await expect(page.locator('#transactionList')).not.toContainText(TODAY_DESC);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
