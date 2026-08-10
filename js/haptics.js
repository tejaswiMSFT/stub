/**
 * Haptics and press feedback.
 *
 * The difference between an app and a web page is largely felt rather than seen: a card
 * that depresses under a thumb and springs back, a tap that answers with a tick of
 * vibration. Without it everything is technically responsive and feels inert.
 *
 * Two honest limitations, stated because they shape what is possible here:
 *
 *   1. **iOS Safari has no vibration API.** `navigator.vibrate` is not implemented and
 *      shows no sign of being. There is no workaround, so on iPhone the feedback is
 *      entirely visual — which is why the press animation matters more than the buzz.
 *   2. A vibration that fires on every touch becomes noise. Only deliberate, consequential
 *      actions get one: saving, deleting, an update arriving. Scrolling past a card does
 *      not.
 */

/** Whether the device can vibrate at all. Android can; iOS cannot. */
export function supported() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

const PATTERNS = {
  /** A single tick: something was selected. */
  select: 8,
  /** Slightly firmer: something was committed. */
  commit: [12],
  /** Two beats: something was destroyed, and should feel like it. */
  warn: [10, 40, 18],
  /** A rising pair: something succeeded. */
  success: [8, 30, 14],
};

/**
 * A short vibration, where the device offers one.
 *
 * Silently does nothing otherwise — this is a finishing touch, never a requirement, and
 * an app that depends on it would be broken on every iPhone.
 */
export function tap(kind = 'select') {
  if (!supported()) return;

  try {
    navigator.vibrate(PATTERNS[kind] ?? PATTERNS.select);
  } catch {
    // Some browsers refuse without a user gesture. Not worth a word.
  }
}

/**
 * Makes an element respond to touch.
 *
 * Applied through a class rather than a `:active` rule alone, because iOS Safari does
 * not reliably apply `:active` to arbitrary elements — the very platform this most needs
 * to work on. A touchstart listener is the only dependable route.
 *
 * Passive listeners throughout: this never prevents a scroll, so a card that is swiped
 * past presses briefly and releases rather than blocking the gesture.
 */
export function pressable(root = document) {
  const press = (event) => {
    const target = event.target.closest('[data-press], .card, .action, .row, .option, .primary');
    if (!target) return;
    target.classList.add('pressing');
  };

  const release = (event) => {
    const target = event.target.closest?.('.pressing') || root.querySelector?.('.pressing');
    if (target) target.classList.remove('pressing');
    for (const node of root.querySelectorAll?.('.pressing') || []) node.classList.remove('pressing');
  };

  root.addEventListener('touchstart', press, { passive: true });
  root.addEventListener('touchend', release, { passive: true });
  root.addEventListener('touchcancel', release, { passive: true });
  root.addEventListener('mousedown', press, { passive: true });
  root.addEventListener('mouseup', release, { passive: true });
  root.addEventListener('mouseleave', release, { passive: true });
}
