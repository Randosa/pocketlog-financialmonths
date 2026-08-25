// Shared plumbing for the Playwright specs.
//
// One account serves the whole suite: the smoke spec creates it through the
// first-run setup UI (the `smoke` project runs first via project
// dependencies, keeping that unique fresh-container coverage), and the flow
// specs authenticate against it via the API.
const { expect } = require('@playwright/test');

const ADMIN_USER = 'smokeadmin';
const ADMIN_PASS = 'Smoke-Passw0rd-123';

// Authenticate a browser context through the API. Handles both the fresh
// instance (creates the admin; a parallel worker losing the race gets 409
// and falls through to login) and the already-provisioned one. The cookies
// land in the context's jar — context.request shares it — so a subsequent
// page.goto('/') boots straight into the app.
async function loginViaApi(context) {
  const status = await context.request.get('/api/auth/setup-status');
  expect(status.ok()).toBeTruthy();
  const { needs_setup: needsSetup } = await status.json();
  if (needsSetup) {
    const setup = await context.request.post('/api/auth/setup', {
      data: { username: ADMIN_USER, password: ADMIN_PASS, locale: 'de-DE' },
    });
    if (setup.ok()) return; // setup issues the session cookies itself
    expect(setup.status(), 'setup race must fall through to login').toBe(409);
  }
  const login = await context.request.post('/api/auth/login', {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  expect(login.ok(), 'API login for the suite account').toBeTruthy();
}

// Top-level i18n namespaces (must mirror the keys in frontend/i18n/*.json).
// A visible "<namespace>.<something>" string means a key fell through to its
// raw form because the bundle lacked it — exactly the goals.* regression.
const NAMESPACES = [
  'app',
  'common',
  'menu',
  'nav',
  'header',
  'summary',
  'search',
  'fab',
  'auth',
  'pwd',
  'settings',
  'display',
  'catIcons',
  'categories',
  'goals',
  'budget',
  'tags',
  'tx',
  'reports',
  'forecast',
  'importExport',
  'recurring',
  'selection',
  'admin',
  'users',
  'account',
  'sync',
  'date',
  'info',
];
const RAW_KEY_RE = new RegExp('\\b(' + NAMESPACES.join('|') + ')\\.[A-Za-z][A-Za-z0-9]+');

async function expectNoRawKeys(page, where) {
  const text = await page.locator('body').innerText();
  const match = text.match(RAW_KEY_RE);
  expect(match ? match[0] : null, `Untranslated i18n key visible in ${where}`).toBeNull();
}

// Boot the app as a logged-in user and wait until it is actually ready for
// writes. The FAB reports visible even behind the auth overlay (toBeVisible
// ignores occlusion), so it proves nothing; and window._csrfToken is only
// populated once /api/auth/me returns — a non-GET fired before that goes out
// without the CSRF header and gets a 403. The token alone is not enough
// either: it is set BEFORE _afterAuthSuccess loads the domain data, and
// helpers like openRecurringModal silently no-op while
// appState.ledger.categories is still empty. On a slow runner the service
// worker's install precache competes with those boot loads, so also wait for
// the categories (every bootIntoApp caller uses the suite account, which has
// the setup-seeded default categories).
async function bootIntoApp(page) {
  await page.goto('/');
  await expect(page.locator('#setupView')).toBeHidden();
  await expect(page.locator('#loginView')).toBeHidden();
  // Polled via evaluate + toPass: waitForFunction needs eval, which the
  // app's CSP (script-src 'self') forbids.
  await expect(async () => {
    const ready = await page.evaluate(() => !!window._csrfToken && appState.boot.ready);
    expect(ready).toBeTruthy();
  }).toPass({ timeout: 15000, intervals: [100, 250, 500] });
}

// Modal overlays slide in (overlay-in / modal-in, var(--dur-slow)). Clicking a
// control while it is still moving is what Playwright reports as "element is
// not stable", and for a styled switch the click can land as a no-op. Wait for
// the real signal — the animations themselves — rather than a fixed sleep.
// Infinite animations (a spinner) never finish, so they are skipped.
async function modalSettled(page, overlayId) {
  await page.evaluate(async (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const running = el
      .getAnimations({ subtree: true })
      .filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity);
    await Promise.all(running.map((a) => a.finished.catch(() => {})));
  }, overlayId);
}

// Drive the app's own navigation directly rather than clicking the nav item:
// the drawer's open animation makes a real click flaky, and the post-login
// init runs showPanel(loadDefaultView()) after the data loads, which can land
// *after* our navigation on a slow runner and steal the active panel. toPass
// re-navigates until the target panel sticks.
async function gotoPanel(page, id) {
  await expect(async () => {
    await page.evaluate((p) => window.showPanel(p), id);
    await expect(page.locator(`#panel-${id}`)).toHaveClass(/active/, { timeout: 1000 });
  }).toPass({ timeout: 15000, intervals: [200, 500, 1000] });
}

// The five category choosers, by context: the search field and the chip row
// each one owns. Every form that used to hold a <select> drives these now.
const CAT_CHOOSER_IDS = {
  transaction: { input: 'catSearch', row: 'catSuggestions' },
  recurring: { input: 'recCatSearch', row: 'recCatSuggestions' },
  goal: { input: 'goalCatSearch', row: 'goalCatSuggestions' },
  budget: { input: 'budgetCatSearch', row: 'budgetCatSuggestions' },
  bulk: { input: 'bulkCatSearch', row: 'bulkCatSuggestions' },
};

// Labels of the chips currently on a chooser's row. With an empty field that
// is the ranked top two rows, not every category — so a name missing from it
// proves nothing on its own; use catChooserOffers for that.
function catChipLabels(page, ctx) {
  return page.$$eval(`#${CAT_CHOOSER_IDS[ctx].row} .cat-suggestion:not(.cat-create)`, (els) =>
    els.map((e) => e.textContent.trim()),
  );
}

// Whether a chooser will offer a category at all — searched by name, which is
// how a user reaches past the visible rows. The goal and budget choosers hide
// the categories already spoken for, and that omission is the assertion.
async function catChooserOffers(page, ctx, name) {
  await page.fill(`#${CAT_CHOOSER_IDS[ctx].input}`, name);
  const labels = await catChipLabels(page, ctx);
  await page.fill(`#${CAT_CHOOSER_IDS[ctx].input}`, '');
  return labels.includes(name);
}

// Pick a category in a chooser: search for it, then tap its chip. Mirrors what
// a user does, and works regardless of whether the name is among the ranked
// chips already on screen.
async function chooseCategory(page, ctx, name) {
  const { input, row } = CAT_CHOOSER_IDS[ctx];
  await page.fill(`#${input}`, name);
  const chip = page.locator(`#${row} .cat-suggestion:not(.cat-create)`, { hasText: name });
  await expect(chip.first()).toBeVisible();
  await chip.first().click();
  // Picking clears the query; the row goes back to the ranked overview.
  await expect(page.locator(`#${input}`)).toHaveValue('');
}

// The id the chooser will hand its form on save.
function chosenCategoryId(page, ctx) {
  return page.evaluate((c) => appState.catChooser[c].selectedId, ctx);
}

module.exports = {
  modalSettled,
  ADMIN_USER,
  ADMIN_PASS,
  loginViaApi,
  bootIntoApp,
  expectNoRawKeys,
  gotoPanel,
  catChipLabels,
  catChooserOffers,
  chooseCategory,
  chosenCategoryId,
};
