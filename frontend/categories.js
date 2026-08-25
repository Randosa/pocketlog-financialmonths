// Category management plus the tag picker and icon picker modals.
// Classic script — see index.html for load order.

// ── CATEGORIES ────────────────────────────────────────────────────────────────
const CAT_CREATE_COLORS = ['#D97757', '#6b7aa1', '#788C5D', '#c47ab0', '#e0a44a', '#87867F'];

async function loadCategories(opts = {}) {
  try {
    appState.ledger.categories = await api('GET', '/categories');
  } catch (e) {
    // Boot uses rethrow to detect the dead-boot case (app.js _loadBootData);
    // every other caller keeps the offline-tolerant empty fallback.
    if (opts.rethrow) throw e;
    appState.ledger.categories = [];
  }
}

async function loadTags() {
  try {
    const tags = await api('GET', '/tags');
    const list = Array.isArray(tags) ? tags : [];
    appState.ledger.availableTags = list.map((t) => (typeof t === 'string' ? t : t.name));
    tagCounts.clear();
    for (const t of list) {
      if (typeof t === 'string') continue;
      tagCounts.set(t.name.toLowerCase(), Number(t.count) || 0);
    }
  } catch (e) {
    appState.ledger.availableTags = [];
    tagCounts.clear();
  }
  renderTagList();
}

// ── TAG CHOOSER ───────────────────────────────────────────────────────────────
// The booking form and the recurring-rule editor pick tags the same way: a
// search field over every tag, and below it a chip row that *is* the
// selection — a chosen tag carries the accent rather than being repeated as a
// pill somewhere else. That is why neither form has a tag field any more, and
// why the picker modal is left to the ledger's bulk actions.
//
// The two contexts differ only in which elements they own and where their
// selection lives.
const TAG_CHOOSERS = {
  transaction: {
    input: 'tagSearch',
    row: 'tagSuggestions',
    hint: 'tagSuggestionsHint',
    read: () => appState.form.tags,
    write: (v) => {
      appState.form.tags = v;
    },
  },
  recurring: {
    input: 'recTagSearch',
    row: 'recTagSuggestions',
    hint: 'recTagSuggestionsHint',
    read: () => appState.recurring.tags,
    write: (v) => {
      appState.recurring.tags = v;
    },
  },
};

// Chips shown with an empty field, and the cap once a query narrows things
// down — enough to be useful, few enough to scan without scrolling the modal.
const TAG_CHOOSER_TOP = 10;
const TAG_CHOOSER_HITS = 15;

const _byTagName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

// Decide which chips the row shows, and freeze that order into the view
// state. Called when a form opens and whenever the query changes — never on
// toggle. Without that a tap would re-sort the row under the finger and the
// next tap would land on a different tag.
function _rebuildTagChooser(ctx) {
  const chooser = TAG_CHOOSERS[ctx];
  const view = appState.tagChooser[ctx];
  const query = view.query.trim().toLowerCase();
  const all = appState.ledger.availableTags;

  if (query) {
    // Search runs over every tag, not just the frequent ones — that is the
    // whole point of the field replacing the picker.
    const hits = all.filter((t) => t.toLowerCase().includes(query)).sort(_byTagName);
    view.shown = hits.slice(0, TAG_CHOOSER_HITS);
    view.overflow = hits.length - view.shown.length;
    return;
  }

  // Overview: what is already attached comes first, so editing an old entry
  // shows its tags even when none of them are among the frequent ones.
  const chosen = chooser.read();
  const selected = new Set(chosen.map((x) => x.toLowerCase()));
  const rest = all
    .filter((t) => !selected.has(t.toLowerCase()))
    .sort((a, b) => {
      // Most-used first (90-day window, see crud/tags.py), then by name.
      const ca = tagCounts.get(a.toLowerCase()) || 0;
      const cb = tagCounts.get(b.toLowerCase()) || 0;
      return cb !== ca ? cb - ca : _byTagName(a, b);
    })
    .slice(0, TAG_CHOOSER_TOP)
    .sort(_byTagName);
  view.shown = [...chosen.slice().sort(_byTagName), ...rest];
  view.overflow = 0;
}

function renderTagChooser(ctx) {
  const chooser = TAG_CHOOSERS[ctx];
  const box = document.getElementById(chooser.row);
  if (!box) return;
  const view = appState.tagChooser[ctx];
  const chosen = chooser.read();
  const selected = new Set(chosen.map((x) => x.toLowerCase()));
  const query = _normaliseNewTag(view.query);
  const full = chosen.length >= MAX_TAGS_PER_TX;
  const exact =
    query && appState.ledger.availableTags.some((t) => t.toLowerCase() === query.toLowerCase());

  // Replacing innerHTML drops the focused chip; the row order is frozen, so
  // the same slot still holds the same tag and focus can go straight back.
  const focused = box.contains(document.activeElement)
    ? [...box.children].indexOf(document.activeElement)
    : -1;

  const chips = view.shown.map((t) => {
    const on = selected.has(t.toLowerCase());
    const label = on ? 'tags.removeAria' : 'tags.addSuggestionAria';
    return `<button type="button" class="tag-suggestion${on ? ' is-added' : ''}" data-chooser-tag="${_escAttr(t)}" aria-pressed="${on}" aria-label="${_escAttr(tr(label, { name: t }))}">${_escText(t)}</button>`;
  });
  // Offer to make the typed text a tag, so the name is typed once rather than
  // again in a separate create field. It goes last: with matches on screen the
  // likely intent is one of them, and creating "Auto" must stay possible even
  // though "Autobahn" matches. With no matches it is the only chip anyway.
  if (query && !exact && !full) {
    chips.push(
      `<button type="button" class="tag-suggestion tag-create" data-chooser-create="${_escAttr(query)}">${_escText(tr('tags.createChip', { name: query }))}</button>`,
    );
  }
  box.innerHTML = chips.join('');
  box.querySelectorAll('[data-chooser-tag]').forEach((el) => {
    el.addEventListener('click', () => toggleTagChooser(ctx, el.dataset.chooserTag));
  });
  box.querySelectorAll('[data-chooser-create]').forEach((el) => {
    el.addEventListener('click', () => createTagFromChooser(ctx, el.dataset.chooserCreate));
  });
  if (focused >= 0) box.children[focused]?.focus();

  const hint = document.getElementById(chooser.hint);
  if (!hint) return;
  const message = full
    ? tr('tags.limitReached', { max: MAX_TAGS_PER_TX })
    : query && !chips.length
      ? tr('tags.searchNone')
      : view.overflow > 0
        ? tr('tags.moreResults', { n: view.overflow })
        : '';
  hint.textContent = message;
  hint.hidden = !message;
}

// Chips toggle: the row is the only place a tag appears, so it has to be able
// to take one off again.
function toggleTagChooser(ctx, name) {
  if (!name) return;
  const chooser = TAG_CHOOSERS[ctx];
  const list = chooser.read().slice();
  const i = list.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  if (i >= 0) list.splice(i, 1);
  else if (list.length >= MAX_TAGS_PER_TX) {
    renderTagChooser(ctx); // surfaces the limit hint, adds nothing
    return;
  } else list.push(name);
  chooser.write(list);
  // Deliberately no rebuild — the chip recolours where it stands.
  renderTagChooser(ctx);
}

function filterTagChooser(ctx, value) {
  appState.tagChooser[ctx].query = value || '';
  _rebuildTagChooser(ctx);
  renderTagChooser(ctx);
  // On a phone the keyboard covers the row the moment the field takes focus.
  document.getElementById(TAG_CHOOSERS[ctx].row)?.scrollIntoView({ block: 'nearest' });
}

// Enter is additive only: it picks an exact match or creates the typed name,
// never removes. Removing is a deliberate tap on the accent chip.
function handleTagChooserKey(ctx, value, e) {
  if (!e || e.key !== 'Enter') return;
  e.preventDefault();
  const name = _normaliseNewTag(value);
  if (!name) return;
  const exact = appState.ledger.availableTags.find((t) => t.toLowerCase() === name.toLowerCase());
  if (!exact) {
    createTagFromChooser(ctx, name);
    return;
  }
  const chooser = TAG_CHOOSERS[ctx];
  if (!chooser.read().some((x) => x.toLowerCase() === exact.toLowerCase())) {
    toggleTagChooser(ctx, exact);
  }
  _clearTagChooserQuery(ctx);
}

function createTagFromChooser(ctx, raw) {
  const chooser = TAG_CHOOSERS[ctx];
  const name = _normaliseNewTag(raw);
  if (!name) return;
  const list = chooser.read();
  if (list.length >= MAX_TAGS_PER_TX) {
    renderTagChooser(ctx);
    return;
  }
  // In memory only. The tag row is written when the booking or the rule is
  // saved (crud._resolve_tags creates what is missing), so abandoning the
  // form leaves no orphan behind — same as the picker's create field did.
  if (!appState.ledger.availableTags.some((t) => t.toLowerCase() === name.toLowerCase())) {
    appState.ledger.availableTags.push(name);
    appState.ledger.availableTags.sort(_byTagName);
  }
  chooser.write([...list, name]);
  _clearTagChooserQuery(ctx);
}

// Back to the overview, which puts the freshly chosen tag at the front where
// the user can see it landed.
function _clearTagChooserQuery(ctx) {
  appState.tagChooser[ctx].query = '';
  const input = document.getElementById(TAG_CHOOSERS[ctx].input);
  if (input) input.value = '';
  _rebuildTagChooser(ctx);
  renderTagChooser(ctx);
}

// Called when a form opens: clear the query and recompute from scratch.
function resetTagChooser(ctx) {
  appState.tagChooser[ctx] = { query: '', shown: [], overflow: 0 };
  const input = document.getElementById(TAG_CHOOSERS[ctx].input);
  if (input) input.value = '';
  _rebuildTagChooser(ctx);
  renderTagChooser(ctx);
}

// ── TAG PICKER MODAL ──────────────────────────────────────────────────────────
// Only the ledger's bulk actions still open this. The booking form and the
// recurring editor pick tags inline through the chooser above, so the picker
// no longer stages a form's tags — its selection is always the set of tags to
// add to, or remove from, the marked transactions.
//   selection      — staged tags, applied on „Übernehmen"
//   context        — 'bulkAdd' | 'bulkRemove'
//   bulkRemovePool — tags actually present on the marked transactions
//
// It works the way the chooser does: one field that searches and, when
// adding, creates — no separate create row. The differences are inherent to
// acting on many rows at once: the picker stages its selection behind
// „Übernehmen" instead of writing through, and the remove mode searches only
// the tags actually on the marked rows.

function openTagPickerFor(context) {
  appState.tagPicker.context = context;
  rememberModalFocus('tagPicker');
  // Both bulk contexts start empty: the picked tags are the ones to act on,
  // not a pre-existing selection to edit.
  appState.tagPicker.selection = [];
  const isRemove = context === 'bulkRemove';
  const title = document.getElementById('tagPickerTitle');
  if (title)
    title.textContent = isRemove ? tr('selection.removeTagTitle') : tr('selection.addTagTitle');
  const filter = document.getElementById('tagPickerFilter');
  filter.value = '';
  // Only the add mode can create, so only it says so. openBulkRemoveTags
  // never opens the remove mode on an empty pool, so there is no case left
  // where the field would search through nothing.
  filter.placeholder = tr(isRemove ? 'tags.searchPlaceholder' : 'tags.searchOrCreate');
  const chips = document.getElementById('tagPickerChips');
  chips.style.minHeight = '';
  renderTagPickerChips();
  document.getElementById('tagPickerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  // Lock chip-area height to the unfiltered render so the modal
  // doesn't snap shut while the user is narrowing the filter.
  requestAnimationFrame(() => {
    chips.style.minHeight = chips.offsetHeight + 'px';
  });
  trapFocusIn(document.querySelector('#tagPickerOverlay .modal'), 'tagPicker');
}
function closeTagPicker() {
  document.getElementById('tagPickerOverlay').classList.remove('open');
  document.getElementById('tagPickerChips').style.minHeight = '';
  // The picker is only reached from the ledger now, so nothing else holds the
  // scroll lock.
  document.body.style.overflow = '';
  appState.tagPicker.selection = [];
  releaseFocusTrap('tagPicker');
  restoreModalFocus('tagPicker');
}
function closeTagPickerOutside(e) {
  if (e.target === document.getElementById('tagPickerOverlay')) closeTagPicker();
}
function commitTagPicker() {
  const ctx = appState.tagPicker.context;
  const tags = [...appState.tagPicker.selection];
  closeTagPicker();
  if (!tags.length) return;
  bulkApply({ action: ctx === 'bulkRemove' ? 'remove_tags' : 'add_tags', tags });
}
// The remove picker is scoped to the tags actually on the selected rows.
function _tagPickerSource() {
  return appState.tagPicker.context === 'bulkRemove'
    ? appState.tagPicker.bulkRemovePool
    : appState.ledger.availableTags;
}

function renderTagPickerChips() {
  const box = document.getElementById('tagPickerChips');
  if (!box) return;
  const isRemove = appState.tagPicker.context === 'bulkRemove';
  const raw = document.getElementById('tagPickerFilter').value || '';
  const q = raw.trim().toLowerCase();
  const source = _tagPickerSource();
  const filtered = q ? source.filter((t) => t.toLowerCase().includes(q)) : source;
  const selected = new Set(appState.tagPicker.selection.map((x) => x.toLowerCase()));
  const full = appState.tagPicker.selection.length >= MAX_TAGS_PER_TX;
  const chips = filtered.map((t) => {
    const isSel = selected.has(t.toLowerCase());
    return `<button type="button" class="tag-picker-chip${isSel ? ' selected' : ''}" data-pick-tag="${_escAttr(t)}" aria-pressed="${isSel}">${_escText(t)}</button>`;
  });
  // Same offer the booking form makes: a name nobody has yet becomes a chip
  // that creates it, typed once instead of again in a separate field. It goes
  // last, so an existing match stays the first thing under the finger.
  const name = isRemove ? '' : _normaliseNewTag(raw);
  const exact = name && source.some((t) => t.toLowerCase() === name.toLowerCase());
  if (name && !exact && !full) {
    chips.push(
      `<button type="button" class="tag-picker-chip tag-create" data-pick-create="${_escAttr(name)}">${_escText(tr('tags.createChip', { name }))}</button>`,
    );
  }
  box.innerHTML = chips.join('');
  box.querySelectorAll('[data-pick-tag]').forEach((el) => {
    el.addEventListener('click', () => togglePickerTag(el.dataset.pickTag));
  });
  box.querySelectorAll('[data-pick-create]').forEach((el) => {
    el.addEventListener('click', () => createTagFromPicker(el.dataset.pickCreate));
  });

  const hint = document.getElementById('tagPickerHint');
  if (!hint) return;
  // The server caps a transaction's tag list, so refuse the 21st here rather
  // than letting „Übernehmen" come back as a 422 nobody can read.
  const message = full
    ? tr('tags.limitReached', { max: MAX_TAGS_PER_TX })
    : q && !chips.length
      ? tr('tags.searchNone')
      : '';
  hint.textContent = message;
  hint.hidden = !message;
}
function togglePickerTag(t) {
  const i = appState.tagPicker.selection.findIndex((x) => x.toLowerCase() === t.toLowerCase());
  if (i >= 0) appState.tagPicker.selection.splice(i, 1);
  else if (appState.tagPicker.selection.length >= MAX_TAGS_PER_TX) {
    renderTagPickerChips(); // surfaces the limit hint, adds nothing
    return;
  } else appState.tagPicker.selection.push(t);
  renderTagPickerChips();
}

// Back to the unfiltered grid, where the freshly picked tag is visible as a
// selected chip.
function _clearTagPickerQuery() {
  const filter = document.getElementById('tagPickerFilter');
  if (filter) filter.value = '';
  renderTagPickerChips();
}

function createTagFromPicker(raw) {
  const name = _normaliseNewTag(raw);
  if (!name) return;
  if (appState.tagPicker.selection.length >= MAX_TAGS_PER_TX) {
    renderTagPickerChips();
    return;
  }
  // In memory only. The tag row is written when the bulk action runs
  // (crud._resolve_tags_cached creates what is missing), so closing without
  // „Übernehmen" leaves no orphan behind.
  if (!appState.ledger.availableTags.some((t) => t.toLowerCase() === name.toLowerCase())) {
    appState.ledger.availableTags.push(name);
    appState.ledger.availableTags.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }
  if (!appState.tagPicker.selection.some((x) => x.toLowerCase() === name.toLowerCase())) {
    appState.tagPicker.selection.push(name);
  }
  _clearTagPickerQuery();
}

// Enter is additive only: it picks an exact match or creates the typed name.
// Taking one back off is a deliberate tap on the accent chip.
function handleTagPickerKey(value, e) {
  if (!e || e.key !== 'Enter') return;
  e.preventDefault();
  const name = _normaliseNewTag(value);
  if (!name) return;
  const exact = _tagPickerSource().find((t) => t.toLowerCase() === name.toLowerCase());
  if (!exact) {
    // Nothing to create when removing — that can only touch existing tags.
    if (appState.tagPicker.context !== 'bulkRemove') createTagFromPicker(name);
    return;
  }
  if (!appState.tagPicker.selection.some((x) => x.toLowerCase() === exact.toLowerCase())) {
    if (appState.tagPicker.selection.length >= MAX_TAGS_PER_TX) {
      renderTagPickerChips();
      return;
    }
    appState.tagPicker.selection.push(exact);
  }
  _clearTagPickerQuery();
}

function renderCategories() {
  const box = document.getElementById('catList');
  if (!box) return;
  const sorted = [...appState.ledger.categories].sort((a, b) =>
    a.name.localeCompare(b.name, _locale(), { sensitivity: 'base' }),
  );
  const shown = applyDrawerFilter('cats', sorted, (c) => c.name);
  if (!shown.length) {
    // Nothing to show is either an empty account or a query that missed.
    box.innerHTML = `<p class="empty-state-hint">${tr(drawerFilterActive('cats') ? 'categories.searchNone' : 'categories.none')}</p>`;
    return;
  }
  box.innerHTML = '';
  shown.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'drawer-nav-item cat-pill-edit';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', tr('categories.editAria', { name: c.name }));
    row.onclick = () => openCatModal(c.id);
    row.onkeydown = (e) => handleRowActivate(e, () => openCatModal(c.id));
    const iconWrap = document.createElement('div');
    iconWrap.className = 'drawer-nav-icon-wrap';
    iconWrap.style.setProperty('--nav-icon-bg', c.color);
    iconWrap.innerHTML = catIconSvg(c.icon);
    const label = document.createElement('span');
    label.className = 'drawer-nav-label';
    label.textContent = c.name;
    row.appendChild(iconWrap);
    row.appendChild(label);
    box.appendChild(row);
  });
}

const CAT_COLOR_PRESETS = [
  { hex: '#D97757', name: 'Terracotta' },
  { hex: '#6b7aa1', name: 'Blau' },
  { hex: '#788C5D', name: 'Olive' },
  { hex: '#c47ab0', name: 'Mauve' },
  { hex: '#e0a44a', name: 'Senf' },
  { hex: '#87867F', name: 'Grau' },
  { hex: '#B85C3E', name: 'Rost' },
  { hex: '#8a6a4a', name: 'Kakao' },
  { hex: '#a45ab0', name: 'Violett' },
  { hex: '#6a8a8a', name: 'Petrol' },
];

// Picker catalogue. IDs map 1:1 to <symbol id="cat-…"> entries in the
// Phosphor sprite (frontend/icons/categories/sprite.svg). Order inside
// a group is the order the picker renders.
const CAT_ICON_GROUPS = [
  {
    titleKey: 'catIcons.home',
    ids: [
      'house',
      'buildings',
      'door',
      'bed',
      'armchair',
      'couch',
      'chair',
      'television',
      'lightbulb',
      'fan',
      'oven',
      'plug',
      'key',
      'wrench',
      'hammer',
      'paint-brush',
      'broom',
      'fire',
    ],
  },
  {
    titleKey: 'catIcons.clothing',
    ids: [
      't-shirt',
      'dress',
      'hoodie',
      'pants',
      'sneaker',
      'eyeglasses',
      'watch',
      'backpack',
      'handbag',
      'baby',
      'coat-hanger',
      'washing-machine',
      'scissors',
      'shower',
      'drop',
      'toilet-paper',
    ],
  },
  {
    titleKey: 'catIcons.food',
    ids: [
      'shopping-cart',
      'basket',
      'bag',
      'bag-simple',
      'bread',
      'egg',
      'carrot',
      'fish',
      'orange',
      'avocado',
      'pepper',
      'hamburger',
      'pizza',
      'cookie',
      'cake',
      'ice-cream',
      'bowl-food',
      'bowl-steam',
      'coffee',
      'beer-stein',
      'wine',
      'martini',
      'fork-knife',
      'knife',
    ],
  },
  {
    titleKey: 'catIcons.mobility',
    ids: [
      'car',
      'taxi',
      'bus',
      'truck',
      'motorcycle',
      'scooter',
      'bicycle',
      'train',
      'train-regional',
      'airplane',
      'boat',
      'gas-pump',
      'map-pin',
      'road-horizon',
    ],
  },
  {
    titleKey: 'catIcons.leisure',
    ids: [
      'film-strip',
      'camera',
      'game-controller',
      'dice-five',
      'music-note',
      'guitar',
      'headphones',
      'microphone',
      'palette',
      'confetti',
      'book',
      'books',
      'gift',
      'ticket',
      'soccer-ball',
      'basketball',
      'tennis-ball',
      'tree-palm',
    ],
  },
  {
    titleKey: 'catIcons.health',
    ids: [
      'pill',
      'first-aid-kit',
      'bandaids',
      'heartbeat',
      'stethoscope',
      'syringe',
      'hospital',
      'brain',
      'virus',
      'mask-happy',
      'tooth',
      'dog',
      'cat',
    ],
  },
  {
    titleKey: 'catIcons.office',
    ids: [
      'briefcase',
      'graduation-cap',
      'chalkboard',
      'book-open',
      'pencil',
      'envelope',
      'calendar',
      'clipboard',
      'calculator',
      'laptop',
      'folder',
      'files',
      'magnifying-glass',
      'newspaper-clipping',
      'paperclip',
    ],
  },
  {
    titleKey: 'catIcons.finance',
    ids: [
      'wallet',
      'credit-card',
      'bank',
      'vault',
      'coins',
      'coin',
      'coin-vertical',
      'piggy-bank',
      'currency-eur',
      'currency-dollar',
      'hand-coins',
      'receipt',
      'invoice',
      'money',
      'trend-up',
      'trend-down',
      'chart-line',
      'percent',
    ],
  },
  {
    titleKey: 'catIcons.other',
    ids: [
      'package',
      'star',
      'heart',
      'sparkle',
      'magic-wand',
      'globe',
      'bell',
      'alarm',
      'sun',
      'moon',
      'cloud',
      'snowflake',
      'umbrella',
      'mountains',
      'tree',
      'plant',
      'leaf',
      'flower-tulip',
      'butterfly',
      'smiley',
      'anchor',
      'tag',
      'question',
    ],
  },
];
const CAT_ICON_FALLBACK = 'package';
const CAT_ICON_VALID = new Set(CAT_ICON_GROUPS.flatMap((g) => g.ids));

// Renders one sprite glyph. Unknown IDs (e.g. legacy emoji glyphs that
// somehow survived migration) gracefully fall back to the box icon
// rather than referencing a missing symbol.
function catIconSvg(id) {
  const safe = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
  return `<svg class="cat-glyph" aria-hidden="true"><use href="#cat-${safe}"/></svg>`;
}

// Fetch the sprite once at boot and inject it inline so document-local
// <use href="#cat-…"> references resolve everywhere (transaction rows,
// category breakdown, picker). The file is cache-first via the SW.
async function loadCategoryIconSprite() {
  if (document.getElementById('cat-icon-sprite')) return;
  try {
    const res = await fetch('/icons/categories/sprite.svg');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    // Strip the XML prolog if present — invalid as inline HTML.
    const cleaned = text.replace(/<\?xml[^?]*\?>/, '').trim();
    const host = document.createElement('div');
    host.id = 'cat-icon-sprite';
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = cleaned;
    document.body.insertBefore(host, document.body.firstChild);
  } catch (e) {
    console.warn('Category icon sprite failed to load:', e);
  }
}

// Category create/edit modal draft lives in appState.catEdit (state.js);
// seed the icon default from CAT_ICON_FALLBACK (defined above).
appState.catEdit.icon = CAT_ICON_FALLBACK;

function openCatModal(id) {
  rememberModalFocus('cat');
  const deleteBtn = document.getElementById('catDeleteBtn');
  const title = document.getElementById('catModalTitle');
  if (id) {
    const c = appState.ledger.categories.find((x) => x.id === id);
    if (!c) return;
    appState.catEdit.id = c.id;
    appState.catEdit.color = c.color || '#9e9b96';
    appState.catEdit.icon = CAT_ICON_VALID.has(c.icon) ? c.icon : CAT_ICON_FALLBACK;
    document.getElementById('catEditName').value = c.name || '';
    title.textContent = tr('categories.editTitle');
    deleteBtn.style.display = '';
  } else {
    appState.catEdit.id = null;
    appState.catEdit.color =
      CAT_CREATE_COLORS[appState.ledger.categories.length % CAT_CREATE_COLORS.length];
    appState.catEdit.icon = CAT_ICON_FALLBACK;
    document.getElementById('catEditName').value = '';
    title.textContent = tr('categories.newTitle');
    deleteBtn.style.display = 'none';
  }
  renderCatColorSwatches();
  renderCatIconPreview();
  document.getElementById('catModalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('catEditName').focus(), 200);
  trapFocusIn(document.querySelector('#catModalOverlay .modal'), 'cat');
}

function renderCatIconPreview() {
  const el = document.getElementById('catEditIconPreview');
  if (!el) return;
  el.style.color = appState.catEdit.color;
  el.innerHTML = catIconSvg(appState.catEdit.icon);
}

// Swatch row shared by the category and goal editors: the preset palette
// plus, when the current color isn't a preset, an extra swatch for it,
// followed by the free color input. pickFnName is the global pick handler
// wired through the inline onclick/onchange (re-renders on pick).
function _colorSwatchesMarkup(currentColor, pickFnName) {
  const presets = [...CAT_COLOR_PRESETS];
  const hasCurrent = presets.some((p) => p.hex.toLowerCase() === currentColor.toLowerCase());
  if (!hasCurrent) presets.push({ hex: currentColor, name: tr('categories.customColorName') });
  return (
    presets
      .map((p) => {
        const isActive = p.hex.toLowerCase() === currentColor.toLowerCase();
        return `<button type="button" class="color-swatch${isActive ? ' active' : ''}" style="background:${p.hex}" aria-label="${_escAttr(tr('categories.pickColorAria', { name: p.name }))}" aria-pressed="${isActive}" data-action="${pickFnName}" data-args='["${p.hex}"]'></button>`;
      })
      .join('') +
    `<label class="color-swatch-custom" title="${_escAttr(tr('categories.customColorName'))}">
     <input type="color" value="${currentColor}" data-action-change="${pickFnName}" data-args='["@value"]' aria-label="${_escAttr(tr('categories.customColor'))}">
   </label>`
  );
}

function renderCatColorSwatches() {
  document.getElementById('catEditColors').innerHTML = _colorSwatchesMarkup(
    appState.catEdit.color,
    'pickCatColor',
  );
}

function pickCatColor(c) {
  appState.catEdit.color = c;
  renderCatColorSwatches();
  renderCatIconPreview();
}

function closeCatModal() {
  document.getElementById('catModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  appState.catEdit.id = null;
  releaseFocusTrap('cat');
  restoreModalFocus('cat');
}

// ── ICON PICKER ───────────────────────────────────────────────────────────────
function openIconPicker() {
  rememberModalFocus('iconPicker');
  renderIconPicker();
  const overlay = document.getElementById('iconPickerOverlay');
  overlay.classList.add('open');
  // Body scroll-lock already set by the cat modal; keep it.
  // Always open scrolled to the top — the browser otherwise keeps
  // whatever scrollTop the modal-body had on the previous open.
  overlay.querySelector('.modal-body').scrollTop = 0;
  trapFocusIn(overlay.querySelector('.modal'), 'iconPicker');
}

function closeIconPicker() {
  document.getElementById('iconPickerOverlay').classList.remove('open');
  releaseFocusTrap('iconPicker');
  restoreModalFocus('iconPicker');
}

function closeIconPickerOutside(e) {
  if (e.target === document.getElementById('iconPickerOverlay')) closeIconPicker();
}

function renderIconPicker() {
  const host = document.getElementById('iconPickerSections');
  host.innerHTML = CAT_ICON_GROUPS.map((g) => {
    const cells = g.ids
      .map((id) => {
        const active = id === appState.catEdit.icon ? ' active' : '';
        const pressed = active ? 'true' : 'false';
        return `<button type="button" class="icon-picker-cell${active}"
              aria-pressed="${pressed}" aria-label="${id}"
              data-action="pickIcon" data-args='["${id}"]'>${catIconSvg(id)}</button>`;
      })
      .join('');
    return `<section class="icon-picker-section">
            <h3 class="icon-picker-section-title">${tr(g.titleKey)}</h3>
            <div class="icon-picker-grid">${cells}</div>
          </section>`;
  }).join('');
}

function pickIcon(id) {
  appState.catEdit.icon = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
  renderCatIconPreview();
  closeIconPicker();
}

async function saveCategoryEdit() {
  const name = document.getElementById('catEditName').value.trim();
  const icon = CAT_ICON_VALID.has(appState.catEdit.icon)
    ? appState.catEdit.icon
    : CAT_ICON_FALLBACK;
  if (!name) {
    toast(tr('common.nameRequired'), 'error');
    return;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(appState.catEdit.color)) {
    toast(tr('categories.invalidColor'), 'error');
    return;
  }
  const editId = appState.catEdit.id;
  const fields = { name, icon, color: appState.catEdit.color };
  try {
    const result = editId
      ? await api('PUT', `/categories/${editId}`, fields)
      : await api('POST', '/categories', fields);
    closeCatModal();
    if (_handleQueuedWrite(result, () => _applyCatLocally(editId ? 'PUT' : 'POST', editId, fields)))
      return;
    await loadCategories();
    renderCategories();
    await loadAndRender();
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      toast(tr('categories.exists'), 'error');
    } else {
      toast(tr('tx.saveFailed') + e.message, 'error');
    }
  }
}

// Mirror a category create/edit/delete into the in-memory list so an offline
// change shows immediately; the next sync reload reconciles it (see
// refreshDomainAfterSync). Display fields (icon/color) on transaction rows are
// resolved from this list via getCatById, so updating it is enough.
function _applyCatLocally(method, id, fields) {
  const list = appState.ledger.categories;
  if (method === 'DELETE') {
    const i = list.findIndex((c) => c.id === Number(id));
    if (i >= 0) list.splice(i, 1);
  } else if (method === 'PUT') {
    const c = list.find((x) => x.id === Number(id));
    if (c) Object.assign(c, fields);
  } else {
    list.push({ id: -Date.now(), ...fields }); // provisional id until sync
  }
  renderCategories();
  renderAll();
}

async function deleteCategoryEdit() {
  if (!appState.catEdit.id) return;
  const ok = await confirmAction({
    title: tr('categories.deleteConfirm'),
    confirmLabel: tr('common.delete'),
  });
  if (!ok) return;
  const editId = appState.catEdit.id;
  try {
    const result = await api('DELETE', `/categories/${editId}`);
    closeCatModal();
    if (_handleQueuedWrite(result, () => _applyCatLocally('DELETE', editId))) return;
    await loadCategories();
    renderCategories();
    await loadAndRender();
  } catch (e) {
    if (e && e.status === 409) {
      // Three distinct reasons land here; pick the right copy
      // so a user with a recurring rule isn't sent looking for
      // phantom transactions.
      if (e.detail && e.detail.includes('recurring')) {
        toast(tr('categories.deleteHasRecurring'), 'error');
      } else if (e.detail && e.detail.includes('goal')) {
        toast(tr('goals.categoryTaken'), 'error');
      } else {
        toast(tr('categories.deleteInUse'), 'error');
      }
    } else {
      toast(tr('tx.deleteFailed') + e.message, 'error');
    }
  }
}
