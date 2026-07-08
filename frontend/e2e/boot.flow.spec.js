// Boot resilience: a boot whose keystone data load fails (backend
// restarting, dead network, empty cache) must not strand the user in a
// silently empty app — the boot-error banner appears, a tap retries, and
// the failed boot leaves a breadcrumb for the server log
// (POST /api/client-log/reload-events, reason=boot_failed).
const { test, expect } = require('@playwright/test');
const { loginViaApi } = require('./helpers');

// Service workers are blocked so page.route reliably intercepts the boot
// requests (SW-initiated fetches bypass route interception).
test.use({ serviceWorkers: 'block' });

test('failed boot shows the retry banner; a tap retries and recovers', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await loginViaApi(page.context());
  let blocked = true;
  await page.route('**/api/categories', (route) => (blocked ? route.abort() : route.continue()));
  await page.goto('/');
  const banner = page.locator('#bootErrorBanner');
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).not.toBeEmpty();

  // Backend "returns": tapping the banner retries the boot loads.
  blocked = false;
  await banner.click();
  await expect(banner).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => appState.ledger.categories.length))
    .toBeGreaterThan(0);
  // The boot_failed breadcrumb was recorded by the failed attempt and
  // delivered after the successful retry (buffer cleared).
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('pocketlog.reloadEvents')))
    .toBeNull();
  expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
