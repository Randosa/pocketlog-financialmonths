// Booking modal: the create/edit transaction form.
// Classic script — see index.html for load order.

// ── MODAL ─────────────────────────────────────────────────────────────────────
function openModal(tx) {
  rememberModalFocus('booking');
  appState.form.tags = tx?.tags ? tx.tags.slice() : [];
  document.getElementById('inputAmount').value =
    tx?.amount != null ? _formatAmountInput(Number(tx.amount)) : '';
  document.getElementById('inputDesc').value = tx?.desc || '';
  document.getElementById('inputDate').value = tx?.date || new Date().toISOString().split('T')[0];
  // Before setType: it re-ranks both choosers, and the category chooser has
  // to know the current selection before it decides what to put first.
  resetCatChooser('transaction', tx ? tx.category_id : null);
  setType(tx?.type || 'out', document.querySelector('.type-btn.out'));
  // Opening is the only moment the chip row is recomputed from scratch;
  // toggling a chip afterwards only recolours it (see resetTagChooser).
  resetTagChooser('transaction');
  document.querySelector('.modal h2').textContent = tx ? tr('tx.editTitle') : tr('tx.newTitle');
  // Amount label carries the active currency symbol; placeholder uses
  // the locale decimal separator.
  const lblAmount = document.getElementById('lblAmount');
  if (lblAmount)
    lblAmount.textContent = tr('tx.amount', { symbol: window.I18N ? I18N.currencySymbol() : '€' });
  document.getElementById('inputAmount').placeholder = _formatAmountInput(0);
  clearBookingFieldErrors();
  document.getElementById('deleteBtn').style.display = tx ? 'block' : 'none';
  document.getElementById('modalOverlay').classList.add('open');
  remeasureCatChooser('transaction');
  appState.nav.bookingModalOpenedAt = Date.now();
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('inputAmount').focus(), 300);
  document.getElementById('modalOverlay').dataset.editId = tx?.id || '';
  // Baseline for the unsaved-changes check in closeModal.
  appState.form.pristine = _bookingFormSnapshot();
  trapFocusIn(document.querySelector('#modalOverlay .modal'), 'booking');
}

// Serialised form state, compared against the snapshot taken at open to tell
// a discarded draft from an untouched modal.
function _bookingFormSnapshot() {
  return JSON.stringify({
    amount: document.getElementById('inputAmount').value.trim(),
    desc: document.getElementById('inputDesc').value.trim(),
    date: document.getElementById('inputDate').value,
    cat: appState.catChooser.transaction.selectedId,
    type: appState.form.type,
    tags: [...appState.form.tags].sort(),
  });
}
function _bookingFormIsDirty() {
  return appState.form.pristine != null && _bookingFormSnapshot() !== appState.form.pristine;
}

// Closing discards the draft, so an edited form asks first — the X, the
// backdrop and Escape all land here. Internal callers that close *after*
// persisting (save, delete, offline enqueue) pass force:true; without it they
// would prompt about changes they just wrote.
async function closeModal({ force = false } = {}) {
  if (!force && _bookingFormIsDirty()) {
    const discard = await confirmAction({
      title: tr('tx.discardTitle'),
      message: tr('tx.discardMessage'),
      confirmLabel: tr('tx.discardConfirm'),
      cancelLabel: tr('tx.keepEditing'),
      destructive: true,
    });
    if (!discard) return;
  }
  appState.form.pristine = null;
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  releaseFocusTrap('booking');
  restoreModalFocus('booking');
}

// ---- Field-level validation (label -> input -> message under the field) ----
const _BOOKING_ERROR_SLOTS = {
  inputAmount: 'errAmount',
  inputDate: 'errDate',
  catSearch: 'errCat',
};

function _setBookingFieldError(fieldId, msg) {
  const field = document.getElementById(fieldId);
  const slot = document.getElementById(_BOOKING_ERROR_SLOTS[fieldId]);
  if (!field || !slot) return;
  field.classList.toggle('is-invalid', !!msg);
  slot.textContent = msg || '';
  slot.hidden = !msg;
}

function clearBookingFieldErrors() {
  Object.keys(_BOOKING_ERROR_SLOTS).forEach((id) => _setBookingFieldError(id, ''));
}

// Bound on input/change so a correction clears its own message immediately.
function clearBookingFieldError(fieldId) {
  _setBookingFieldError(fieldId, '');
}
// Backdrop dismiss shared by every modal overlay. The delegation engine
// (core.js) binds `this` to the overlay carrying the data-action attribute —
// the click counts as "outside" exactly when it landed on the overlay itself
// rather than the dialog inside it. `closeFn` arrives as a global function
// name (data-args is JSON and can't carry a function reference); a direct
// function still works for JS callers like closeModalOutside.
function closeOnBackdrop(e, closeFn) {
  const overlay = this instanceof Element ? this : e.currentTarget;
  if (e.target !== overlay) return;
  const fn = typeof closeFn === 'string' ? window[closeFn] : closeFn;
  if (typeof fn === 'function') fn();
}
// Ledger rows open this modal on `pointerup` (the swipe handler).
// The browser then synthesizes a trailing `click` at the same spot,
// which now lands on the freshly shown overlay backdrop and would
// close the modal immediately (the "flicker, nothing happens, second
// tap works" bug). Ignore backdrop clicks for a brief window after
// opening so only a deliberate later tap dismisses it.
function closeModalOutside(e) {
  if (Date.now() - appState.nav.bookingModalOpenedAt < 400) return;
  // Forward `this` (the overlay) — closeOnBackdrop's outside check needs it.
  closeOnBackdrop.call(this, e, closeModal);
}
function editTransaction(id) {
  const num = Number(id);
  const pools = [appState.ledger.all, appState.reports.txPool, appState.ledger.transactions];
  for (const p of pools) {
    if (!p) continue;
    const t = p.find((t) => t.id === num);
    if (t) return openModal(t);
  }
  // If the TX is in no pool (e.g. it was just removed by a sync): don't
  // silently open the create form — show a notice.
  toast(tr('tx.notFound'));
}

// Offline-delete fallback shared by the swipe-to-delete row and the edit
// modal: when the DELETE failed at the network level, queue it in the outbox
// for the SW to replay and report that it was handled. Returns false for a
// real HTTP error (or no outbox), so the caller surfaces the original error
// instead. Gated on the error shape rather than navigator.onLine, which lies
// on iOS (reports online in airplane mode).
async function _enqueueOfflineDelete(id, err) {
  if (!_isOfflineWriteError(err) || !window.PocketLogOutbox) return false;
  await window.PocketLogOutbox.enqueue({ method: 'DELETE', path: `/transactions/${id}` });
  return true;
}

async function deleteCurrentTransaction() {
  const editId = document.getElementById('modalOverlay').dataset.editId;
  if (!editId) return;
  if (!(await confirmAction({ title: tr('tx.deleteConfirm'), confirmLabel: tr('common.delete') })))
    return;
  try {
    await api('DELETE', `/transactions/${editId}`);
    await closeModal({ force: true });
    await loadAndRender();
  } catch (e) {
    if (await _enqueueOfflineDelete(editId, e)) {
      await closeModal({ force: true });
      updateSyncBadge();
      return;
    }
    console.warn('delete failed', e);
    toast(e.status >= 500 ? tr('tx.deleteServerError') : tr('tx.deleteFailed'), 'error');
  }
}

function setType(type, btn) {
  appState.form.type = type;
  document.querySelectorAll('.type-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.type-btn.' + type).classList.add('active');
  document.getElementById('submitBtn').className = 'submit-btn' + (type === 'in' ? ' green' : '');
  document.getElementById('submitBtn').textContent =
    type === 'out' ? tr('tx.saveExpense') : tr('tx.saveIncome');
  // Both choosers rank against the type, so switching it changes what a good
  // suggestion is. Re-ranking here is not the frozen-order exception it looks
  // like: the order only freezes against *taps*, so a chip never moves under
  // the finger. Deliberately switching the type is a different intent.
  rerankChoosersForType('transaction');
}

// The amount field is type="text" so iOS shows the decimal keypad. The
// locale-aware parsing/formatting cores (_parseAmountWith/_formatAmountWith)
// live in utils.js; these wrappers only supply the I18N decimal separator.
function parseAmount(raw) {
  return _parseAmountWith(raw, window.I18N ? I18N.decimalSeparator() : ',');
}

// Display the amount in the input with the locale decimal separator
// so it matches the formatted output everywhere else (fmtCurrency).
function _formatAmountInput(n) {
  return _formatAmountWith(n, window.I18N ? I18N.decimalSeparator() : ',');
}

function normalizeAmountInput() {
  const inp = document.getElementById('inputAmount');
  const n = parseAmount(inp.value);
  if (!isNaN(n)) inp.value = _formatAmountInput(n);
}

async function addTransaction() {
  const amount = parseAmount(document.getElementById('inputAmount').value);
  const desc = document.getElementById('inputDesc').value.trim();
  const cat = catChooserValue('transaction');
  const date = document.getElementById('inputDate').value;
  // Errors go under their field, not into a toast that names neither.
  // category_id is required by the API, so it is checked here too — it used
  // to reach the server as null and come back as an unreadable 422.
  clearBookingFieldErrors();
  const invalid = [
    !amount && ['inputAmount', tr('tx.errAmount')],
    !date && ['inputDate', tr('tx.errDate')],
    !cat && ['catSearch', tr('tx.errCategory')],
  ].filter(Boolean);
  if (invalid.length) {
    invalid.forEach(([field, msg]) => _setBookingFieldError(field, msg));
    document.getElementById(invalid[0][0]).focus();
    return;
  }
  const body = {
    amount,
    desc,
    category_id: cat || null,
    date,
    type: appState.form.type,
    tags: appState.form.tags,
  };
  const editId = document.getElementById('modalOverlay').dataset.editId;
  const method = editId ? 'PUT' : 'POST';
  const path = editId ? `/transactions/${editId}` : '/transactions';
  // Tag every create with a client op-id so an offline replay that already
  // reached the server is deduplicated instead of creating a second row.
  // Edits (PUT) are idempotent by nature and need none.
  if (method === 'POST') body.client_op_id = _newOpId();
  try {
    const result = await api(method, path, body);
    mergeIntoAvailableTags(appState.form.tags, appState.form.type);
    await closeModal({ force: true });
    if (result && result.queued) {
      // Offline: the service worker queued the write (HTTP 202) instead of
      // reaching the server. Reloading now would pull the stale API cache and
      // make the save look reverted — so mirror the change into the in-memory
      // pools and re-render. The next sync (SYNC_DONE → loadAndRender)
      // reconciles with the server, replacing the provisional create row.
      _applyTxLocally(method, editId, body);
      renderAll();
      updateSyncBadge();
      toast(tr('tx.queuedOffline'));
      return;
    }
    await Promise.all([loadAndRender(), loadTags()]);
    // The new row is not proof on its own — a booking dated outside the
    // displayed period leaves the list untouched, and the save then looks
    // exactly like a dismissal.
    toast(tr(editId ? 'tx.updated' : 'tx.saved'));
  } catch (e) {
    if (_isOfflineWriteError(e) && window.PocketLogOutbox) {
      // Network-level failure (offline, or the write timed out and aborted)
      // and no active service worker to queue it — enqueue it ourselves and
      // reflect it locally, same as the 202 path above. A real HTTP error
      // (e.g. a 500) carries e.status and falls through to the toast instead.
      await window.PocketLogOutbox.enqueue({ method, path, body });
      mergeIntoAvailableTags(appState.form.tags, appState.form.type);
      _applyTxLocally(method, editId, body);
      await closeModal({ force: true });
      renderAll();
      updateSyncBadge();
      toast(tr('tx.queuedOffline'));
      return;
    }
    // The raw message is `API POST /transactions → 422` — useful in the
    // console, useless in a toast.
    console.warn('save failed', e);
    toast(
      e.status === 422
        ? tr('tx.saveInvalid')
        : e.status >= 500
          ? tr('tx.saveServerError')
          : tr('tx.saveFailed'),
      'error',
    );
  }
}

// Mirror a single create/edit into the in-memory transaction pools so an
// offline save shows immediately, before the service worker replays it.
// Mirrors _applyBulkLocally (ledger.js): only the ledger pools are touched —
// the report cache is already invalidated by api() on every non-GET. All
// display fields derive from category_id via getCatById, so updating the raw
// fields is enough.
function _applyTxLocally(method, editId, body) {
  const fields = {
    amount: Number(body.amount),
    desc: body.desc,
    category_id: body.category_id,
    date: body.date,
    type: body.type,
    tags: (body.tags || []).slice(),
  };
  if (method === 'PUT') {
    const id = Number(editId);
    [appState.ledger.transactions, appState.ledger.all].forEach((pool) => {
      if (!pool) return;
      const t = pool.find((x) => x.id === id);
      if (t) Object.assign(t, fields);
    });
    return;
  }
  // Create: there's no server id yet. A negative provisional id keeps the row
  // distinct from real ones until the next sync reload replaces it.
  const tx = { id: -Date.now(), source_rule_id: null, ...fields };
  // The month list is scoped to the displayed month, so only add it there when
  // its date falls in that month; otherwise it would render under a stray date.
  const [y, m] = body.date.split('-').map(Number);
  if (y === appState.view.year && m === appState.view.month + 1) {
    appState.ledger.transactions.push(tx);
  }
  if (appState.ledger.all) appState.ledger.all.push(tx);
}

// `type` is the booking's own type so the optimistic bump lands on the same
// side the server will count it on — otherwise the chips would re-rank the
// moment the next /api/tags load corrected us.
function mergeIntoAvailableTags(tags, type) {
  if (!Array.isArray(tags) || !tags.length) return;
  const lower = new Set(appState.ledger.availableTags.map((t) => t.toLowerCase()));
  const side = type === 'in' ? 'in' : 'out';
  let changed = false;
  for (const t of tags) {
    const v = (t || '').trim().toLowerCase();
    if (!v) continue;
    const use = _tagUse(v);
    tagCounts.set(v, { ...use, all: use.all + 1, [side]: use[side] + 1 });
    if (!lower.has(v)) {
      appState.ledger.availableTags.push(v);
      lower.add(v);
      changed = true;
    }
  }
  if (changed) {
    appState.ledger.availableTags.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    renderTagList();
  }
}
