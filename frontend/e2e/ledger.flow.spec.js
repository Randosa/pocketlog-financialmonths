// Ledger-level behaviour: the month you are looking at and the booking you add
// to it. Nothing in the suite drove the month navigation before this file.
//
// The regression it pins: a new booking's date used to default to *today*
// regardless of the month on screen. Browsing back to add something you forgot
// therefore filed it under today, the list reloaded the month you were still
// looking at, and the app reported "saved" while nothing appeared.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp, chooseCategory } = require('./helpers');

const TAB_WALK = 60;

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

// Walk the real tab order: the browser knows about `inert` and
// `visibility: hidden`, a querySelectorAll does not.
async function tabWalk(page, presses) {
  await page.evaluate(() => document.body.focus());
  const stops = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab');
    stops.push(
      await page.evaluate(() => {
        const a = document.activeElement;
        const r = a.getBoundingClientRect();
        return {
          cls: (a.className || '').toString(),
          inDrawer: !!a.closest('#drawer'),
          offscreen: r.right <= 0 || r.left >= window.innerWidth,
        };
      }),
    );
  }
  return stops;
}

test('the ledger is reachable by keyboard, and only its safe actions are', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);
  await expect(page.locator('#transactionList .tx-row').first()).toBeVisible();

  const stops = await tabWalk(page, TAB_WALK);

  // 1. The closed drawer is pushed off-screen, not hidden — its ~70 controls
  //    used to come first in the tab order, so reaching the ledger meant
  //    walking an invisible menu.
  expect(stops.filter((s) => s.inDrawer).length, 'no tab stop inside the closed drawer').toBe(0);
  expect(stops.filter((s) => s.offscreen).length, 'no tab stop off-screen').toBe(0);

  // 2. The swipe-to-delete button stays out of reach until the swipe reveals
  //    it. It is already `visibility: hidden` at rest — for a visual reason
  //    (a red sliver bleeding past the card's rounded corner), which happens
  //    to keep it out of the tab order too. Pinned here because that second
  //    effect is invisible from the rule itself: someone solving the sliver
  //    another way would silently put an unreachable destructive control back
  //    in front of every keyboard user.
  expect(
    stops.filter((s) => s.cls.includes('tx-action')).length,
    'no delete button in the tab order while its row is closed',
  ).toBe(0);

  // 3. …while the row's own action, which used to have no keyboard path at
  //    all, now does.
  expect(
    stops.filter((s) => s.cls.includes('tx-open')).length,
    'the bookings themselves are tab stops',
  ).toBeGreaterThan(0);

  // Enter opens the booking the handle names.
  const handle = page.locator('#transactionList .tx-open').first();
  const label = await handle.getAttribute('aria-label');
  const desc = await page
    .locator('#transactionList .tx-row')
    .first()
    .locator('.t-note')
    .innerText();
  expect(label).toContain(desc);
  await handle.focus();
  await expect(handle).toBeFocused();
  await handle.press('Enter');
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#inputDesc')).toHaveValue(desc);
  await page.evaluate(() => window.closeModal({ force: true }));
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  // 4. In select mode the same key marks the row instead of opening it, and
  //    the handle reports that state rather than naming an edit it will not
  //    perform.
  await page.evaluate(() => window.enterSelectionMode());
  const marker = page.locator('#transactionList .tx-open').first();
  await expect(marker).toHaveAttribute('aria-pressed', 'false');
  await marker.focus();
  await marker.press('Enter');
  await expect(marker).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => appState.selection.ids.length)).toBe(1);
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  await page.evaluate(() => window.exitSelectionMode());

  // 5. Revealing the delete button by swiping puts it back within reach —
  //    hiding it must not make it unreachable once it is actually on screen.
  await page.evaluate(() => {
    const row = document.querySelector('#transactionList .tx-row');
    row.classList.add('swiped');
  });
  const del = page.locator('#transactionList .tx-row.swiped .tx-action').first();
  await expect(del).toBeVisible();
  await del.focus();
  await expect(del).toBeFocused();

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
