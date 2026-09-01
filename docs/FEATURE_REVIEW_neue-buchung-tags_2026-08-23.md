# Feature Review — "Neue Buchung" incl. tag selection

**Date:** 2026-08-23
**Feature:** Booking modal (create/edit) with tag field, suggestion row and tag picker
**Scope reviewed:**

| File                     | Lines | Relevant part                                                                          |
| ------------------------ | ----- | -------------------------------------------------------------------------------------- |
| `frontend/index.html`    | 1860  | 1137–1245 booking modal, 1246–1310 tag picker                                          |
| `frontend/booking.js`    | 291   | `openModal`, `addTransaction`, `closeModal`, `renderTagPills`                          |
| `frontend/categories.js` | 748   | `refreshTagSuggestions`, `renderTagSuggestions`, `openTagPickerFor`, `commitTagPicker` |
| `frontend/state.js`      | 217   | `appState.form`                                                                        |
| `frontend/styles.css`    | 4400  | `.tag-pill`, `.tag-suggestion`, `.tag-picker-chip`                                     |
| `backend/app/schemas.py` | —     | `TransactionBase` (`category_id: int`)                                                 |

**Basis:** [`DESIGN_CONVENTIONS.md`](../DESIGN_CONVENTIONS.md), [`CLAUDE.md`](../CLAUDE.md)

> Checkboxes to tick off while working through this. Order follows priority (critical → polish).

**Status 2026-08-23:** findings 1–8 (all critical and important) are implemented and verified
against a running instance. Finding 9 came along with 7 — it is a single `aria-live` attribute
and the two only work together. Findings 10 and 11 are still open.

Written in English per `CLAUDE.md` → Conventions → Language, which covers docs.

---

## Feature summary

The booking modal is the app's primary write path: the FAB opens it, the user enters amount, date, category, notes and tags, and one button saves. Tags are attached three ways — the frozen suggestion row under the tag field (top 10 by 90-day usage), the tag picker modal for the full list, and free creation inside that picker. The same modal serves editing, with a delete button appended.

The flow's skeleton is sound: one screen level, sensible defaults (today's date, first category, expense preselected), autofocus into the amount field, and genuinely good offline handling. The findings below are about what happens at the edges — after saving, on dismiss, and on error.

---

## User flow

```
1. Entry:        FAB (bottom right, ledger view) → modal opens, amount focused after 300 ms
                 or: tap a ledger row → same modal, prefilled, with a delete button
2. Main action:  amount → date → category → notes → tags
                 Tags via: suggestion row (one tap) or "+" → tag picker (stage, "Übernehmen")
3. In between:   no intermediate state — everything is in-memory, no spinner needed
4. Success:      modal closes; the ledger reloads
5. Return:       X in the header, or a tap on the backdrop
```

| Check                         | Result                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Entry reachable               | ✅ FAB, no scrolling, no menu                                                                                             |
| Primary action visible        | ✅ "Ausgabe speichern" pinned in the modal footer                                                                         |
| Return path without data loss | ❌ see finding 2                                                                                                          |
| Max. 3 screen levels          | ✅ ledger → modal → tag picker                                                                                            |
| Keyboard/input attributes     | ⚠️ amount is exemplary (`inputmode="decimal"`, `enterkeyhint`, `pattern`); notes field has no `enterkeyhint` (finding 11) |

---

## UI states

| State           | Present | Where / note                                                                                                                                                                                                                                              |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Empty**       | ⚠️      | Suggestion row hides itself when there are no tags (`.tag-suggestions:empty`), which is right. The picker shows "Keine Tags gefunden." to a user who has never created a tag — a search-failure message for something that was never searched. Finding 6. |
| **Loading**     | ✅      | Not applicable: the modal renders from in-memory state, no async gap                                                                                                                                                                                      |
| **Error**       | ❌      | Present but shows a raw technical code: `Fehler beim Speichern: API POST /transactions → 422`. Finding 3.                                                                                                                                                 |
| **Offline**     | ✅      | Exemplary — outbox enqueue, local mirroring via `_applyTxLocally`, `client_op_id` dedup, sync badge, clear toast                                                                                                                                          |
| **Success**     | ❌      | No confirmation at all. Invisible whenever the saved booking falls outside the displayed period. Finding 1.                                                                                                                                               |
| **Destructive** | ✅      | `confirmAction` with title, verb button and cancel                                                                                                                                                                                                        |

Verified against a running instance (Pixel 5 viewport, de-DE, light + dark).

---

## Critical

### [x] 1. Saving gives no feedback when the booking lands outside the displayed period

**Where:** `frontend/booking.js:199–215` (`addTransaction`, success path)

Reproduced: with the ledger on August 2026, saving a booking dated 2026-02-11 closes the modal, shows no toast, adds no visible row, and leaves the ledger on August. `GET /api/transactions?year=2026&month=2` confirms the booking exists. From the user's side the save is indistinguishable from a dismissal — the likely reaction is to enter it a second time.

The offline path toasts (`tx.queuedOffline`), the online path does not. The success state exists only implicitly, as "a new row appears", and that implication breaks for any date outside the current view — backdated receipts being the common case.

```js
// booking.js, after the online save succeeds
await Promise.all([loadAndRender(), loadTags()]);
toast(tr('tx.saved')); // new key, e.g. "Buchung gespeichert."
```

Worth deciding alongside: should the ledger jump to the saved booking's month? A toast is the minimum; jumping makes the result verifiable. Jumping alone is not enough — it silently moves the user somewhere they did not ask to be.

### [x] 2. The form is discarded without warning

**Where:** `frontend/booking.js:54–58` (`closeModal`), `:78–82` (`closeModalOutside`)

Reproduced: amount `42,50` and a note entered, tap the X → modal closes immediately, no confirmation; reopening shows empty fields. The backdrop tap does the same and is easy to hit by accident on a phone, since the modal does not span the full width.

`DESIGN_CONVENTIONS.md` asks for a return path _without data loss_. There is a return path, but it destroys input silently.

```js
function closeModal({ force = false } = {}) {
  if (!force && _bookingFormIsDirty() && !(await confirmAction({
    title: tr('tx.discardConfirm'),          // "Eingaben verwerfen?"
    confirmLabel: tr('tx.discard'),          // "Verwerfen"
    destructive: true,
  }))) return;
  …
}
```

`_bookingFormIsDirty()` compares amount/notes/tags against the state at open, so the common "opened by mistake, closed straight away" case stays a single tap. There is a 400 ms backdrop guard already (`bookingModalOpenedAt`) — the dirty check is the complement for the other end of the interaction.

### [x] 3. Error toasts carry the raw HTTP code

**Where:** `frontend/booking.js:231`, `:125`; keys `tx.saveFailed`, `tx.deleteFailed` in both bundles

`api()` builds `new Error('API ${method} ${path} → ${status}')` (`core.js:407`), and the toast concatenates it, producing:

> Fehler beim Speichern: API POST /transactions → 422

`DESIGN_CONVENTIONS.md` requires `[What happened.] [How to fix it.]` with no technical code. The message names neither cause nor remedy, and leaks the endpoint path.

`err.detail` already carries the backend's message and `err.status` the code, so the toast can branch:

```js
const msg =
  e.status === 422
    ? tr('tx.saveInvalid') // "Prüf Betrag, Datum und Kategorie."
    : e.status >= 500
      ? tr('tx.saveServerError') // "Server nicht erreichbar. Versuch es später noch einmal."
      : tr('tx.saveFailed'); // no longer a prefix — a full sentence
toast(msg, 'error');
console.warn('save failed', e); // technical detail to the console, not the toast
```

This also affects the `tx.saveFailed` / `tx.deleteFailed` keys, which currently end in `": "` and are written as prefixes.

---

## Important

### [x] 4. The tag pill's remove button is 30 × 31 px

**Where:** `frontend/styles.css` → `.tag-pill button`; measured in the running app

`DESIGN_CONVENTIONS.md:31` and `:457` require 44 × 44 px, "full stop". Every other control in the modal complies (measured: `#tagPickerBtn` 44×44, `.tag-suggestion` 68×44, `.type-btn` 169×44, `#submitBtn` 351×55, inputs 47–49 px tall). The × is the only one below, and it is a destructive control sitting between two others.

The rule already tries to compensate with `padding: var(--space-8); margin: calc(-1 * var(--space-8))`, it just does not reach far enough. Either raise the padding to `var(--space-12)` with the matching negative margin, or give the button a `min-width`/`min-height` of `var(--btn-chrome-size)` and keep the pill's visual height via a transparent hit box:

```css
.tag-pill button {
  min-width: var(--btn-chrome-size);
  min-height: var(--btn-chrome-size);
  padding: var(--space-8);
  margin: calc(-1 * var(--space-8));
}
```

The pill's own height must stay put — check the row does not grow.

### [x] 5. Category is mandatory in the backend but not validated in the client

**Where:** `frontend/booking.js:176–191`, `backend/app/schemas.py` → `TransactionBase.category_id: int`

The client validates only amount and date (`if (!amount || !date)`) and sends `category_id: cat || null`. With an empty category select — reachable when `loadCategories` failed offline on first boot, since it falls back to `categories = []` — the request is a 422, surfaced through finding 3 as an unreadable message.

Either validate before sending, with the same toast the other two fields get, or better: put the message under the field (finding 8) and disable the save button while the select is empty.

### [x] 6. Wrong empty state in the tag picker for a user with no tags

**Where:** `frontend/index.html:1303` (`#tagPickerChips`), key `tags.searchNone`

Verified with a freshly created account: the picker shows the "Vorhandene Tags" label, a search field and "Keine Tags gefunden." — although nothing was searched and nothing can be. The correct message already exists as `tags.none` ("Noch keine Tags vorhanden.") and is unused here.

Beyond the wording, the whole section is noise in that state: a search field over zero items. When `appState.ledger.availableTags.length === 0`, hide the "Vorhandene Tags" group entirely and let "Neuen Tag anlegen" stand alone — that is the only action available anyway. Keep `tags.searchNone` for the genuine no-match case.

### [x] 7. Keyboard focus leaves the suggestion row on every add

**Where:** `frontend/categories.js` → `renderTagSuggestions` (`box.innerHTML = …`)

Measured: focus a suggestion chip, press Enter — focus lands on an `<input>` rather than staying in the row. `innerHTML` replacement destroys the focused button, and since the chip is now `disabled`, focus cannot return to it either. Adding three tags by keyboard means tabbing back into the row three times.

Now that the row is frozen (PR #230), the fix is cheap — the chip keeps its index:

```js
const i = [...box.children].indexOf(document.activeElement);
box.innerHTML = …;
// after re-render: the next chip that can still be added
const next = [...box.children].find((el, n) => n >= i && !el.disabled) || box.children[i];
next?.focus();
```

### [x] 8. Validation errors appear as a toast, not under the field

**Where:** `frontend/booking.js:180–183`

`DESIGN_CONVENTIONS.md` prescribes label → input → error message under the field for forms. The booking modal instead shows one toast for two fields ("Gib Betrag und Datum ein.") and marks neither. On a filled form the user has to work out which field is meant, and the toast disappears on its own.

The auth views already do this correctly (`.auth-error` with `role="alert"` under the form, see `#forcePwError`) — the pattern exists and can be reused per field.

---

## Optional

### [x] 9. Tag changes are not announced

**Where:** `frontend/index.html:1183` (`#tagsWrap`)

Adding or removing a tag changes `#tagsWrap` without an `aria-live` region, and — see finding 7 — focus is gone by then. A screen-reader user gets no confirmation that the tag was attached. `aria-live="polite"` on the pill container would cover it; fix 7 first, since the two overlap.

### [ ] 10. The suggestion row does not say it is a selection

**Where:** `frontend/categories.js` → `refreshTagSuggestions`

The row shows the top 10 of possibly hundreds of tags with no indication that it is a cut. Users with few tags see everything and assume the row is complete; users with many will not find a tag they expect and may not realise the "+" leads to the full list. A quiet label above the row ("Häufig benutzt") would frame it — and would give the picker button an obvious counterpart.

### [ ] 11. Notes field has no `enterkeyhint`

**Where:** `frontend/index.html:1180` (`#inputDesc`)

The amount field sets `enterkeyhint="done"`, the picker's search sets `enterkeyhint="search"`. The notes field sets nothing, so iOS shows a generic return key. `enterkeyhint="done"` matches the amount field. It is not inside a `<form>`, so Enter does not submit either way — worth deciding whether it should.

---

## Verdict

**Revision needed** at the time of writing — for the flow as a whole, not for PR #230. Findings 1–8
have since been implemented; see the status note at the top.

The structure is right and the offline handling is above average for this kind of app. What is missing sits at the end of the interaction: after a successful save the user may see nothing (1), on dismissal input vanishes without a word (2), and when something does go wrong the message is an HTTP code (3). Those three concern the same thing — the flow tells the user very little about what it just did.

PR #230, currently open, is unaffected: its scope is the hover guard and the frozen suggestion row, both green and independent of the findings here. Findings 1–3 and 7 would fit a follow-up PR; 4, 5, 6, 8 are small enough to ride along with it.

| Priority  | Count  |
| --------- | ------ |
| Critical  | 3      |
| Important | 5      |
| Optional  | 3      |
| **Total** | **11** |
