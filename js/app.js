/**
 * Application controller.
 *
 * Holds the screen state and wires the modules together. All real work lives elsewhere;
 * this file decides what the user sees and makes sure nothing doubtful passes unchecked.
 *
 * Two principles run through it:
 *
 *   Friction is proportional to doubt. A value read from a barcode is stated as fact; a
 *   value guessed from a photograph is put as a question. Flagging everything would
 *   produce verification fatigue, and then nothing gets checked at all.
 *
 *   The app opens to the journey that is next. Not a list, not a dashboard — the ticket
 *   about to be needed, one tap from its barcode. Everything else is secondary.
 */

import { ingest, ingestFromDataTransfer, describeSource } from './ingest.js';
import { readBarcodesFromSource, formatLabel, keepBarcodeImage } from './barcode.js';
import { buildLines, linesFromOcr } from './text.js';
import { extract } from './adapters/index.js';
import { extractBrand } from './brand.js';
import { derivePalette, walletColors, glyphFor, buildSvg } from './artwork.js';
import { Confidence, Source } from './model.js';
import { IngestError } from './errors.js';
import * as store from './store.js';
import * as code from './barcode-render.js';
import * as prefs from './settings.js';
import * as wakelock from './wakelock.js';
import * as resume from './resume.js';
import * as updates from './update.js';
import * as haptics from './haptics.js';
import * as swipe from './swipe.js';
import { helpPages } from './help.js';
import { markSvg, wordmarkSvg, svgUrl, brand } from './brand-identity.js';
import { BUILD } from './build.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['landing', 'home', 'pass', 'scan', 'add', 'working', 'review', 'help', 'settings'];

const state = {
  tickets: [],
  draft: null,
  brand: null,
  seedColor: null,
  viewing: null,
  helpPage: 0,
  installPrompt: null,
  screen: null,
  history: [],
};

// ────────────────────────────── platform ──────────────────────────────

/**
 * What the platform can actually do.
 *
 * Feature-detected wherever possible, but installation genuinely cannot be: there is no
 * capability to test for "this browser can add to the home screen". Two facts force
 * user-agent sniffing here, and they are worth stating plainly.
 *
 * On iOS every browser is WebKit underneath, but Apple exposes "Add to Home Screen"
 * through Safari alone. A user in Chrome on an iPhone will hunt for an install option
 * that does not exist, so they must be told to open the page in Safari instead.
 *
 * On Android and desktop, Chrome, Edge, Brave, Opera and Samsung Internet all install
 * properly. Firefox is the outlier — no install prompt on desktop, and a limited one on
 * Android — so it gets its own wording rather than instructions that lead nowhere.
 */
const platform = (() => {
  const ua = navigator.userAgent;

  const iOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);

  // Order matters: several of these include "Chrome" or "Safari" in their own strings.
  const brave = Boolean(navigator.brave);
  const edge = /Edg[A-Z]?\//.test(ua);
  const opera = /OPR\/|Opera/.test(ua);
  const samsung = /SamsungBrowser/.test(ua);
  const firefox = /Firefox\/|FxiOS/.test(ua);
  const chrome = !edge && !opera && !brave && !samsung && /Chrome\/|CriOS/.test(ua);
  const safari = !chrome && !edge && !opera && !firefox && !samsung
    && /Safari\//.test(ua) && !/Chrome\//.test(ua);

  // On iOS, the only browser that can install is Safari — whatever the wrapper claims.
  const iosNonSafari = iOS && (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) || (!safari && !/Safari\//.test(ua)));

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  return {
    iOS,
    android,
    standalone,
    firefox,
    iosNonSafari,
    name: brave ? 'Brave' : edge ? 'Edge' : opera ? 'Opera' : samsung ? 'Samsung Internet'
      : firefox ? 'Firefox' : chrome ? 'Chrome' : safari ? 'Safari' : 'your browser',
    // Whether a real install prompt is even possible here.
    canPrompt: !iOS && !firefox,
    canShare: Boolean(navigator.share),
    touch: navigator.maxTouchPoints > 0,
  };
})();

// ────────────────────────────── screens ──────────────────────────────

function show(name, { remember = true } = {}) {
  if (remember && state.screen && state.screen !== name) state.history.push(state.screen);

  for (const screen of SCREENS) {
    const element = $(`screen-${screen}`);
    if (element) element.hidden = screen !== name;
  }

  state.screen = name;
  window.scrollTo(0, 0);

  // Written down on every navigation, so that a page discarded while the phone is
  // locked can come back to the same place rather than the home screen.
  resume.remember(name, state.viewing?.id || null);

  // The scan view is white regardless of theme, so the browser chrome must follow or
  // the effect is spoiled by a black notch area.
  setThemeColour(name === 'scan' ? '#ffffff' : null);
}

function back() {
  const previous = state.history.pop() || 'home';
  show(previous, { remember: false });
}

// ────────────────────────────── start ──────────────────────────────

async function start() {
  registerServiceWorker();
  initTheme();
  wire();
  haptics.pressable(document);

  state.tickets = await store.all().catch(() => []);
  await applyRetention();

  // Where the user was, if the page was discarded while the phone was locked. Checked
  // before anything else decides what to show.
  const resumeTo = resume.resumePoint(state.tickets);

  if (resumeTo) {
    renderHome();
    if (resumeTo.screen === 'home') {
      show('home', { remember: false });
    } else {
      state.viewing = resumeTo.ticket;
      renderPass(resumeTo.ticket);
      state.history = ['home'];
      if (resumeTo.screen === 'scan') openScan(resumeTo.ticket);
      else show('pass', { remember: false });
    }
    if (platform.standalone) requestPersistence();
  } else if (platform.standalone || state.tickets.length) {
    // The landing page is for browsers. Once installed, the app opens to the tickets —
    // showing a marketing page to someone who has already installed it would be absurd.
    renderHome();
    show('home', { remember: false });
    if (platform.standalone) requestPersistence();
  } else {
    renderLanding();
    show('landing', { remember: false });
  }

  watchLifecycle();
  handleLaunchIntent();
  announceUpdate();
}

/**
 * Tells the user when the app has changed under them.
 *
 * Updates apply silently and at a safe moment, which is right — nobody should be
 * interrupted, least of all at a barrier. But an app that quietly rearranges itself is
 * unsettling: something looks different and the user is left wondering whether they
 * did it. One line afterwards turns that into a courtesy.
 *
 * Deliberately not shown on a first run, and never while a ticket is on screen.
 */
function announceUpdate() {
  const previous = updates.consumeUpdatedFrom(BUILD.version);
  if (!previous) return;

  // A resumed session may have opened straight onto a pass. The notice can wait.
  if (document.querySelector('#screen-pass:not([hidden]), #screen-scan:not([hidden])')) return;

  setTimeout(() => {
    toast('Stub was updated.', {
      detail: `Now on version ${BUILD.version}. Your tickets are exactly as you left them.`,
      tone: 'good',
    });
  }, 900);
}

/**
 * Keeps the app correct across locks, timeouts and being swapped out.
 *
 * Coming back is not the same as never having left. A page hidden for hours has a stale
 * idea of which journey is next — the "in 2 hours" it last drew may now be "happening
 * now", or already past — so anything time-dependent is recomputed rather than trusted.
 *
 * The screen the user was on is deliberately left alone. Someone who locked their phone
 * while showing a barcode wants that barcode when they unlock, not to be helpfully
 * returned to a list.
 */
function watchLifecycle() {
  resume.onResume(async ({ awayMs }) => {
    // A brief glance away changes nothing worth recomputing.
    if (awayMs < 30000) return;

    state.tickets = await store.all().catch(() => state.tickets);
    await applyRetention();

    if (state.screen === 'home') {
      renderHome();
    } else if (state.screen === 'pass' && state.viewing) {
      // The ticket may have been removed on another tab, or purged while we were away.
      const current = state.tickets.find((record) => record.id === state.viewing.id);
      if (current) {
        state.viewing = current;
        renderPass(current);
      } else {
        state.viewing = null;
        renderHome();
        show('home', { remember: false });
      }
    }
    // 'scan' is deliberately untouched: the barcode is already drawn and correct, and
    // redrawing it under the user's hand at a barrier would be actively unhelpful.
  });

  // The wake lock is dropped by the browser whenever the page hides, so it has to be
  // reclaimed on return — otherwise the screen starts dimming again mid-queue.
  resume.onSuspend(() => {
    if (state.screen !== 'scan') wakelock.release();
  });
}

/**
 * Applies the retention policy.
 *
 * Runs on open and nowhere else. Deleting on a timer would need a background process,
 * and a background process would need a server — which there is not, and will not be.
 * Opening the app is also the only moment the user is present to be told.
 *
 * Does nothing at all under the default policy, which keeps everything.
 */
async function applyRetention() {
  const expired = prefs.expiredTickets(state.tickets);
  if (!expired.length) return;

  for (const ticket of expired) {
    await store.remove(ticket.id).catch(() => {});
  }
  state.tickets = await store.all().catch(() => state.tickets);

  toast(`${expired.length} past ticket${expired.length === 1 ? '' : 's'} removed.`, {
    detail: 'As set in Settings. Change it there whenever you like.',
  });
}

/**
 * Handles being opened by a shortcut or a share.
 *
 * Android can send a ticket straight from Gmail into the app. iOS cannot — Safari does
 * not implement Web Share Target — which is the main place this feels less polished
 * there, and is stated plainly in the help rather than hidden.
 */
function handleLaunchIntent() {
  const params = new URLSearchParams(location.search);
  const action = params.get('action');

  if (action === 'add') {
    openAdd();
  } else if (action === 'share') {
    // The service worker stashes a shared file; nothing to do here yet beyond opening
    // the add screen so the user is not left staring at the home screen.
    openAdd();
  }

  if (action) history.replaceState(null, '', location.pathname);
}

/**
 * Registers the service worker and keeps the app current.
 *
 * See js/update.js for why this never blocks: an app whose job is showing a ticket at a
 * barrier must not refuse to run because a newer version exists somewhere on a network
 * the user cannot reach.
 */
async function registerServiceWorker() {
  updates.configure({
    // Safe means nothing would be lost by reloading. A pass on screen is the clear no —
    // it may be under a scanner at this very moment. Mid-review is also no, since the
    // user has typed corrections that only exist in memory.
    safeToReload: () => {
      const showing = document.querySelector('#screen-pass:not([hidden])');
      const reviewing = document.querySelector('#screen-review:not([hidden])');
      const working = document.querySelector('#screen-working:not([hidden])');
      return !showing && !reviewing && !working && !state.draft;
    },

    onUpdateReady: () => {
      toast('An update is ready.', {
        detail: 'Your tickets are kept exactly as they are.',
        tone: 'good',
        action: 'Tap to restart',
        onTap: () => updates.apply(),
      });
    },
  });

  await updates.start();
}

async function requestPersistence() {
  try {
    const result = await store.requestPersistence();
    if (result.supported && !result.persisted) {
      // Not fatal, but the user should know their tickets are only best-effort, and be
      // nudged toward an export rather than discovering the loss later.
      state.persistenceRefused = true;
    }
  } catch { /* not supported; nothing to do */ }
}

// ────────────────────────────── landing ──────────────────────────────

function renderLanding() {
  const card = $('install-card');

  // The wordmark is generated rather than an image file, so the name and mark are never
  // separately positioned and cannot drift apart.
  $('landing-wordmark').innerHTML = wordmarkSvg({ height: 40, colour: 'currentColor' });

  if (platform.standalone) {
    card.innerHTML = '';
    return;
  }

  if (platform.iosNonSafari) {
    // Apple exposes Add to Home Screen through Safari alone, so pointing at the current
    // browser's menu would send the user looking for something that is not there.
    //
    // A page cannot switch browsers for them: there is no API, and the old URL schemes
    // that once did it (x-safari-https:) were closed years ago and now fail silently. A
    // button that appears to do it and does nothing is worse than a clear instruction —
    // so the user is given the two things that genuinely help, a share sheet (which
    // offers "Open in Safari" directly) and a copyable link.
    card.innerHTML = `
      <div class="install-steps">
        <p class="install-lead">Open this page in Safari</p>
        <p class="install-body">
          On iPhone and iPad, only Safari can add an app to the Home Screen —
          ${escapeHtml(platform.name)} cannot, whichever browser you normally use.
        </p>
        <div class="install-actions">
          ${platform.canShare ? '<button class="primary" id="share-link" type="button">Open in Safari…</button>' : ''}
          <button class="ghost-button" id="copy-link" type="button">Copy the link</button>
        </div>
        <p class="install-body small">
          Then in Safari: ${shareGlyph()} <strong>Share</strong> — or <strong>⌄</strong> at
          the end of the address bar — then <strong>Add to Home Screen</strong>.
        </p>
      </div>`;

    $('copy-link')?.addEventListener('click', copyLink);
    $('share-link')?.addEventListener('click', shareLink);
  } else if (platform.iOS) {
    // iOS 18 moved Share off the toolbar and into a menu behind a chevron at the end of
    // the address bar. Naming only the toolbar sends most people hunting for a button
    // that is not there, so both are described — newer layout first.
    card.innerHTML = `
      <div class="install-steps">
        <p class="install-lead">Add it to your Home Screen</p>
        <ol>
          <li>Tap <strong>⌄</strong> at the end of the address bar, or ${shareGlyph()} <strong>Share</strong> in the toolbar</li>
          <li>Scroll and tap <strong>Add to Home Screen</strong></li>
          <li>Tap <strong>Add</strong></li>
        </ol>
      </div>`;
  } else if (state.installPrompt) {
    card.innerHTML = '<button class="primary big" id="do-install" type="button">Install</button>';
    $('do-install').addEventListener('click', install);
  } else if (platform.firefox) {
    card.innerHTML = `
      <div class="install-steps">
        <p class="install-lead">Add it to your Home Screen</p>
        <p class="install-body">
          Firefox${platform.android ? '' : ' on the desktop'} offers only limited support for
          installing apps like this. It works perfectly well in the browser, or you can use
          Chrome, Edge or Brave to install it properly.
        </p>
        ${platform.android ? '<ol><li>Open the menu and choose <strong>Install</strong> or <strong>Add to Home screen</strong></li></ol>' : ''}
      </div>`;
  } else {
    card.innerHTML = `
      <div class="install-steps">
        <p class="install-lead">Add it to your Home Screen</p>
        <ol>
          <li>Open ${escapeHtml(platform.name)}'s menu${platform.touch ? '' : ', or look for the install icon in the address bar'}</li>
          <li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong></li>
        </ol>
      </div>`;
  }

  // The QR code is for the laptop-to-phone handoff: someone reading about this on a
  // desktop needs it on the device they actually travel with.
  if (!platform.touch) renderHandoffCode();
}

function shareGlyph() {
  return `<svg class="inline-glyph" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path d="M12 3.4v11.2M12 3.4 8.4 7M12 3.4 15.6 7" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M6.2 11.4H5a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7.2a1 1 0 0 0-1-1h-1.2"
          fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

async function renderHandoffCode() {
  try {
    const canvas = $('qr-canvas');
    await code.render(canvas, { format: 'QRCode', text: location.href.split('?')[0] }, { targetWidth: 180 });
    $('qr-handoff').hidden = false;
  } catch {
    // A missing QR code is cosmetic; the link still works.
  }
}

async function install() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  const { outcome } = await state.installPrompt.userChoice;
  state.installPrompt = null;
  if (outcome === 'accepted') toast('Installed. Look for it on your home screen.');
}

/**
 * Hands the link to the system share sheet.
 *
 * On iOS the sheet includes "Open in Safari", which is the closest anything can get to
 * switching browsers on the user's behalf — the choice stays theirs, which is as it
 * should be.
 */
async function shareLink() {
  try {
    await navigator.share({
      title: brand.name,
      text: 'Keep your tickets on your phone',
      url: location.href.split('?')[0],
    });
  } catch {
    // Dismissing the sheet throws. Not an error worth reporting.
  }
}

async function copyLink() {
  const url = location.href.split('?')[0];

  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.', { detail: 'Paste it into Safari to install.' });
  } catch {
    // Clipboard access can be refused. Falling back to a selectable field means the
    // user can still copy it by hand rather than being told it failed.
    const field = document.createElement('input');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:300;font-size:16px;padding:12px;width:80vw';
    document.body.appendChild(field);
    field.select();

    try {
      document.execCommand('copy');
      toast('Link copied.', { detail: 'Paste it into Safari to install.' });
    } catch {
      toast('Copy the address from the bar above.', { tone: 'bad' });
    }
    setTimeout(() => field.remove(), 100);
  }
}

// ────────────────────────────── home ──────────────────────────────

/**
 * Archives a ticket, or restores one already archived.
 *
 * Archiving only moves a pass into Past — nothing is discarded — so it needs no
 * confirmation and no undo beyond swiping the other way.
 */
async function archiveTicket(id) {
  const ticket = state.tickets.find((t) => t.id === id);
  if (!ticket) return false;

  const archiving = !ticket.archived;

  try {
    await store.save({ ...ticket, archived: archiving });
  } catch {
    toast('That could not be saved.', { tone: 'bad' });
    return false;
  }

  state.tickets = await store.all();
  haptics.tap('select');
  toast(archiving ? 'Moved to Past.' : 'Restored.');

  // After the row has finished leaving, so the list does not redraw underneath it.
  setTimeout(renderHome, 260);
  return true;
}

/**
 * Deletes a ticket, with a way back.
 *
 * The ⋯ menu asks first, because there the user chose "Delete" from a list and a
 * confirmation is the natural second half of that choice. A swipe is different: it is one
 * quick movement, often one-handed, and interrupting it with a modal would defeat the
 * point of the gesture. So this deletes immediately and offers Undo instead, which is
 * both faster when meant and kinder when not.
 *
 * The record is kept in memory until the toast goes, and restored wholesale — including
 * its barcode and its id — so an undone delete is genuinely the same pass and not a copy
 * that lost something on the way.
 */
async function deleteTicketWithUndo(id) {
  const ticket = state.tickets.find((t) => t.id === id);
  if (!ticket) return false;

  try {
    await store.remove(id);
  } catch {
    toast('That could not be deleted.', { tone: 'bad' });
    return false;
  }

  state.tickets = await store.all();
  haptics.tap('warn');

  toast('Deleted.', {
    detail: 'That pass has been removed from this device.',
    action: 'Tap to undo',
    timeout: 7000,
    onTap: async () => {
      await store.save(ticket);
      state.tickets = await store.all();
      renderHome();
      toast('Restored.');
    },
  });

  setTimeout(renderHome, 260);
  return true;
}

function renderHome() {
  const body = $('home-body');
  const { upcoming, past } = store.partition(state.tickets);

  // The mark beside the name. Drawn once and left alone.
  const mark = $('home-mark');
  if (mark && !mark.childElementCount) mark.innerHTML = markSvg({ size: 30 });

  if (!state.tickets.length) {
    // No button here. A "+" already sits in the bar above, and offering two controls for
    // one action makes the user choose between identical things. The empty state says
    // what is true and points at the control that already exists.
    body.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="42" height="42">
            <path d="M3.4 6.6h17.2a1 1 0 0 1 1 1v2.6a.8.8 0 0 1-.6.8 2 2 0 0 0 0 3.9.8.8 0 0 1 .6.8v2.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1v-2.6a.8.8 0 0 1 .6-.8 2 2 0 0 0 0-3.9.8.8 0 0 1-.6-.8V7.6a1 1 0 0 1 1-1z"
                  fill="none" stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </div>
        <h2>You have no saved tickets</h2>
        <p class="muted">Tap <span class="inline-plus" aria-hidden="true">+</span> above to add a boarding pass, a train ticket, or a booking.</p>
      </div>`;
    return;
  }

  const next = upcoming[0] || null;
  const later = upcoming.slice(1);

  body.innerHTML = `
    ${next ? `<div class="next-block">
      <p class="section-label">${nextLabel(next)}</p>
      ${cardMarkup(next, { large: true })}
    </div>` : ''}

    ${later.length ? `<div class="list-block">
      <p class="section-label">Later</p>
      ${later.map((ticket) => cardMarkup(ticket)).join('')}
    </div>` : ''}

    ${past.length ? `<details class="past-block">
      <summary>Past <span class="count">${past.length}</span></summary>
      ${past.map((ticket) => cardMarkup(ticket, { dim: true })).join('')}
    </details>` : ''}

    ${state.persistenceRefused ? `<p class="caution">
      Your browser has not guaranteed to keep this data. Export a backup from Settings to be safe.
    </p>` : ''}
  `;

  // Each card is wrapped after the fact rather than in `cardMarkup`, because the same
  // markup is used on the pass screen and in the review preview, where a swipe would be
  // meaningless.
  for (const card of body.querySelectorAll('.card[data-ticket]')) {
    const ticket = state.tickets.find((t) => t.id === card.dataset.ticket);
    const parent = card.parentNode;
    const after = card.nextSibling;
    parent.insertBefore(swipe.wrap(card, {
      archiveLabel: ticket?.archived ? 'Restore' : 'Archive',
    }), after);
  }

  for (const element of body.querySelectorAll('[data-ticket]')) {
    element.addEventListener('click', () => openPass(element.dataset.ticket));
  }
}

/** Says how soon, in the terms a person would use rather than a formatted timestamp. */
function nextLabel(ticket) {
  if (ticket.departsAt == null) return 'Upcoming';

  const diff = ticket.departsAt - Date.now();
  const hours = diff / 3600000;

  if (diff < 0) return 'Happening now';
  if (hours < 1) return `In ${Math.max(1, Math.round(diff / 60000))} minutes`;
  if (hours < 24) return `In ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  return 'Upcoming';
}

function cardMarkup(ticket, { large = false, dim = false } = {}) {
  const palette = paletteFor(ticket);
  const colours = walletColors(palette);
  const f = ticket.fields || {};

  const route = f.origin && f.destination
    ? `<div class="card-route">
         <span class="place">${escapeHtml(f.origin)}</span>
         <span class="arrow">${transitGlyph(ticket.transitType)}</span>
         <span class="place">${escapeHtml(f.destination)}</span>
       </div>`
    : `<div class="card-route">
         <span class="card-kind" aria-hidden="true">${kindGlyph(ticket.kind, ticket.transitType)}</span>
         <span class="place single">${escapeHtml(f.title || f.property || f.provider || 'Ticket')}</span>
       </div>`;

  // A stay is summarised by its window, a journey by its service and departure. Sharing
  // one line left every hotel card blank below the name.
  const detail = (ticket.kind === 'lodging'
    ? [
      formatDate(f.checkIn),
      f.checkOut ? `→ ${formatDate(f.checkOut)}` : '',
      f.nights ? `${f.nights} ${f.nights === '1' ? 'night' : 'nights'}` : '',
    ]
    : [
      f.service || f.flight,
      formatDate(f.date),
      f.departureTime,
    ]).filter(Boolean).join(' · ');

  // Falling back to the booking reference is not filler. A pass we could only read the
  // barcode from — a screenshotted cinema ticket, typically — has no service, date or
  // time to show, and the card was left as a title floating in an empty rectangle. The
  // reference is the one fact we do hold, and it is the thing a person is actually asked
  // to quote at a counter, so it earns the line.
  const summary = escapeHtml(detail || f.reference || '');

  const seat = ticket.kind === 'lodging'
    ? (f.room ? escapeHtml(f.room) : '')
    : (f.seat ? `${f.coach ? `${escapeHtml(f.coach)} · ` : ''}${escapeHtml(f.seat)}` : '');

  return `
    <button class="card ${large ? 'large' : ''} ${dim ? 'dim' : ''}" data-ticket="${escapeAttr(ticket.id)}"
            style="--card-bg:${colours.backgroundColor};--card-fg:${colours.foregroundColor};--card-label:${colours.labelColor};--card-deep:${palette.deep};--card-lift:${palette.lift}">
      <div class="card-head">
        <span class="card-provider">${escapeHtml(f.provider || '')}</span>
        ${(ticket.barcode || ticket.barcodeImage) ? '<span class="card-chip">Scannable</span>' : ''}
      </div>
      ${route}
      ${(summary || seat) ? `<div class="card-foot">
        <span class="card-detail">${summary}</span>
        ${seat ? `<span class="card-seat">${seat}</span>` : ''}
      </div>` : ''}
    </button>`;
}

function paletteFor(ticket) {
  return derivePalette({
    category: ticket.kind,
    // A stay is recognised by its property, so the palette is seeded from that rather
    // than from the booking agent — otherwise every hotel booked through one agent
    // comes out the same colour.
    title: ticket.fields?.property || ticket.fields?.provider || ticket.fields?.title || '',
    seedColor: ticket.colours?.seed || null,
  });
}

// ────────────────────────────── the ticket ──────────────────────────────

/**
 * The menu behind "⋯" on a ticket.
 *
 * It used to go straight to a delete confirmation, which is a trap: a menu affordance
 * must open a menu. The only thing between a stray tap and losing a boarding pass was a
 * dialog people dismiss by reflex.
 *
 * Editing is here because there was previously no way to correct a saved ticket at all.
 * Someone who spotted a wrong departure time had to delete the ticket and start again —
 * which is precisely the moment they are least inclined to trust the app.
 */
function openPassMenu() {
  const ticket = state.viewing;
  if (!ticket) return;

  const sheet = document.createElement('div');
  sheet.className = 'action-sheet';
  sheet.innerHTML = `
    <div class="action-backdrop" data-close="1"></div>
    <div class="action-panel" role="dialog" aria-label="Ticket options">
      <button class="action" data-act="edit" type="button">Edit details</button>
      <button class="action" data-act="sources" type="button">Metadata</button>
      <button class="action" data-act="export" type="button">Export this ticket</button>
      <button class="action danger" data-act="delete" type="button">Delete ticket</button>
    </div>`;

  document.body.appendChild(sheet);

  const close = () => sheet.remove();

  sheet.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-close], [data-act]');
    if (!target) return;

    if (target.dataset.close) { close(); return; }

    const action = target.dataset.act;
    close();

    if (action === 'edit') {
      editTicket(ticket);
      return;
    }

    if (action === 'sources') {
      showSources(ticket);
      return;
    }

    if (action === 'export') {
      await exportBackup([ticket]);
      return;
    }

    if (action === 'delete') {
      // Destructive, and the only irreversible thing here, so it still asks — but now as
      // the deliberate end of a choice rather than the whole of it.
      if (!confirm('Delete this ticket? This cannot be undone.')) return;
      haptics.tap('warn');
      await store.remove(ticket.id);
      state.tickets = await store.all();
      state.viewing = null;
      renderHome();
      show('home', { remember: false });
      toast('Ticket deleted.');
    }
  });
}

/**
 * Reopens a saved ticket in the review screen.
 *
 * The review screen already knows how to present and correct every field, so editing is
 * the same screen rather than a second implementation that would drift from it. Saving
 * updates the existing record instead of creating another.
 */
function editTicket(ticket) {
  const draft = store.toDraft(ticket);
  if (!draft) {
    toast('This ticket cannot be edited.', { tone: 'bad' });
    return;
  }

  state.draft = draft;
  state.editingId = ticket.id;
  renderReview();
  show('review');
}

/**
 * Where each detail on a ticket came from.
 *
 * Kept out of the way, because it answers a question most people never ask — but when
 * something looks wrong it is the first thing worth seeing, so it must be somewhere.
 */
function showSources(ticket) {
  const fields = ticket.fields || {};
  const rows = Object.entries(ticket.provenance || {})
    .filter(([key]) => fields[key])
    .map(([key, meta]) =>
      `<div><dt>${escapeHtml(meta.label || key)}</dt><dd>${escapeHtml(sourceLabel(meta))}</dd></div>`)
    .join('');

  const sheet = document.createElement('div');
  sheet.className = 'action-sheet';
  sheet.innerHTML = `
    <div class="action-backdrop" data-close="1"></div>
    <div class="action-panel sources" role="dialog" aria-label="Metadata">
      <div class="sources-body">
        <h2>Metadata</h2>
        <p class="sources-note">Where each detail came from.</p>
        <dl class="detail-list subtle">${rows || '<div><dt>Nothing recorded</dt><dd></dd></div>'}</dl>
      </div>
      <button class="action cancel" data-close="1" type="button">Done</button>
    </div>`;

  document.body.appendChild(sheet);
  sheet.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) sheet.remove();
  });
}

function openPass(id) {
  const ticket = state.tickets.find((record) => record.id === id);
  if (!ticket) return;

  state.viewing = ticket;
  renderPass(ticket);
  show('pass');
}

/**
 * The ticket in full.
 *
 * Front carries only what a gate agent checks; everything else sits below under its own
 * heading. Nothing extracted is ever discarded — if it does not belong on the front, it
 * goes further down, never nowhere.
 */
/**
 * Whether a field should still be marked uncertain on the face of the pass.
 *
 * A value the user confirmed or typed is settled, whatever our own confidence was when
 * we read it. Marking it anyway — a "?" beside a date the user had explicitly told us
 * was right — makes the review step look ignored, and teaches people that answering the
 * app changes nothing.
 */
function isUnsure(ticket, key) {
  const provenance = ticket.provenance?.[key];
  if (!provenance) return false;
  if (provenance.confirmed || provenance.edited) return false;
  return provenance.confidence === Confidence.LOW;
}

/**
 * The artwork band across the top of a pass.
 *
 * artwork.js draws a composition per category — a darkened auditorium for cinema, sky
 * for a flight, the amber of a railway — and every one of them was going unused, leaving
 * passes as flat blocks of colour. They are used directly as SVG rather than rasterised:
 * sharp at any size, and nothing to download or store.
 */
function passArtwork(ticket, palette) {
  // Lodging has no composition of its own, so it borrows the neutral one — but keeps its
  // own hue, which is what the palette already carries.
  const category = ticket.kind === 'lodging' ? 'event' : ticket.kind;
  const svg = buildSvg({ slot: 'strip', category, palette, scrim: true });
  if (!svg) return '';

  // The composition is drawn at Wallet's strip ratio, which is much wider than the band
  // it fills here. `object-fit` does not apply to an inline SVG, so it is told to crop
  // rather than letterbox through its own attribute.
  const cropped = svg.replace('<svg ', '<svg preserveAspectRatio="xMidYMid slice" ');

  return `<div class="pass-art" aria-hidden="true">${cropped}</div>`;
}

function renderPass(ticket) {
  const palette = paletteFor(ticket);
  const colours = walletColors(palette);
  const f = ticket.fields || {};

  // What names the pass. A stay is identified by the property, not by the agent who
  // sold it: "MakeMyTrip" on the face of a hotel pass tells a guest nothing they need
  // at a reception desk. A film or an event is named by its title, for the same reason —
  // "Ticket" in the bar is true and useless.
  const heading = ticket.kind === 'lodging'
    ? (f.property || f.provider || 'Stay')
    : (f.provider || f.title || 'Ticket');

  $('pass-title').textContent = heading;

  const primary = f.origin && f.destination
    ? `<div class="pass-route">
         <div class="endpoint">
           <span class="code">${escapeHtml(f.origin)}</span>
           ${ticket.originName ? `<span class="place-name">${escapeHtml(ticket.originName)}</span>` : ''}
         </div>
         <div class="pass-glyph">${transitGlyph(ticket.transitType)}</div>
         <div class="endpoint right">
           <span class="code">${escapeHtml(f.destination)}</span>
           ${ticket.destinationName ? `<span class="place-name">${escapeHtml(ticket.destinationName)}</span>` : ''}
         </div>
       </div>`
    : `<div class="pass-route">
         <div class="endpoint">
           <span class="pass-kind" aria-hidden="true">${kindGlyph(ticket.kind, ticket.transitType)}</span>
           <span class="code single">${escapeHtml(f.title || f.property || f.provider || 'Ticket')}</span>
         </div>
       </div>`;

  // The golden-rule fields: what is actually checked at a barrier.
  //
  // A journey and a stay are checked on different things, so the list differs by kind.
  // Sharing one list put a hotel's check-in and check-out — the only two dates that
  // matter to a guest — on the back of the pass, behind everything else.
  const golden = (ticket.kind === 'lodging' ? [
    ['checkIn', 'Check-in', formatDate(f.checkIn)],
    ['checkInTime', 'From', f.checkInTime],
    ['checkOut', 'Check-out', formatDate(f.checkOut)],
    ['checkOutTime', 'By', f.checkOutTime],
    ['nights', 'Nights', f.nights],
    ['guest', 'Guest', f.guest],
    ['room', 'Room', f.room],
    ['party', 'Guests', f.party],
    ['reference', 'Booking ID', f.reference],
  ] : ticket.kind === 'generic' ? [
    // Nothing was understood beyond the code itself, so the reference is the whole of
    // what we can honestly show.
    ['reference', 'Booking ID', f.reference],
  ] : [
    ['service', ticket.kind === 'flight' ? 'Flight' : ticket.kind === 'bus' ? 'Service' : 'Train', f.service || f.flight],
    ['date', 'Date', formatDate(f.date)],
    ['departureTime', 'Departs', f.departureTime],
    ['passenger', 'Passenger', f.passenger],
    ['coach', 'Coach', f.coach],
    ['seat', seatLabel(ticket), f.seat],
    ['berthPosition', 'Berth', f.berthPosition],
    ['screen', 'Screen', f.screen],
    ['pnr', ticket.kind === 'rail' ? 'PNR' : 'Booking', f.pnr],
    ['gate', 'Gate', f.gate],
    ['terminal', 'Terminal', f.terminal],
  ]).filter(([, , value]) => value);

  // Everything else belongs on the back.
  const shown = new Set([
    'origin', 'destination', 'provider', 'title', 'property',
    ...golden.map(([key]) => key),
  ]);
  const rest = Object.entries(f)
    .filter(([key, value]) => value && !shown.has(key))
    .map(([key, value]) => [ticket.provenance?.[key]?.label || key, value]);

  $('pass-scroll').innerHTML = `
    <div class="pass-card" style="--card-bg:${colours.backgroundColor};--card-fg:${colours.foregroundColor};--card-label:${colours.labelColor};--card-deep:${palette.deep};--card-lift:${palette.lift}">
      ${passArtwork(ticket, palette)}
      ${primary}
      <div class="pass-grid">
        ${golden.map(([key, label, value]) => `
          <div class="pass-field ${isUnsure(ticket, key) ? 'unsure' : ''}">
            <span class="k">${escapeHtml(label)}</span>
            <span class="v">${escapeHtml(value)}</span>
          </div>`).join('')}
      </div>

      ${(ticket.barcode || ticket.barcodeImage) ? `
        <button class="show-code" id="show-code" type="button">
          <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
            <path d="M3 4v16M6.5 4v16M10 4v11M13.5 4v16M17 4v11M20.5 4v16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
          </svg>
          Show the code
        </button>` : `
        <p class="no-code">This ticket has no barcode — many bookings don't. Your booking reference is above.</p>`}
    </div>

    ${ticket.allSeats?.length > 1 ? `
      <section class="pass-section">
        <h2>All seats</h2>
        <p class="section-body">${escapeHtml(ticket.allSeats.join(', '))}</p>
      </section>` : ''}

    ${ticket.passengers?.length > 1 ? `
      <section class="pass-section">
        <h2>All passengers</h2>
        <ol class="passenger-list">
          ${ticket.passengers.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}
        </ol>
      </section>` : ''}

    ${rest.length ? `
      <section class="pass-section">
        <h2>Details</h2>
        <dl class="detail-list">
          ${rest.map(([label, value]) => `
            <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
        </dl>
      </section>` : ''}

    ${ticket.warnings?.length ? `
      <section class="pass-section caution-section">
        <h2>Worth checking</h2>
        ${ticket.warnings.map((w) => `<p class="section-body">${escapeHtml(w)}</p>`).join('')}
      </section>` : ''}

    <!--
      Where each detail came from is diagnostic, not something a traveller needs while
      holding the pass. It moved behind the "..." menu, where someone checking our
      working can find it and everyone else is not made to scroll past it.
    -->

    <p class="pass-disclaimer">
      Made on your device from a ticket you supplied. Not issued by the operator — keep
      your original with you.
    </p>
  `;

  const button = $('show-code');
  if (button) button.addEventListener('click', () => {
    // Requested here, inside the tap itself.
    //
    // Safari grants a wake lock only during a user gesture, and openScan is async — by
    // the time it reached the request, several awaits had passed and the gesture was
    // over, so the lock was silently denied and the screen dimmed anyway. Asking on the
    // click keeps it within the gesture the browser requires.
    if (prefs.settings().keepAwake) wakelock.acquire();
    openScan(ticket);
  });
}

/**
 * What to call the seat.
 *
 * On an Indian rail ticket "M1 / 17 / LOWER" the 17 is the seat number and LOWER is the
 * kind of berth it is. This returned "Berth" for the number whenever a position had also
 * been read, which produced two fields both headed BERTH — one holding a number, one
 * holding a word. That is not a distinction anyone should have to work out at a train
 * door. The number is a seat; the position is the berth.
 */
function seatLabel() {
  return 'Seat';
}

function sourceLabel(meta) {
  if (meta.edited) return 'You entered this';
  return {
    [Source.BARCODE]: 'From the barcode',
    [Source.PDF_TEXT]: 'From the PDF text',
    [Source.OCR]: 'Read from the image',
    [Source.INFERRED]: 'Worked out',
    [Source.USER]: 'You entered this',
  }[meta.source] || 'Unknown';
}

// ────────────────────────────── scan view ──────────────────────────────

/**
 * The barcode, as large as the screen allows, on white.
 *
 * White regardless of theme, and deliberately so: a web page cannot raise screen
 * brightness the way a native wallet can, so the largest possible white field is the
 * only compensation available.
 *
 * Nothing else is on screen. The close button is hidden until the screen is tapped,
 * because this is the one moment in the app that should carry no distraction at all —
 * and because a button permanently under the thumb is a button that gets pressed while
 * the phone is being handed to someone. It reappears on a tap and fades again after a
 * few seconds.
 */
let controlsTimer = null;

async function openScan(ticket) {
  show('scan');

  const canvas = $('scan-canvas');
  const reference = $('scan-reference');
  const note = $('scan-note');

  reference.textContent = ticket.fields?.pnr || ticket.fields?.reference || '';
  note.textContent = 'Tap anywhere to enlarge it';

  // Never opens zoomed, whatever was left from last time.
  canvas.classList.remove('zoomed');

  // Controls start hidden: the user has just tapped to get here, so they know how they
  // arrived and do not need a way out presented to them immediately.
  $('screen-scan').classList.remove('controls');
  clearTimeout(controlsTimer);

  try {
    // A decoded barcode is redrawn from its own bytes, which is sharpest. If we cannot
    // draw that symbology, the picture we kept is used instead — the original pixels,
    // which scan just as well and are more faithful than any re-encoding.
    if (ticket.barcode) {
      try {
        await code.render(canvas, ticket.barcode, {
          targetWidth: Math.min(window.innerWidth - 24, 900),
        });

        if (canvas.width / canvas.height > 2.5 && window.innerHeight > window.innerWidth) {
          rotateCanvasUpright(canvas);
        }
        return;
      } catch (error) {
        if (!ticket.barcodeImage?.image) throw error;
        // Fall through to the kept picture.
      }
    }

    if (ticket.barcodeImage?.image) {
      await drawKeptBarcode(canvas, ticket.barcodeImage);
      return;
    }

    throw new Error('This ticket has no code to show.');
  } catch (error) {
    note.textContent = error.message;
  }
}

/**
 * Turns a canvas a quarter turn, in place.
 *
 * Its width and height swap, so the element occupies the space it actually needs and
 * nothing has to be nudged around it.
 */
function rotateCanvasUpright(canvas) {
  const source = document.createElement('canvas');
  source.width = canvas.width;
  source.height = canvas.height;
  source.getContext('2d').drawImage(canvas, 0, 0);

  canvas.width = source.height;
  canvas.height = source.width;

  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.save();
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(source, 0, 0);
  context.restore();
}

/**
 * Draws a kept barcode picture as large and as crisply as the screen allows.
 *
 * Smoothing is switched off deliberately: a barcode is hard edges, and interpolating
 * between them is exactly what stops a scanner reading it.
 */
async function drawKeptBarcode(canvas, kept) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('The saved code could not be shown.'));
    image.src = kept.image;
  });

  const target = Math.min(window.innerWidth - 24, 900);
  const scale = target / image.width;

  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);

  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
}

function revealScanControls() {
  const screen = $('screen-scan');
  screen.classList.add('controls');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => screen.classList.remove('controls'), 4000);
}

function closeScan() {
  clearTimeout(controlsTimer);
  wakelock.release();
  back();
}

// ────────────────────────────── adding ──────────────────────────────

function openAdd() {
  $('dz-hint').textContent = platform.iOS
    ? 'PDF, a photo, or a saved email'
    : 'PDF, a photo, or a saved email — or share one straight into this app';

  $('paste-hint').innerHTML = platform.touch
    ? ''
    : `Ticket only in an email? Copy it and press <kbd>${platform.iOS ? '⌘' : 'Ctrl'}</kbd>+<kbd>V</kbd>.`;

  show('add');
}

const STEPS = [
  ['read', 'Reading the file'],
  ['barcode', 'Finding the barcode'],
  ['identify', 'Working out what kind of ticket this is'],
  ['compose', 'Putting it together'],
];

async function handleSource(loader, description) {
  try {
    $('steps').innerHTML = STEPS.map(([id, label]) => `<li data-step="${id}">${escapeHtml(label)}</li>`).join('');
    $('working-detail').textContent = description || 'This happens on your device.';
    show('working');

    step('read', 'active');
    const ingested = await loader();
    step('read', 'done');

    step('barcode', 'active');
    const barcodes = await readBarcodesFromSource(ingested);
    step('barcode', 'done');

    let lines = [];
    if (ingested.textItems?.length) lines = buildLines(ingested.textItems);
    else if (ingested.ocrWords?.length) lines = linesFromOcr(ingested.ocrWords, { scale: ingested.displayScale || 1 });

    step('identify', 'active');
    const draft = await extract({ lines, barcode: barcodes.primary, ingested });
    step('identify', 'done');

    // Always keep a picture of the barcode, even when it decoded.
    //
    // Decoding tells us what a barcode says; it does not guarantee we can draw it again.
    // An Air India ticket decoded well enough for every field to be marked as coming
    // from the barcode, then failed at the one moment it mattered, because its symbology
    // is not one we can redraw — leaving a pass that claimed a barcode and showed none.
    //
    // The kept image costs little and removes that whole class of failure: whatever
    // happens, there is something to hold up, and it is the original pixels.
    const kept = await keepBarcodeImage(ingested).catch(() => null);
    if (kept) draft.barcodeImage = kept;

    if (!barcodes.primary && kept) {
      draft.warnings.push(
        'We could not read the code on this ticket, so it is kept exactly as it was '
        + 'printed. It should still scan — hold the screen up as you would the original.'
      );
    }

    if (!lines.length) {
      // Only when nothing else has already explained it. A kept barcode image raises its
      // own warning, and saying the same thing twice in different words reads as a fault
      // in the app rather than a fact about the ticket.
      const alreadySaid = draft.warnings.some((w) => /printed text|kept exactly/i.test(w));
      if (!alreadySaid) {
        draft.warnings.push(barcodes.primary
          ? 'We read the barcode but not the printed text, so most details need filling in.'
          : 'We could not read any text or barcode from this. You can fill the details in yourself.');
      }
    }
    if (barcodes.unsupported?.length && !barcodes.primary) {
      draft.warnings.push(`A ${formatLabel(barcodes.unsupported[0].format)} was found, which we cannot redraw.`);
    }

    step('compose', 'active');
    state.draft = draft;
    state.brand = ingested.barcodeCanvas ? await extractBrand(ingested.barcodeCanvas).catch(() => null) : null;
    state.seedColor = state.brand?.readable?.background || state.brand?.seedColor || null;
    renderReview();
    step('compose', 'done');

    // Release the rendered pages.
    //
    // A PDF rendered at decoding resolution is tens of megabytes of canvas, and an
    // image can be worse. Holding those after extraction serves nothing and is exactly
    // the sort of thing that gets a web app killed in the background on a phone with
    // little memory — which would then lose the user's place at a gate. Setting the
    // dimensions to zero frees the backing store immediately rather than waiting on the
    // garbage collector.
    releaseCanvases(ingested);

    show('review', { remember: false });
    state.history = ['home'];
  } catch (error) {
    fail(error);
  }
}

/** Frees the pixel buffers held by an ingested document. */
function releaseCanvases(ingested) {
  if (!ingested) return;

  // Wrapped whole. Freeing memory is housekeeping that happens *after* a ticket has been
  // read successfully, so nothing in here may be allowed to throw away that result — a
  // failure to tidy up is not a failure to read the ticket.
  try {
    for (const key of ['barcodeCanvas', 'displayCanvas']) {
      const canvas = ingested[key];
      if (canvas && typeof canvas.width === 'number') {
        canvas.width = 0;
        canvas.height = 0;
      }
      ingested[key] = null;
    }

    for (const candidate of ingested.barcodeCandidates || []) {
      if (candidate?.canvas) {
        candidate.canvas.width = 0;
        candidate.canvas.height = 0;
        candidate.canvas = null;
      }
    }

    // pdf.js holds a worker and a parsed document until told otherwise.
    ingested.cleanup?.();
  } catch (error) {
    console.warn('Releasing memory after reading the ticket failed; continuing.', error);
  }
}

function step(id, status) {
  const item = document.querySelector(`[data-step="${id}"]`);
  if (!item) return;
  item.classList.toggle('active', status === 'active');
  if (status === 'done') { item.classList.remove('active'); item.classList.add('done'); }
}

/**
 * Tells the user something went wrong, without showing them a library's stack trace.
 *
 * An IngestError carries language written for a person. Anything else is a bug, and its
 * raw message — "undefined is not a function" — tells the user nothing and blames their
 * file for our mistake. Those get a plain sentence and an offer to copy the details,
 * because the one thing worse than a bug is a bug nobody can report: this exact failure
 * cost a round trip when the message was truncated on screen and could not be read.
 */
function fail(error) {
  const isIngest = error instanceof IngestError;

  if (isIngest) {
    toast(error.message, { detail: error.hint || '', tone: 'bad' });
  } else {
    toast('Something went wrong reading that file.', {
      detail: 'This is a bug, not something you did.',
      tone: 'bad',
      action: 'Tap to copy the details',
      onTap: () => copyDiagnostics(error),
    });
  }

  show('add', { remember: false });
  console.error(error);
}

/**
 * Puts the failure on the clipboard, with the browser it happened in.
 *
 * A bug that only appears on one engine is invisible without knowing which engine, and
 * a phone offers no console to read.
 */
async function copyDiagnostics(error) {
  const report = [
    `Stub — error report`,
    `when: ${new Date().toISOString()}`,
    `build: ${BUILD.version}`,
    `browser: ${navigator.userAgent}`,
    `error: ${error?.name || 'Error'}: ${error?.message || String(error)}`,
    error?.stack ? `stack:\n${error.stack}` : '',
  ].filter(Boolean).join('\n');

  try {
    await navigator.clipboard.writeText(report);
    toast('Details copied.', {
      detail: 'Send them to the developer — they say exactly what went wrong.',
      tone: 'good',
    });
  } catch {
    // Clipboard access can be refused; showing the text is the fallback that always works.
    window.prompt('Copy these details and send them to the developer:', report);
  }
}

// ────────────────────────────── review ──────────────────────────────

/**
 * The kinds a user can pick from when we could not work it out ourselves.
 *
 * Offered only for a `generic` draft — one where a barcode was read but nothing else,
 * which in practice means a screenshotted cinema or event ticket. There is no OCR, so the
 * app genuinely cannot know what it is looking at, and guessing would be worse than
 * asking.
 *
 * The choice is not cosmetic. `kind` decides the colour, the glyph, the icon and the
 * wording throughout, all of which already existed and none of which could ever be
 * reached while every unrecognised ticket stayed `generic`.
 */
const PICKABLE_KINDS = [
  ['movie', 'Film'],
  ['concert', 'Concert'],
  ['theatre', 'Theatre'],
  ['sport', 'Sport'],
  ['conference', 'Conference'],
  ['event', 'Something else'],
];

/** What the big line on the pass should be called, once we know what kind it is. */
const TITLE_LABELS = {
  movie: 'Film',
  concert: 'Artist',
  theatre: 'Production',
  sport: 'Fixture',
  conference: 'Event',
  event: 'Title',
};

function kindPickerMarkup(draft) {
  // Only where we admitted we did not know. A flight that was read confidently must not
  // invite the user to relabel it as a film.
  if (draft.type !== 'generic' && !PICKABLE_KINDS.some(([id]) => id === draft.type)) return '';

  return `
    <section class="review-group">
      <h2>What kind of ticket is this?</h2>
      <p class="group-note">
        We read the code but not the page, so this is yours to tell us. It sets the
        artwork and how the pass is described.
      </p>
      <div class="kind-picker">
        ${PICKABLE_KINDS.map(([id, label]) => `
          <button class="kind-option ${draft.type === id ? 'on' : ''}" data-kind="${id}" type="button">
            <span class="kind-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">${glyphFor(id)}</svg>
            </span>
            <span>${label}</span>
          </button>`).join('')}
      </div>
    </section>`;
}

function renderReview() {
  const draft = state.draft;
  const needing = draft.fieldsNeedingReview;
  const rest = draft.list().filter((field) => !field.needsReview && field.value);

  $('review-save').disabled = needing.length > 0;

  $('review-scroll').innerHTML = `
    ${draft.warnings.length ? `<div class="notice">
      ${draft.warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join('')}
    </div>` : ''}

    ${needing.length ? `
      <section class="review-group urgent">
        <h2>Please check these</h2>
        <p class="group-note">We were not certain, and these are the ones that matter at the gate.</p>
        ${needing.map(fieldMarkup).join('')}
      </section>` : `
      <div class="all-clear">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="m4 12.4 5.2 5.2L20 7" fill="none" stroke="currentColor" stroke-width="2.2"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Everything read cleanly.
      </div>`}

    ${kindPickerMarkup(draft)}

    ${passengersMarkup(draft)}

    <section class="review-group">
      <h2>Details</h2>
      ${rest.map(fieldMarkup).join('')}
    </section>
  `;

  wireReview();
}

/**
 * The full passenger list, editable.
 *
 * Shown whenever a booking covers more than one traveller, and always editable. A family
 * booking is exactly where extraction is least reliable and where a quiet omission costs
 * the most — someone discovering at the desk that a child is missing from the pass has
 * been failed badly. Names can be corrected, removed, and added by hand.
 */
function passengersMarkup(draft) {
  const people = draft.passengers || (draft.value('passenger') ? [draft.value('passenger')] : []);
  if (people.length < 2 && !draft.value('passenger')) return '';

  return `
    <section class="review-group">
      <h2>${people.length > 1 ? `Passengers · ${people.length}` : 'Passenger'}</h2>
      ${people.length > 1
        ? '<p class="group-note">This booking covers several people. Check that everyone is here.</p>'
        : ''}
      <div id="passenger-rows">
        ${people.map((name, index) => `
          <div class="passenger-row">
            <input type="text" value="${escapeAttr(name)}" data-passenger="${index}"
                   autocapitalize="characters" autocomplete="off" spellcheck="false"
                   aria-label="Passenger ${index + 1}">
            <button class="row-remove" data-remove-passenger="${index}" type="button"
                    aria-label="Remove passenger ${index + 1}">
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>`).join('')}
      </div>
      <button class="chip" id="add-passenger" type="button">Add someone</button>
    </section>`;
}

function fieldMarkup(field) {
  // A value the user has confirmed or typed is settled, whatever our confidence was when
  // we read it. Showing "Unsure" beside a field they explicitly approved says their
  // answer was ignored — which is exactly how it felt, because `confirmed` was set and
  // then never looked at again.
  const badge = field.edited
    ? '<span class="badge edited">Edited</span>'
    : field.confirmed
      ? '<span class="badge good">Confirmed</span>'
      : field.source === Source.BARCODE
        ? '<span class="badge good">Barcode</span>'
        : field.confidence === Confidence.LOW || field.confidence === Confidence.MISSING
          ? `<span class="badge warn">${field.value ? 'Unsure' : 'Missing'}</span>`
          : '';

  const issues = field.issues
    .filter((issue) => issue.severity !== 'info')
    .map((issue) => `<p class="issue">${escapeHtml(issue.message)}</p>`)
    .join('');

  const options = field.options?.length
    ? `<div class="chips">${field.options.map((option) =>
      `<button class="chip" data-set="${escapeAttr(field.key)}" data-value="${escapeAttr(option)}">${escapeHtml(option)}</button>`).join('')}</div>`
    : '';

  const conflict = field.issues.find((issue) => issue.code === 'conflict');
  const actions = conflict
    ? `<div class="chips">
         <button class="chip" data-set="${escapeAttr(field.key)}" data-value="${escapeAttr(conflict.alternative)}">Use “${escapeHtml(conflict.alternative)}”</button>
         <button class="chip good" data-confirm="${escapeAttr(field.key)}">Keep “${escapeHtml(field.value)}”</button>
       </div>`
    : (field.needsReview && field.value
      ? `<div class="chips"><button class="chip good" data-confirm="${escapeAttr(field.key)}">That's right</button></div>`
      : '');

  const type = field.type === 'date' ? 'date' : field.type === 'time' ? 'time' : 'text';

  return `
    <div class="field ${field.critical ? 'critical' : ''}">
      <div class="field-head">
        <label for="f-${escapeAttr(field.key)}">${escapeHtml(field.label)}</label>
        ${badge}
      </div>
      <input id="f-${escapeAttr(field.key)}" type="${type}" value="${escapeAttr(field.value)}"
             data-input="${escapeAttr(field.key)}" enterkeyhint="done"
             autocapitalize="characters" autocomplete="off" spellcheck="false">
      ${issues}
      ${field.note ? `<p class="note">${escapeHtml(field.note)}</p>` : ''}
      ${options}
      ${actions}
    </div>`;
}

function wireReview() {
  for (const input of document.querySelectorAll('[data-input]')) {
    input.addEventListener('change', (event) => {
      state.draft.get(event.target.dataset.input)?.setByUser(event.target.value);
      renderReview();
    });
  }
  for (const button of document.querySelectorAll('[data-set]')) {
    button.addEventListener('click', () => {
      state.draft.get(button.dataset.set)?.setByUser(button.dataset.value);
      renderReview();
    });
  }
  for (const button of document.querySelectorAll('[data-confirm]')) {
    button.addEventListener('click', () => {
      haptics.tap('select');
      state.draft.get(button.dataset.confirm)?.confirm();
      renderReview();
    });
  }

  // ── What kind of ticket ──
  for (const button of document.querySelectorAll('[data-kind]')) {
    button.addEventListener('click', () => {
      haptics.tap('select');
      const kind = button.dataset.kind;
      state.draft.type = kind;

      // The title's prompt should ask for the right thing. "Title" is what we say when we
      // do not know; once the user has told us it is a film, asking for the film's name
      // is both clearer and a small acknowledgement that they were listened to.
      const title = state.draft.get('title');
      if (title) {
        title.label = TITLE_LABELS[kind] || 'Title';
        title.note = title.value ? title.note : `Please add the ${(TITLE_LABELS[kind] || 'title').toLowerCase()}.`;
      }

      renderReview();
    });
  }

  // ── Passengers ──
  const people = () => {
    const draft = state.draft;
    if (!draft.passengers) {
      draft.passengers = draft.value('passenger') ? [draft.value('passenger')] : [];
    }
    return draft.passengers;
  };

  // The first passenger and the `passenger` field are the same value seen two ways, so
  // they are kept in step rather than allowed to disagree.
  const sync = () => {
    const list = people();
    const field = state.draft.get('passenger');
    if (list.length) field.setByUser(list[0]);
    else field.setByUser('');
  };

  for (const input of document.querySelectorAll('[data-passenger]')) {
    input.addEventListener('change', (event) => {
      const list = people();
      list[Number(event.target.dataset.passenger)] = event.target.value.trim();
      state.draft.passengers = list.filter(Boolean);
      sync();
      renderReview();
    });
  }

  for (const button of document.querySelectorAll('[data-remove-passenger]')) {
    button.addEventListener('click', () => {
      const list = people();
      list.splice(Number(button.dataset.removePassenger), 1);
      state.draft.passengers = list;
      sync();
      renderReview();
    });
  }

  $('add-passenger')?.addEventListener('click', () => {
    const list = people();
    list.push('');
    state.draft.passengers = list;
    renderReview();
    // Put the cursor in the row just added, so a name can be typed without hunting.
    const rows = document.querySelectorAll('[data-passenger]');
    rows[rows.length - 1]?.focus();
  });
}

async function saveDraft() {
  try {
    // Editing reuses this path, so an existing ticket keeps its id and is replaced
    // rather than duplicated.
    const record = store.fromDraft(state.draft, {
      source: describeSource(state.draft.ingested || {})?.label,
      id: state.editingId || null,
    });
    if (state.seedColor) record.colours = { seed: state.seedColor };

    await store.save(record);
    haptics.tap('success');
    state.tickets = await store.all();

    const wasEditing = Boolean(state.editingId);
    state.draft = null;
    state.editingId = null;

    renderHome();

    if (wasEditing) {
      // Back to the ticket, so the correction can be seen to have worked.
      state.viewing = state.tickets.find((entry) => entry.id === record.id) || null;
      if (state.viewing) {
        renderPass(state.viewing);
        state.history = ['home'];
        show('pass', { remember: false });
        toast('Ticket updated.');
        return;
      }
    }

    show('home', { remember: false });
    state.history = [];
    toast('Ticket saved.');
  } catch (error) {
    toast('Could not save that ticket.', { detail: error.message, tone: 'bad' });
  }
}

// ────────────────────────────── help ──────────────────────────────

function openHelp(page = 0) {
  state.helpPage = page;
  renderHelp();
  show('help');
}

function renderHelp({ direction = null } = {}) {
  const pages = helpPages(platform);
  const page = pages[state.helpPage];

  const body = $('help-body');

  $('help-title').textContent = page.title;
  body.innerHTML = page.body;
  $('help-dots').innerHTML = pages
    .map((_, index) => `<button class="dot ${index === state.helpPage ? 'on' : ''}" data-page="${index}" aria-label="Page ${index + 1}"></button>`)
    .join('');

  $('help-prev').disabled = state.helpPage === 0;
  $('help-next').disabled = state.helpPage === pages.length - 1;

  for (const dot of $('help-dots').querySelectorAll('[data-page]')) {
    dot.addEventListener('click', () => {
      const target = Number(dot.dataset.page);
      const way = target > state.helpPage ? 'forward' : 'back';
      state.helpPage = target;
      renderHelp({ direction: way });
    });
  }

  // Scrolled back to the top: a new page that begins halfway down reads as broken.
  body.scrollTop = 0;

  // The page slides in, so a change is felt as well as seen.
  body.classList.remove('turning-forward', 'turning-back');
  if (direction) {
    // Reading offsetWidth forces the class removal to take effect, so the animation
    // restarts rather than being ignored as already-applied.
    void body.offsetWidth;
    body.classList.add(direction === 'back' ? 'turning-back' : 'turning-forward');
  }
}

/**
 * Swipe left and right between help pages.
 *
 * Dots and arrows imply a swipe on a phone, and their absence makes the screen feel
 * inert — the user tries the obvious gesture, nothing happens, and they conclude the app
 * is unfinished. Attached once, to the body, since the pages themselves are re-rendered.
 *
 * Vertical movement is left alone: the help text scrolls, and stealing that gesture
 * would be far worse than not offering a swipe at all.
 */
function wireHelpSwipe() {
  const body = $('help-body');
  if (!body) return;

  let startX = 0;
  let startY = 0;
  let tracking = false;

  body.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  body.addEventListener('touchend', (event) => {
    if (!tracking) return;
    tracking = false;

    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    // Clearly horizontal, and far enough to be deliberate rather than a stray thumb.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;

    const pages = helpPages(platform);
    const next = dx < 0 ? state.helpPage + 1 : state.helpPage - 1;
    if (next < 0 || next >= pages.length) return;

    state.helpPage = next;
    renderHelp({ direction: dx < 0 ? 'forward' : 'back' });
  }, { passive: true });
}

// ────────────────────────────── settings ──────────────────────────────

/**
 * The small mark beside each settings heading.
 *
 * Line icons on a 24-grid, matching the rest of the app. Deliberately only on headings:
 * an icon on every row reads as decoration and makes a settings list look like a toy,
 * while a marked heading gives the eye a landmark when scanning for a section.
 */
const SETTINGS_ICONS = {
  theme: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8'
    + 'M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M7 12h10"/>',
  retention: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/>',
  backup: '<path d="M12 15V4M8.5 11.5 12 15l3.5-3.5M4.5 16v2.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V16"/>',  storage: '<ellipse cx="12" cy="6.5" rx="7" ry="2.6"/><path d="M5 6.5v11c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-11M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>',
  version: '<path d="M12 2.6 20 6.4v5.2c0 4.3-3.2 8.2-8 9.8-4.8-1.6-8-5.5-8-9.8V6.4z"/>'
    + '<path d="m9.2 12 2 2 3.6-3.8"/>',
  erase: '<path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7'
    + 'M6.5 7l1 12.1A1 1 0 0 0 8.5 20h7a1 1 0 0 0 1-.9L17.5 7M10.5 11v5M13.5 11v5"/>',
};

function settingsIcon(name) {
  const path = SETTINGS_ICONS[name];
  if (!path) return '';

  return `<svg class="group-icon ${name === 'erase' ? 'danger' : ''}" viewBox="0 0 24 24"
    width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/** Icons for the three states the update line can be in. */
const UPDATE_ICONS = {
  checking: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/>',
  current: '<path d="m4.5 12.4 5 5L19.5 7"/>',
  ready: '<path d="M12 4v11M8 11l4 4 4-4M5 19h14"/>',
};

async function openSettings() {
  const estimate = await store.storageEstimate();
  const current = prefs.settings();
  const { past } = store.partition(state.tickets);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);

  // Changing a setting re-renders the whole sheet, which otherwise throws the user back
  // to the top — away from the control they just used, so the change appears to have
  // done something unrelated. Keeping the scroll position makes it feel like the row
  // changed rather than the page.
  const body = $('settings-body');
  const scrollTop = body.scrollTop || body.parentElement?.scrollTop || 0;

  // Ordered the way Apple orders Settings: what you change often at the top, what you
  // rarely touch below it, information near the end, and anything destructive last —
  // where it cannot be hit while reaching for something else.
  //
  // Headings carry a small icon; individual rows do not. A glyph on every button turns a
  // settings list into a toy, but a marked heading gives the eye something to land on
  // when scanning for a section, which is how this screen is actually used.
  body.innerHTML = `
    <section class="group">
      <h2>${settingsIcon('theme')}Theme</h2>
      <div class="segmented" id="theme-segment" role="group" aria-label="Theme">
        <button data-theme="light" type="button">Light</button>
        <button data-theme="auto" type="button">Auto</button>
        <button data-theme="dark" type="button">Dark</button>
      </div>
    </section>

    <section class="group">
      <h2>${settingsIcon('scan')}While showing a code</h2>
      <label class="switch-row">
        <span class="option-text">
          <strong>Keep the screen awake</strong>
          <em>${wakelock.supported()
            ? 'Stops the display dimming while you hold it out to be scanned.'
            : 'Your browser does not offer this.'}</em>
        </span>
        <input type="checkbox" id="keep-awake" ${current.keepAwake ? 'checked' : ''}
               ${wakelock.supported() ? '' : 'disabled'}>
        <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      </label>
      ${wakelock.supported() && current.keepAwake && wakelock.lastFailure() ? `
        <p class="group-note warn-note">
          Your browser refused this last time — ${escapeHtml(wakelock.lastFailure())}. The
          code still shows; the screen may dim.
        </p>` : ''}
    </section>

    <section class="group">
      <h2>${settingsIcon('storage')}Data retention</h2>
      <div class="options-list">
        ${Object.values(prefs.RETENTION).map((option) => `
          <button class="option ${current.retention === option.id ? 'on' : ''}" data-retention="${option.id}" type="button">
            <span class="option-text">
              <strong>${escapeHtml(option.label)}</strong>
              <em>${escapeHtml(option.note)}</em>
            </span>
            <span class="option-tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17">
                <path d="m4 12.4 5.2 5.2L20 7" fill="none" stroke="currentColor" stroke-width="2.4"
                      stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
          </button>`).join('')}
      </div>
      <!--
        No summary line here. It restated whichever option was already ticked — "1 past
        ticket kept" directly under a selected row reading "Nothing is ever deleted
        automatically" — which is the same fact told twice, once redundantly.
      -->
      ${current.retention !== 'keep' ? `<p class="group-note warn-note">
        Automatic deletion cannot be undone, so export a backup if you might want these later.
      </p>` : ''}

      <!--
        How much space is being used belongs with the rules about what is kept: they are
        the same subject, and reading one without the other tells you half the story. It
        was a section of its own, which put a heading between a policy and its consequence.
      -->
      <div class="info-card">
        <div class="fact-row">
          <span class="fact-label">Saved</span>
          <span class="fact-value">${state.tickets.length - past.length} upcoming · ${past.length} past</span>
        </div>
        ${estimate ? `
          <div class="fact-row">
            <span class="fact-label">Used</span>
            <span class="fact-value">${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)}</span>
          </div>` : ''}
        <p class="${persisted ? 'storage-note' : 'storage-note warn-note'}">
          ${persisted
            ? 'Your browser has agreed to keep this data.'
            : 'Your browser has not promised to keep this data, so it could be cleared if space runs short. Keep a backup.'}
        </p>
      </div>
    </section>

    <section class="group">
      <h2>${settingsIcon('backup')}Backup</h2>
      <button class="row" id="export" type="button">
        <span>Export a backup</span>
        <span class="row-note">${state.tickets.length} pass${state.tickets.length === 1 ? '' : 'es'}</span>
      </button>
      <button class="row" id="import" type="button"><span>Restore from a backup</span></button>
      <p class="group-note">
        A single readable file holding everything you have saved. Nothing here is locked
        to this app.
      </p>
    </section>

    <section class="group">
      <h2>${settingsIcon('version')}Version</h2>
      <div class="info-card">
        <!--
          A version is a fact to be looked up, not a sentence to be read. Set as a label
          and a value it can be found at a glance and quoted accurately, which is the only
          reason anyone opens this section.
        -->
        <div class="fact-row">
          <span class="fact-label">Build</span>
          <span class="fact-value">${escapeHtml(BUILD.version)}</span>
        </div>
        <div class="fact-row">
          <span class="fact-label">Released</span>
          <span class="fact-value">${escapeHtml(BUILD.date)}</span>
        </div>
        <p id="update-state" class="update-state checking">
          <span class="update-icon" aria-hidden="true"></span>
          <span class="update-text">Checking for updates…</span>
        </p>
      </div>
      <button class="row" id="check-updates" type="button"><span>Check for updates</span></button>
      <p class="group-note">
        Updates arrive on their own and apply when you are not using a pass. What you have
        saved is never affected — it lives on your device, separately from the app.
      </p>
    </section>

    <section class="group">
      <h2>${settingsIcon('erase')}Erase</h2>
      <button class="row danger" id="delete-all" type="button"><span>Erase all data</span></button>
      <p class="group-note warn-note">
        Everything you have saved is removed from this device. Nothing is stored anywhere
        else, so this cannot be undone.
      </p>
    </section>

    <div class="colophon">
      ${wordmarkSvg({ height: 26, colour: 'currentColor' })}
      <p>Everything happens on your device. No server, no account, nothing uploaded.</p>
      <p class="credit">Vibe coded by Tejaswi · Built with <span class="heartbeat" aria-label="love">❤️</span> and Microsoft Scout.</p>
    </div>
  `;

  // Put the user back where they were, before the browser paints.
  if (scrollTop) {
    body.scrollTop = scrollTop;
    if (body.parentElement) body.parentElement.scrollTop = scrollTop;
  }

  for (const button of $('settings-body').querySelectorAll('[data-retention]')) {
    button.addEventListener('click', () => {
      prefs.update({ retention: button.dataset.retention });
      openSettings();
    });
  }

  // Version and updates.
  //
  // Shown plainly so that "are you on the latest?" can be answered by looking, rather
  // than by asking someone to try again and hoping their cache cooperated.
  const updateState = $('update-state');

  // The state carries its own icon, because a green tick is read before any sentence is,
  // and "am I up to date?" is the only question this line exists to answer.
  const setState = (state, text) => {
    if (!updateState) return;
    updateState.className = `update-state ${state}`;
    updateState.innerHTML = `
      <span class="update-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${UPDATE_ICONS[state]}</svg>
      </span>
      <span class="update-text">${escapeHtml(text)}</span>`;
  };

  if (updates.isPending()) {
    setState('ready', 'An update is ready — tap below to restart.');
  } else {
    setState('checking', 'Checking…');
    updates.check({ force: true }).then((found) => {
      if (found) setState('ready', 'An update is ready — tap below to restart.');
      else setState('current', "You're on the latest version.");
    });
  }

  $('check-updates').addEventListener('click', async () => {
    if (updates.isPending()) {
      updates.apply();
      return;
    }

    setState('checking', 'Checking…');
    const found = await updates.check({ force: true });
    if (found) setState('ready', 'An update is ready — tap again to restart.');
    else setState('current', "You're on the latest version.");
  });

  $('keep-awake').addEventListener('change', (event) => {
    prefs.update({ keepAwake: event.target.checked });
  });

  const segment = $('theme-segment');
  const theme = document.documentElement.dataset.theme || 'auto';
  for (const button of segment.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
    button.addEventListener('click', () => { applyTheme(button.dataset.theme); openSettings(); });
  }

  $('export').addEventListener('click', exportBackup);
  $('import').addEventListener('click', importBackup);
  $('delete-all').addEventListener('click', deleteEverything);

  show('settings');
}

/**
 * Writes tickets to a file the user keeps.
 *
 * With no argument this exports everything, which is the backup case. Given a list it
 * exports just those, so a single ticket can be sent to someone or kept aside.
 */
async function exportBackup(only = null) {
  const payload = await store.exportAll();

  // Guard against being wired straight to a click handler, where the argument would be
  // an Event rather than a list of tickets.
  const tickets = Array.isArray(only) ? only : null;

  if (tickets?.length) {
    const wanted = new Set(tickets.map((ticket) => ticket.id));
    payload.tickets = (payload.tickets || []).filter((ticket) => wanted.has(ticket.id));
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const single = tickets?.length === 1 ? tickets[0] : null;
  const name = single
    ? `ticket-${(single.fields?.pnr || single.fields?.reference || single.id).toString().slice(0, 12)}.json`
    : `tickets-${new Date().toISOString().slice(0, 10)}.json`;

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(tickets?.length ? 'Ticket exported.' : 'Backup saved.');
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const { added, skipped } = await store.importAll(payload);
      state.tickets = await store.all();
      renderHome();
      toast(`Restored ${added} ticket${added === 1 ? '' : 's'}${skipped ? `, ${skipped} already here` : ''}.`);
    } catch (error) {
      toast('That file could not be restored.', { detail: error.message, tone: 'bad' });
    }
  });

  input.click();
}

async function deleteEverything() {
  if (!confirm('Delete every ticket? This cannot be undone.')) return;
  await store.clear();
  state.tickets = [];
  renderHome();
  show('home', { remember: false });
  toast('All tickets deleted.');
}

// ────────────────────────────── theme ──────────────────────────────

const THEMES = ['light', 'auto', 'dark'];

function applyTheme(theme) {
  const chosen = THEMES.includes(theme) ? theme : 'auto';
  document.documentElement.dataset.theme = chosen;
  try { localStorage.setItem('ticket.theme', chosen); } catch { /* private mode */ }
  setThemeColour(null);
}

function setThemeColour(override) {
  const theme = document.documentElement.dataset.theme || 'auto';
  const dark = theme === 'dark'
    || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = override || (dark ? '#000000' : '#f2f2f7');
}

function initTheme() {
  let stored = 'auto';
  try { stored = localStorage.getItem('ticket.theme') || 'auto'; } catch { /* private mode */ }
  applyTheme(stored);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (document.documentElement.dataset.theme === 'auto') setThemeColour(null);
  });
}

// ────────────────────────────── helpers ──────────────────────────────

/**
 * The mark between origin and destination.
 *
 * The aircraft is drawn nose-up and rotated to point along the route, because it sits
 * between two airport codes and is read as an arrow: nose-up says "a flight", nose-right
 * says "this flight, in this direction". Trains and buses are not directional symbols in
 * the same way and are left upright.
 */
/**
 * The mark for a kind of pass.
 *
 * Every kind gets one. The route glyph only ever appeared between two endpoint codes, so
 * a hotel or a cinema booking — which has no route — showed nothing at all, and the card
 * gave no clue what it was until you read it.
 *
 * The glyphs come from artwork.js, drawn for the Wallet passes this app was originally
 * going to produce. They were built to survive being shown at 29pt, which is exactly the
 * constraint a card mark has, so there is no reason to draw a second, worse set.
 */
function kindGlyph(kind, transitType) {
  if (transitType) return transitGlyph(transitType);
  if (!kind) return '';

  const glyph = glyphFor(kind);
  if (!glyph) return '';

  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">${glyph}</svg>`;
}

/**
 * The mark between origin and destination.
 *
 * Drawn from the same set as everything else — artwork.js has proper train, bus and
 * aircraft glyphs with their interior detail cut out. The simplified paths used here
 * before drew the train as a filled box, which rendered as a grey square.
 *
 * The aircraft is rotated to point along the route: it sits between two airport codes
 * and is read as an arrow, so nose-right says "this flight, in this direction". Trains
 * and buses are not directional in the same way and stay upright.
 */
function transitGlyph(transitType) {
  const category = {
    PKTransitTypeAir: 'flight',
    PKTransitTypeTrain: 'rail',
    PKTransitTypeBus: 'bus',
  }[transitType];

  if (!category) return '<span class="plain-arrow">→</span>';

  const rotate = category === 'flight' ? ' transform="rotate(90 12 12)"' : '';

  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <g${rotate}>${glyphFor(category)}</g>
  </svg>`;
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / 1048576;
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`;
}

let toastTimer = null;
/**
 * A brief message at the foot of the screen.
 *
 * An error that offers an action stays until it is dismissed. The timeout exists so a
 * confirmation does not linger, but applying it to a failure meant the explanation
 * vanished mid-read — which is how a real bug report came back as "it said undefined is
 * not a function and then the message chopped off".
 */
function toast(message, { detail = '', tone = 'good', onTap = null, action = 'Tap to dismiss', timeout = null } = {}) {
  const element = $('toast');
  element.className = `toast ${tone}${onTap ? ' tappable' : ''}`;
  if (onTap) element.dataset.action = action; else delete element.dataset.action;
  element.innerHTML = `<strong>${escapeHtml(message)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}`;
  element.hidden = false;

  element.onclick = onTap
    ? () => { element.hidden = true; onTap(); }
    : null;

  clearTimeout(toastTimer);

  // Anything the user can act on waits for them — unless it was given a deadline, which
  // an undoable action needs: "Tap to undo" cannot sit on screen indefinitely, and the
  // moment it leaves is the moment the deletion becomes real.
  if (onTap && timeout == null) return;
  toastTimer = setTimeout(() => { element.hidden = true; }, timeout ?? (detail ? 6500 : 2800));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const escapeAttr = escapeHtml;

// ────────────────────────────── wiring ──────────────────────────────

function wire() {
  // Bound to the container rather than to each card, so it survives every redraw of the
  // list without accumulating a listener per render.
  swipe.attach($('home-body'), {
    onArchive: archiveTicket,
    onDelete: deleteTicketWithUndo,
  });

  // Android offers a real install button; iOS never fires this, hence the instructions.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    if (state.screen === 'landing') renderLanding();
  });

  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    renderHome();
    show('home', { remember: false });
    requestPersistence();
  });

  $('open-anyway').addEventListener('click', () => { renderHome(); show('home', { remember: false }); });
  $('add-ticket').addEventListener('click', openAdd);
  $('add-cancel').addEventListener('click', back);
  $('pass-back').addEventListener('click', back);

  // Tap anywhere to reveal the way out; tap the button itself to leave. Two separate
  // gestures so that a stray touch while the phone is held up cannot dismiss the code.
  $('screen-scan').addEventListener('click', (event) => {
    if (event.target.closest('.scan-close')) { closeScan(); return; }

    // Any tap here is a gesture, so it is the moment to try the wake lock again if it
    // was refused earlier — Safari grants one only during a gesture.
    if (prefs.settings().keepAwake) wakelock.acquire();

    // Tapping anywhere toggles the enlarged view.
    //
    // The target used to be the code itself, which enlarged past the screen edge and
    // took its own tap target with it — leaving no way back. Anywhere on the screen
    // works, and the note says which state you are in.
    const canvas = $('scan-canvas');
    const zoomed = canvas.classList.toggle('zoomed');
    $('scan-note').textContent = zoomed ? 'Tap anywhere to shrink it' : 'Tap anywhere to enlarge it';

    revealScanControls();
  });

  $('review-cancel').addEventListener('click', () => {
    const wasEditing = state.editingId;
    state.draft = null;
    state.editingId = null;

    // Cancelling an edit returns to the ticket, not to the list — the user did not
    // arrive from there and being dropped elsewhere feels like something went wrong.
    if (wasEditing && state.viewing) {
      renderPass(state.viewing);
      show('pass', { remember: false });
      return;
    }
    show('home', { remember: false });
  });
  $('review-save').addEventListener('click', saveDraft);
  $('open-help').addEventListener('click', () => openHelp(0));
  wireHelpSwipe();
  $('help-close').addEventListener('click', back);
  $('help-prev').addEventListener('click', () => { state.helpPage--; renderHelp({ direction: 'back' }); });
  $('help-next').addEventListener('click', () => { state.helpPage++; renderHelp({ direction: 'forward' }); });
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', back);

  $('pass-menu').addEventListener('click', () => openPassMenu());

  const dropzone = $('dropzone');
  const file = $('file');

  dropzone.addEventListener('click', () => file.click());
  // Escape closes whatever is on top. Expected on a desktop, and a keyboard is the only
  // way out for anyone not using a pointer.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    const sheet = document.querySelector('.action-sheet');
    if (sheet) { sheet.remove(); return; }

    if (!$('screen-scan').hidden) { closeScan(); return; }
    if (!$('screen-help').hidden || !$('screen-settings').hidden) back();
  });

  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); file.click(); }
  });

  file.addEventListener('change', () => {
    if (file.files?.[0]) {
      const chosen = file.files[0];
      file.value = '';
      handleSource(() => ingest(chosen), describeFor(chosen));
    }
  });

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('over'); });
  }
  dropzone.addEventListener('drop', (event) => {
    if (event.dataTransfer) handleSource(() => ingestFromDataTransfer(event.dataTransfer), 'Reading what you dropped in.');
  });

  document.addEventListener('paste', (event) => {
    if (state.screen !== 'add') return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    handleSource(() => ingestFromDataTransfer(clipboard), 'Reading what you pasted.');
  });

  // The hardware back gesture should retreat through the app, not leave it.
  window.addEventListener('popstate', () => { if (state.history.length) back(); });
}

function describeFor(file) {
  if (/pdf$/i.test(file.name)) return 'Reading the PDF — text comes straight out, which is accurate.';
  if (/\.(png|jpe?g|webp|gif|heic)$/i.test(file.name)) return 'Reading the picture. This takes a little longer.';
  return 'Reading the message.';
}

start();
