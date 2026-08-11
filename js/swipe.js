/**
 * Swipe a card to archive or delete it.
 *
 * The gesture people already have. Every list on the phone works this way, so nobody has
 * to be taught it, and it removes the two-step trip through the ⋯ menu for the two things
 * done most often.
 *
 * Three decisions worth recording, all of which were arrived at by getting them wrong
 * first in similar code:
 *
 *   A swipe must not become a tap. A card is a button, and a finger that moves 90px
 *   across it would otherwise both reveal an action and open the pass. The gesture claims
 *   the pointer once it is clearly horizontal and swallows the click that follows.
 *
 *   Vertical scrolling must win by default. Deciding direction on the first pointer move
 *   makes a list feel sticky, because a scroll that starts a few degrees off horizontal
 *   gets captured. Direction is judged once the finger has travelled far enough to mean
 *   something, and if it is vertical the gesture stands down for good.
 *
 *   Nothing destructive happens without a way back. Archive is reversible by definition.
 *   Delete is not, so rather than a modal — which turns a one-handed flick into a dialogue
 *   — the record is held aside and the toast offers Undo. The pass is only truly gone once
 *   the toast goes.
 */

import * as haptics from './haptics.js';

/** How far the finger must travel before we decide the gesture's direction. */
const DIRECTION_THRESHOLD = 10;

/** How far a card must be dragged for the action to commit on release. */
const COMMIT = 96;

/** Resistance past the commit point, so the card cannot be flung off the screen. */
const RESIST = 0.32;

/** A flick counts even when short, if it was fast. Pixels per millisecond. */
const FLICK_VELOCITY = 0.55;

const ICONS = {
  archive: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M3 6h18v3H3zM5 9v10h14V9M10 13h4"/></svg>',
  delete: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
};

/**
 * Wraps a card so it can be swiped, and returns the wrapper to put in the list.
 *
 * `labels` lets a past ticket offer "Restore" where an upcoming one offers "Archive" —
 * the same gesture, described honestly for what it will do.
 */
export function wrap(card, { archiveLabel = 'Archive' } = {}) {
  const row = document.createElement('div');
  row.className = 'swipe';

  row.innerHTML = `
    <div class="swipe-action archive" aria-hidden="true">${ICONS.archive}<span>${archiveLabel}</span></div>
    <div class="swipe-action delete" aria-hidden="true"><span>Delete</span>${ICONS.delete}</div>`;

  row.append(card);
  return row;
}

/**
 * Makes every `.swipe` inside `root` draggable.
 *
 * `onArchive` and `onDelete` receive the ticket id. Returning false from either aborts
 * the row's exit animation and lets the card spring back, which is what should happen if
 * the write failed — the list must never show a pass as gone while it is still stored.
 */
export function attach(root, { onArchive, onDelete } = {}) {
  root.addEventListener('pointerdown', (event) => {
    // Only a primary press, and never on the menu button sitting inside the card.
    if (event.button !== 0 || event.target.closest('[data-menu]')) return;

    const row = event.target.closest('.swipe');
    if (!row || row.classList.contains('leaving')) return;

    const card = row.querySelector('.card');
    if (!card) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const startTime = performance.now();

    let axis = null;       // null until decided, then 'x' or 'y'
    let offset = 0;
    let armed = null;      // which side has passed the commit point, for the haptic

    const archivePanel = row.querySelector('.swipe-action.archive');
    const deletePanel = row.querySelector('.swipe-action.delete');

    row.classList.remove('settling');

    const move = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (axis === null) {
        if (Math.abs(dx) < DIRECTION_THRESHOLD && Math.abs(dy) < DIRECTION_THRESHOLD) return;

        // A scroll that begins slightly off-horizontal must still scroll, so the vertical
        // case wins ties. Once it is a scroll we let go entirely rather than keep watching.
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') { finish(false); return; }

        row.classList.add('dragging');

        // The card is ours now. Without capture, a finger leaving the card mid-drag
        // silently strands it half-open.
        try { card.setPointerCapture(moveEvent.pointerId); } catch { /* not fatal */ }
      }

      // Past the commit point the card gives way, so the limit is felt rather than read.
      offset = Math.abs(dx) <= COMMIT
        ? dx
        : Math.sign(dx) * (COMMIT + (Math.abs(dx) - COMMIT) * RESIST);

      card.style.setProperty('--swipe', `${offset.toFixed(1)}px`);

      // Only the panel the gesture is heading towards is shown. Revealing both would say
      // the card is about to do two things at once.
      archivePanel?.classList.toggle('armed', offset > 0);
      deletePanel?.classList.toggle('armed', offset < 0);

      // One tick as the threshold is crossed, in either direction, the way a switch
      // clicks — it tells the user the release will do something before they let go.
      const side = Math.abs(offset) >= COMMIT ? Math.sign(offset) : null;
      if (side !== armed) {
        if (side) haptics.tap('select');
        armed = side;
      }
    };

    const finish = (release) => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', cancel);

      if (!release || axis !== 'x') {
        card.style.removeProperty('--swipe');
        row.classList.remove('dragging');
        return;
      }

      const elapsed = Math.max(1, performance.now() - startTime);
      const velocity = Math.abs(offset) / elapsed;
      const commit = Math.abs(offset) >= COMMIT || velocity >= FLICK_VELOCITY;

      row.classList.add('settling');

      if (!commit) {
        card.style.setProperty('--swipe', '0px');
        // Let the card get home before the colour goes, or the panel disappears from
        // under a card still sliding over it.
        setTimeout(() => row.classList.remove('dragging'), 280);
        return;
      }

      // Swipe right to archive, left to delete — matching the panel the gesture revealed.
      const action = offset > 0 ? onArchive : onDelete;
      const id = card.dataset.ticket;

      // The card leaves first and the row folds behind it, as one movement rather than a
      // jump followed by a fold. Both start now, not after the write returns: waiting on
      // IndexedDB left the card frozen mid-swipe for as long as the write took, which is
      // exactly the "no animation, it just says deleted" this was reported as.
      card.style.setProperty('--swipe', `${offset > 0 ? row.offsetWidth : -row.offsetWidth}px`);

      row.style.height = `${row.offsetHeight}px`;
      // Forces the height to be applied before it is changed, or there is nothing to
      // animate from and the row vanishes instantly.
      void row.offsetHeight;
      row.classList.add('leaving');

      Promise.resolve(action?.(id)).then((ok) => {
        // The write failed, so the pass is still there and must look it.
        if (ok === false) {
          row.classList.remove('leaving');
          row.style.removeProperty('height');
          card.style.setProperty('--swipe', '0px');
          setTimeout(() => row.classList.remove('dragging'), 280);
        }
      });
    };

    const up = () => finish(true);
    const cancel = () => finish(false);

    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', cancel);

    // A gesture that moved the card must not also open it. The click arrives after
    // pointerup, so it is caught once, in the capture phase, and discarded.
    card.addEventListener('click', (clickEvent) => {
      if (axis === 'x') { clickEvent.stopPropagation(); clickEvent.preventDefault(); }
    }, { capture: true, once: true });
  });
}

export { COMMIT, DIRECTION_THRESHOLD, FLICK_VELOCITY };
