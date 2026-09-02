// Pure aggregation helpers for the reports/goals views.
//
// Like utils.js, this is loaded as a classic script *before* app.js, so the
// declarations are globals the render functions call directly (call sites
// unchanged). The functions take their data as arguments and return plain
// values — no app state, no DOM, no I18N — which is what makes them safe to
// unit-test in isolation (frontend/unit/reportsData.test.js). The
// module.exports guard at the bottom is a no-op in the browser.

// The browser receives these helpers from utils.js, which is loaded first.
// Unit tests import this CommonJS-style file directly, so load the same pure
// helpers there as well instead of giving tests a different implementation.
const _financialHelpers =
  typeof module !== 'undefined' && module.exports ? require('./utils.js') : null;

function _periodForFinancialAnchor(...args) {
  return _financialHelpers
    ? _financialHelpers._financialPeriodForAnchor(...args)
    : _financialPeriodForAnchor(...args);
}
function _anchorForFinancialDate(...args) {
  return _financialHelpers
    ? _financialHelpers._financialAnchorForDate(...args)
    : _financialAnchorForDate(...args);
}
function _periodForFinancialFrequency(...args) {
  return _financialHelpers
    ? _financialHelpers._financialPeriodForFrequency(...args)
    : _financialPeriodForFrequency(...args);
}
function _shiftFinancialAnchor(...args) {
  return _financialHelpers
    ? _financialHelpers._financialShiftAnchor(...args)
    : _financialShiftAnchor(...args);
}

// Sum a list of transactions into { out, in } totals (numbers).
function _sumByType(txs) {
  let out = 0,
    inn = 0;
  for (const t of txs) {
    if (t.type === 'out') out += t.amount;
    else inn += t.amount;
  }
  return { out, in: inn };
}

// Total amount per category for a single type, as a list sorted by amount
// descending: [{ catId, amount }, …]. Pass type 'all' to total income and
// spending together (used by the trend, which graphs any category — income
// categories like a salary included — not just spending).
function _totalsByCategory(txs, type = 'out') {
  const totals = {};
  for (const t of txs) {
    if (type !== 'all' && t.type !== type) continue;
    totals[t.category_id] = (totals[t.category_id] || 0) + t.amount;
  }
  return Object.entries(totals)
    .map(([id, amt]) => ({ catId: parseInt(id, 10), amount: amt }))
    .sort((a, b) => b.amount - a.amount);
}

// Stable hue per tag — same name always maps to the same color. Avoids
// a per-tag color setting while keeping the donut visually distinct.
function _tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(h) % 360}deg 58% 52%)`;
}

// Sum amounts per tag for the given type. A transaction with multiple
// tags contributes its full amount to each tag (tags are categorical
// labels, not splits) — mirrors how Top-Kategorien aggregates. Pass type
// 'all' to total income and spending together (used by the trend).
function _totalsByTag(txs, type = 'out') {
  const totals = {};
  for (const t of txs) {
    if (type !== 'all' && t.type !== type) continue;
    if (!Array.isArray(t.tags) || !t.tags.length) continue;
    for (const tag of t.tags) {
      totals[tag] = (totals[tag] || 0) + t.amount;
    }
  }
  return Object.entries(totals)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
}

// Derived goal progress over a pool of transactions. Money is summed in
// integer cents (Math.round) so the percentages and remaining/current
// figures never drift through float — mirroring the backend's money rule.
// Never mutates its inputs; returns a fresh summary object.
function _goalProgress(goal, pool) {
  const wantType = goal.direction === 'pay_down' ? 'out' : 'in';
  let matchedCents = 0;
  for (const t of pool) {
    if (t.category_id !== goal.category_id) continue;
    if (t.type !== wantType) continue;
    if (t.date < goal.start_date) continue;
    matchedCents += Math.round(t.amount * 100);
  }
  const initialCents = Math.round(Number(goal.initial_amount) * 100);
  const targetCents = Math.round(Number(goal.target_amount) * 100);
  if (goal.direction === 'pay_down') {
    // % = how much of the intended pay-off (initial → target) is done.
    // "Done" means reaching the target (Restziel), not necessarily 0.
    const spanCents = initialCents - targetCents; // amount to repay
    const remainingCents = initialCents - matchedCents;
    const pct = spanCents > 0 ? (matchedCents / spanCents) * 100 : 100;
    return {
      pct: Math.max(0, Math.min(100, pct)),
      rawPct: Math.max(0, pct),
      primaryCents: Math.max(0, remainingCents),
      targetCents,
      paidCents: matchedCents,
      complete: remainingCents <= targetCents,
    };
  }
  // Savings: "Bereits gespart" (initial) counts as progress, so the
  // percentage is the absolute current/target — matching the
  // "{current} von {target}" primary line.
  const currentCents = initialCents + matchedCents;
  const pct = targetCents > 0 ? (currentCents / targetCents) * 100 : 100;
  return {
    pct: Math.max(0, Math.min(100, pct)),
    rawPct: Math.max(0, pct),
    primaryCents: currentCents,
    targetCents,
    complete: currentCents >= targetCents,
  };
}

// Financial-period bounds for a budget frequency, given a reference year +
// zero-based financial-month anchor. Dates remain real transaction dates;
// only the inclusive reporting range changes.
function _budgetPeriod(frequency, year, month, startDay = 1) {
  return _periodForFinancialFrequency(frequency, year, month, startDay);
}

// Derived budget consumption over a pool of transactions for one period.
// Sums the category's `out` rows dated within [periodFrom, periodTo] in
// integer cents (Math.round) so the bar percentage and remaining figure
// never drift through float — mirroring the backend's money rule. Never
// mutates its inputs; returns a fresh summary object.
function _budgetUsage(budget, pool, periodFrom, periodTo) {
  let spentCents = 0;
  for (const t of pool) {
    if (t.category_id !== budget.category_id) continue;
    if (t.type !== 'out') continue;
    if (t.date < periodFrom || t.date > periodTo) continue;
    spentCents += Math.round(t.amount * 100);
  }
  const limitCents = Math.round(Number(budget.amount) * 100);
  const pct = limitCents > 0 ? (spentCents / limitCents) * 100 : 100;
  return {
    spentCents,
    limitCents,
    pct: Math.max(0, Math.min(100, pct)),
    rawPct: Math.max(0, pct),
    remainingCents: limitCents - spentCents,
    over: spentCents > limitCents,
  };
}

// --- Trend math (spending trend chart) -----------------------------------
// Pure calendar-bucketing and aggregation helpers lifted out of the
// renderReportTrend render path. They take ISO date strings, granularity and
// plain transaction lists as arguments and return plain values — no app
// state, no DOM, no I18N — which is what makes the calendar edge cases
// (quarter/year axis walking, year-over-year stats) unit-testable in
// isolation (frontend/unit/trends.test.js). The render function and the
// impure helpers that read app globals (_trendEntityFromId, _bucketLabel,
// _pickDefaultTrendEntity) stay in app.js and call these as globals.

// Number of financial months spanned by [fromIso, toIso] inclusive.
function _monthSpan(fromIso, toIso, startDay = 1) {
  const from = _anchorForFinancialDate(fromIso, startDay);
  const to = _anchorForFinancialDate(toIso, startDay);
  return (to.y - from.y) * 12 + (to.m - from.m) + 1;
}

// Pick the chart granularity from the span length: months under two years,
// quarters up to five, years beyond.
function _autoGranularity(fromIso, toIso, startDay = 1) {
  const months = _monthSpan(fromIso, toIso, startDay);
  if (months < 24) return 'month';
  if (months <= 60) return 'quarter';
  return 'year';
}

// Financial bucket key for a date: the key identifies the month in which the
// financial period starts ("2026-08" for 2026-09-02 when the start day is 16).
function _bucketKey(iso, granularity, startDay = 1) {
  const anchor = _anchorForFinancialDate(iso, startDay);
  if (granularity === 'year') return String(anchor.y);
  if (granularity === 'quarter')
    return `${anchor.y}-Q${Math.floor(anchor.m / 3) + 1}`;
  return `${anchor.y}-${String(anchor.m + 1).padStart(2, '0')}`;
}

// Ordered list of bucket keys spanning [fromIso, toIso] inclusive at the
// given granularity — the chart's x-axis. Walks the calendar so empty
// buckets in the middle are still represented.
function _bucketAxis(fromIso, toIso, granularity, startDay = 1) {
  const from = _anchorForFinancialDate(fromIso, startDay);
  const to = _anchorForFinancialDate(toIso, startDay);
  const keys = [];
  if (granularity === 'year') {
    for (let y = from.y; y <= to.y; y++) keys.push(String(y));
    return keys;
  }
  if (granularity === 'quarter') {
    let current = { ...from };
    let previous = null;
    while (current.y < to.y || (current.y === to.y && current.m <= to.m)) {
      const key = `${current.y}-Q${Math.floor(current.m / 3) + 1}`;
      if (key !== previous) keys.push(key);
      previous = key;
      current = _shiftFinancialAnchor(current.y, current.m, 1);
    }
    return keys;
  }
  let current = { ...from };
  while (current.y < to.y || (current.y === to.y && current.m <= to.m)) {
    keys.push(`${current.y}-${String(current.m + 1).padStart(2, '0')}`);
    current = _shiftFinancialAnchor(current.y, current.m, 1);
  }
  return keys;
}

// Centred moving average over a numeric series (chart smoothing). window<=1
// is a no-op copy.
function _movingAverage(values, window) {
  if (window <= 1) return values.slice();
  const result = [];
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += values[j];
    result.push(sum / (end - start + 1));
  }
  return result;
}

// Stable hue like _tagColor, but with clamped lightness so both light
// and dark mode keep contrast against the chart line.
function _tagLineColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(h) % 360}deg 55% 50%)`;
}

// Does a transaction belong to the trend entity (a category or a tag)? Both
// income and spending count towards a trend line, so income-only categories
// (e.g. a salary) graph the same way as spending categories. Amounts are
// stored positive with direction in `type`, so summing magnitudes keeps every
// line positive; a category mixing income and spending sums both magnitudes.
function _trendMatchesEntity(t, entity) {
  if (entity.kind === 'category') return t.category_id === entity.catId;
  return Array.isArray(t.tags) && t.tags.includes(entity.name);
}

// Trend lines are a net flow: income counts positive, spending negative.
// That keeps each category's direction visible against the zero baseline and
// lets a category that mixes both directions net out per month. Amounts are
// stored positive with the direction in `type`.
function _signedTrendAmount(t) {
  return t.type === 'out' ? -t.amount : t.amount;
}

// Sum the entity's net flow into a per-calendar-month map (YYYY-MM → amount),
// the input to _trendStats.
function _monthlyTotals(txs, entity, startDay = 1) {
  const sums = new Map();
  for (const t of txs) {
    if (!_trendMatchesEntity(t, entity)) continue;
    const key = _bucketKey(t.date, 'month', startDay);
    sums.set(key, (sums.get(key) || 0) + _signedTrendAmount(t));
  }
  return sums;
}

// Mean / peak / year-over-year stats over a monthly map for the [fromIso,
// toIso] span. Returns null for an empty span.
function _trendStats(monthlyMap, fromIso, toIso, startDay = 1) {
  const months = _bucketAxis(fromIso, toIso, 'month', startDay);
  if (!months.length) return null;
  let total = 0;
  let peak = null;
  for (const k of months) {
    const v = monthlyMap.get(k) || 0;
    total += v;
    // Peak = the month with the largest movement in either direction; the
    // value keeps its sign so the card shows whether it was income or
    // spending (net flow can be negative).
    if (peak === null || Math.abs(v) > Math.abs(peak.value)) peak = { key: k, value: v };
  }
  const mean = total / months.length;
  const yearGroups = new Map();
  for (const k of months) {
    const y = k.slice(0, 4);
    if (!yearGroups.has(y)) yearGroups.set(y, []);
    yearGroups.get(y).push(monthlyMap.get(k) || 0);
  }
  // Threshold deliberately low (≥3 months) so the running year shows up
  // from Q2 on — the renderReportTrend call site caps toIso at today, so
  // every yearly average is computed only over months that actually have
  // data (per-month projection instead of dilution by zeros).
  const years = Array.from(yearGroups.entries()).filter(([, list]) => list.length >= 3);
  let yoy = null;
  if (years.length >= 2) {
    const first = years[0];
    const last = years[years.length - 1];
    if (first[0] !== last[0]) {
      const firstMean = first[1].reduce((s, v) => s + v, 0) / first[1].length;
      const lastMean = last[1].reduce((s, v) => s + v, 0) / last[1].length;
      const pct = firstMean !== 0 ? ((lastMean - firstMean) / firstMean) * 100 : null;
      yoy = { firstYear: first[0], lastYear: last[0], firstMean, lastMean, pct };
    }
  }
  return { mean, peak, yoy, monthCount: months.length };
}

// Node/Vitest only — the browser classic-script load skips this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _sumByType,
    _totalsByCategory,
    _tagColor,
    _totalsByTag,
    _goalProgress,
    _budgetPeriod,
    _budgetUsage,
    _monthSpan,
    _autoGranularity,
    _bucketKey,
    _bucketAxis,
    _movingAverage,
    _tagLineColor,
    _trendMatchesEntity,
    _signedTrendAmount,
    _monthlyTotals,
    _trendStats,
  };
}

