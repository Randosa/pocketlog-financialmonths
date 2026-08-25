// Focus on open: every modal (and the drawer) moves focus to its first field
// a moment after it appears, so the keyboard is up and the caret is where you
// need it without a second tap.
//
// The delay is for the slide-in, and it used to fire unconditionally. On a
// fast tap that is long enough to reach a *different* field first — and the
// timer then pulled the caret away mid-word, so the characters already typed
// landed in the field the app had chosen rather than the one under the finger.
// A booking's amount ended up appended to its note; a rule's amount to its
// name, which then failed validation with "Enter an amount" over a field the
// user had just filled in.
//
// It also made the e2e suite flaky in a way that looked like six unrelated
// bugs: whichever spec happened to fill a second field inside the window lost
// its input.
const { test, expect } = require('@playwright/test');
const { loginViaApi, bootIntoApp } = require('./helpers');

const activeId = (page) => page.evaluate(() => document.activeElement.id);

test('opening a modal claims focus, but never takes it back from the user', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await loginViaApi(page.context());
  await bootIntoApp(page);

  // --- Untouched, the app still picks the field for you ---
  await page.evaluate(() => window.openModal());
  await expect.poll(() => activeId(page)).toBe('inputAmount');
  await page.evaluate(() => window.closeModal({ force: true }));

  // --- Reach another field first and it stays yours ---
  // Both calls in one evaluate: the tap has to land inside the delay, which
  // is exactly the interleaving a separate round trip would not reproduce.
  await page.evaluate(() => {
    window.openModal();
    document.getElementById('inputDesc').focus();
  });
  await expect(page.locator('#inputDesc')).toBeFocused();
  // Typing goes where the caret is, and nothing rewrites it from under us.
  await page.keyboard.type('Bakery');
  await page.waitForTimeout(500); // outlast the 300ms focus timer
  await expect(page.locator('#inputDesc')).toBeFocused();
  await expect(page.locator('#inputDesc')).toHaveValue('Bakery');
  await expect(page.locator('#inputAmount')).toHaveValue('');
  await page.evaluate(() => window.closeModal({ force: true }));

  // --- Same for the recurring editor, whose fields sit in the other order ---
  await page.evaluate(() => {
    window.openRecurringModal();
    document.getElementById('recEditAmount').focus();
  });
  await expect(page.locator('#recEditAmount')).toBeFocused();
  await page.keyboard.type('9,99');
  await page.waitForTimeout(400);
  await expect(page.locator('#recEditAmount')).toHaveValue('9,99');
  await expect(page.locator('#recEditName')).toHaveValue('');
  await page.evaluate(() => window.closeRecurringModal());

  // --- A modal closed again inside the delay must not pull focus back in ---
  await page.evaluate(() => {
    window.openRecurringModal();
    window.closeRecurringModal();
    document.querySelector('.fab').focus();
  });
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(() => !!document.activeElement.closest('#recurringModalOverlay')),
    'focus stays out of the modal that closed again',
  ).toBe(false);

  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
