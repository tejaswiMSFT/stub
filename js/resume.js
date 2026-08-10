/**
 * Surviving a lock, a timeout, or being swapped out.
 *
 * A phone locks. A screen times out. iOS in particular discards backgrounded web app
 * pages to reclaim memory, and Android will do the same under pressure. When the user
 * comes back, the page may have been quietly reloaded from scratch — and if that happens
 * while they are holding the phone out to be scanned, they are looking at a home screen
 * instead of a barcode, in front of a queue.
 *
 * So where the user was is written down, immediately and cheaply, and restored on the
 * next launch. Restoration is deliberately conservative: it only resumes somewhere the
 * user would want to be, and only if they were there recently. Reopening the app the
 * next morning to find yesterday's barcode filling the screen would be its own kind of
 * failure.
 *
 * sessionStorage rather than localStorage, so the position belongs to this launch and
 * not to the app forever — with one exception noted below.
 */

const KEY = 'stub.resume';

/**
 * Deliberate close versus involuntary discard.
 *
 * These must be told apart. A user who swipes the app away has finished, and should get
 * a clean start next time — restoring a barcode they dismissed would be presumptuous.
 * A user whose phone locked has not finished at all, and losing their place is a
 * failure.
 *
 * sessionStorage draws that line correctly on its own: it survives a lock and is cleared
 * on a deliberate close. The complication is that iOS sometimes discards a backgrounded
 * page outright to reclaim memory, which can take sessionStorage with it — an
 * involuntary loss that looks identical to a deliberate one.
 *
 * So the position is written to both. sessionStorage is authoritative; the localStorage
 * copy is a fallback used only when the page is known to have been discarded rather than
 * closed, and it is stamped so it can never resurrect something ancient.
 */
const BACKUP_KEY = 'stub.resume.discarded';

/**
 * How long a position stays worth restoring.
 *
 * Long enough to cover a lock, a phone call, checking an email, or the ten minutes
 * spent shuffling toward a barrier. Short enough that tomorrow is a fresh start.
 */
const MAX_AGE_MS = 30 * 60 * 1000;

/** Screens worth returning to. Transient ones are deliberately absent. */
const RESUMABLE = new Set(['home', 'pass', 'scan']);

/**
 * Records where the user is.
 *
 * Called on every navigation, so it must be cheap and must never throw: private
 * browsing refuses storage entirely, and failing to save a position is not a reason to
 * break the app.
 */
export function remember(screen, ticketId = null) {
  if (!RESUMABLE.has(screen)) {
    // Somewhere transient — mid-review, say. Clearing is right: resuming into a
    // half-finished form after a reload would show a draft that no longer exists.
    forget();
    return;
  }

  const position = JSON.stringify({ screen, ticketId, at: Date.now() });

  try {
    sessionStorage.setItem(KEY, position);
  } catch {
    // Storage unavailable. The app still works; it simply opens at home.
  }

  // Fallback copy, in case the page is discarded rather than closed. Only consulted
  // when sessionStorage is empty *and* the session is a fresh one, so a deliberate
  // close still yields a clean start.
  try {
    localStorage.setItem(BACKUP_KEY, position);
  } catch { /* nothing to do */ }
}

export function forget() {
  try {
    sessionStorage.removeItem(KEY);
  } catch { /* nothing to do */ }
  try {
    localStorage.removeItem(BACKUP_KEY);
  } catch { /* nothing to do */ }
}

/**
 * Where to resume, if anywhere.
 *
 * Returns null unless the position is recent, valid, and still points at a ticket that
 * exists — a ticket deleted on another tab, or purged by the retention policy since,
 * must not be reopened.
 */
export function resumePoint(tickets = []) {
  let stored = read(sessionStorage, KEY);

  // Nothing in this session. Either the user closed the app deliberately — in which
  // case a clean start is correct — or the page was discarded while backgrounded. The
  // fallback copy covers the second case, and the age check keeps it from resurrecting
  // a position from days ago.
  if (!stored) {
    const backup = read(localStorage, BACKUP_KEY);
    if (backup && Date.now() - (backup.at || 0) <= MAX_AGE_MS) stored = backup;
  }

  if (!stored || !RESUMABLE.has(stored.screen)) return null;
  if (Date.now() - (stored.at || 0) > MAX_AGE_MS) return null;

  if (stored.screen === 'home') return { screen: 'home', ticket: null };

  const ticket = tickets.find((record) => record.id === stored.ticketId);
  if (!ticket) return null;

  return { screen: stored.screen, ticket };
}

function read(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

/**
 * Notifies when the page returns from being hidden.
 *
 * Two events are needed, not one. `visibilitychange` covers a lock, a screen timeout or
 * an app switch where the page survived. `pageshow` with `persisted` covers the back
 * button and the browser's bfcache, where `visibilitychange` may not fire at all.
 *
 * The distinction matters for anything time-sensitive: a page hidden for four hours has
 * a stale idea of which journey is next, and needs to recompute rather than trust what
 * it last drew.
 */
export function onResume(handler) {
  let hiddenAt = null;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }

    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    handler({ awayMs: away, reason: 'visibility' });
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) handler({ awayMs: 0, reason: 'bfcache' });
  });
}

/**
 * Runs a callback when the page is about to be discarded.
 *
 * `pagehide` is the only event that fires reliably on iOS when a page is thrown away —
 * `beforeunload` and `unload` are not dependable there. Anything that must survive has
 * to be written by this point.
 */
export function onSuspend(handler) {
  window.addEventListener('pagehide', handler);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handler();
  });
}
