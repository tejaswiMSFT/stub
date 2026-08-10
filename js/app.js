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
import { readBarcodesFromSource, formatLabel } from './barcode.js';
import { buildLines, linesFromOcr } from './text.js';
import { extract } from './adapters/index.js';
import { extractBrand } from './brand.js';
import { derivePalette, walletColors } from './artwork.js';
import { Confidence, Source } from './model.js';
import { IngestError } from './errors.js';
import * as store from './store.js';
import * as code from './barcode-render.js';
import * as prefs from './settings.js';
import * as wakelock from './wakelock.js';
import * as resume from './resume.js';
import { helpPages } from './help.js';
import { markSvg, wordmarkSvg, svgUrl, brand } from './brand-identity.js';

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

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (error) {
    // Offline support is a bonus, not a requirement; the app still works without it.
    console.warn('Service worker registration failed', error);
  }
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
          Then in Safari: ${shareGlyph()} <strong>Share</strong> → <strong>Add to Home Screen</strong>.
        </p>
      </div>`;

    $('copy-link')?.addEventListener('click', copyLink);
    $('share-link')?.addEventListener('click', shareLink);
  } else if (platform.iOS) {
    card.innerHTML = `
      <div class="install-steps">
        <p class="install-lead">Add it to your Home Screen</p>
        <ol>
          <li>Tap ${shareGlyph()} <strong>Share</strong> in Safari's toolbar</li>
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

function renderHome() {
  const body = $('home-body');
  const { upcoming, past } = store.partition(state.tickets);

  if (!state.tickets.length) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="42" height="42">
            <path d="M3.4 6.6h17.2a1 1 0 0 1 1 1v2.6a.8.8 0 0 1-.6.8 2 2 0 0 0 0 3.9.8.8 0 0 1 .6.8v2.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1v-2.6a.8.8 0 0 1 .6-.8 2 2 0 0 0 0-3.9.8.8 0 0 1-.6-.8V7.6a1 1 0 0 1 1-1z"
                  fill="none" stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </div>
        <h2>No tickets yet</h2>
        <p class="muted">Add a boarding pass, a train ticket, or a cinema booking.</p>
        <button class="primary" id="empty-add" type="button">Add a ticket</button>
      </div>`;
    $('empty-add').addEventListener('click', openAdd);
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

  for (const element of body.querySelectorAll('[data-ticket]')) {
    element.addEventListener('click', () => openPass(element.dataset.ticket));
  }
}

/** Says how soon, in the terms a person would use rather than a formatted timestamp. */
function nextLabel(ticket) {
  if (ticket.departsAt == null) return 'Next';

  const diff = ticket.departsAt - Date.now();
  const hours = diff / 3600000;

  if (diff < 0) return 'Happening now';
  if (hours < 1) return `In ${Math.max(1, Math.round(diff / 60000))} minutes`;
  if (hours < 24) return `In ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  return 'Next';
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
    : `<div class="card-route"><span class="place single">${escapeHtml(f.title || f.property || f.provider || 'Ticket')}</span></div>`;

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

  const seat = ticket.kind === 'lodging'
    ? (f.room ? escapeHtml(f.room) : '')
    : (f.seat ? `${f.coach ? `${escapeHtml(f.coach)} · ` : ''}${escapeHtml(f.seat)}` : '');

  return `
    <button class="card ${large ? 'large' : ''} ${dim ? 'dim' : ''}" data-ticket="${escapeAttr(ticket.id)}"
            style="--card-bg:${colours.backgroundColor};--card-fg:${colours.foregroundColor};--card-label:${colours.labelColor}">
      <div class="card-head">
        <span class="card-provider">${escapeHtml(f.provider || '')}</span>
        ${ticket.barcode ? '<span class="card-chip">Scannable</span>' : ''}
      </div>
      ${route}
      <div class="card-foot">
        <span class="card-detail">${escapeHtml(detail)}</span>
        ${seat ? `<span class="card-seat">${seat}</span>` : ''}
      </div>
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
function renderPass(ticket) {
  const palette = paletteFor(ticket);
  const colours = walletColors(palette);
  const f = ticket.fields || {};

  // What names the pass. A stay is identified by the property, not by the agent who
  // sold it: "MakeMyTrip" on the face of a hotel pass tells a guest nothing they need
  // at a reception desk.
  const heading = ticket.kind === 'lodging'
    ? (f.property || f.provider || 'Stay')
    : (f.provider || 'Ticket');

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
    : `<div class="pass-route"><div class="endpoint"><span class="code single">${escapeHtml(f.title || f.property || f.provider || 'Ticket')}</span></div></div>`;

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
    <div class="pass-card" style="--card-bg:${colours.backgroundColor};--card-fg:${colours.foregroundColor};--card-label:${colours.labelColor}">
      ${primary}
      <div class="pass-grid">
        ${golden.map(([key, label, value]) => `
          <div class="pass-field ${ticket.provenance?.[key]?.confidence === Confidence.LOW ? 'unsure' : ''}">
            <span class="k">${escapeHtml(label)}</span>
            <span class="v">${escapeHtml(value)}</span>
          </div>`).join('')}
      </div>

      ${ticket.barcode ? `
        <button class="show-code" id="show-code" type="button">
          <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
            <path d="M3 4v16M6.5 4v16M10 4v11M13.5 4v16M17 4v11M20.5 4v16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
          </svg>
          Show the code
        </button>` : `
        <p class="no-code">No barcode was found on this ticket. Keep the original with you.</p>`}
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

    <section class="pass-section">
      <h2>Where these came from</h2>
      <dl class="detail-list subtle">
        ${Object.entries(ticket.provenance || {})
          .filter(([key]) => f[key])
          .map(([key, meta]) => `
            <div><dt>${escapeHtml(meta.label || key)}</dt><dd>${escapeHtml(sourceLabel(meta))}</dd></div>`)
          .join('')}
      </dl>
    </section>

    <p class="pass-disclaimer">
      Made on your device from a ticket you supplied. Not issued by the operator — keep
      your original with you.
    </p>
  `;

  const button = $('show-code');
  if (button) button.addEventListener('click', () => openScan(ticket));
}

function seatLabel(ticket) {
  if (ticket.kind === 'rail') return ticket.fields?.berthPosition ? 'Berth' : 'Seat';
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

  reference.textContent = ticket.fields?.pnr || '';
  note.textContent = '';

  // Controls start hidden: the user has just tapped to get here, so they know how they
  // arrived and do not need a way out presented to them immediately.
  $('screen-scan').classList.remove('controls');
  clearTimeout(controlsTimer);

  if (prefs.settings().keepAwake) wakelock.acquire();

  try {
    await code.render(canvas, ticket.barcode, {
      targetWidth: Math.min(window.innerWidth - 40, 620),
    });
    note.textContent = `${code.formatName(ticket.barcode.format)} · exactly as it was on your ticket`;
  } catch (error) {
    note.textContent = error.message;
  }
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

    if (!lines.length) {
      draft.warnings.push(barcodes.primary
        ? 'We read the barcode but not the printed text, so most details need filling in.'
        : 'We could not read any text or barcode from this. You can fill the details in yourself.');
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

function fail(error) {
  const isIngest = error instanceof IngestError;
  toast(error?.message || 'Something went wrong.', {
    detail: error?.hint || (isIngest ? '' : 'A clearer photo or the original PDF usually works better.'),
    tone: 'bad',
  });
  show('add', { remember: false });
  console.error(error);
}

// ────────────────────────────── review ──────────────────────────────

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
  const badge = field.edited
    ? '<span class="badge edited">Edited</span>'
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
      state.draft.get(button.dataset.confirm)?.confirm();
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
    const record = store.fromDraft(state.draft, { source: describeSource(state.draft.ingested || {})?.label });
    if (state.seedColor) record.colours = { seed: state.seedColor };

    await store.save(record);
    state.tickets = await store.all();
    state.draft = null;

    renderHome();
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

function renderHelp() {
  const pages = helpPages(platform);
  const page = pages[state.helpPage];

  $('help-title').textContent = page.title;
  $('help-body').innerHTML = page.body;
  $('help-dots').innerHTML = pages
    .map((_, index) => `<button class="dot ${index === state.helpPage ? 'on' : ''}" data-page="${index}" aria-label="Page ${index + 1}"></button>`)
    .join('');

  $('help-prev').disabled = state.helpPage === 0;
  $('help-next').disabled = state.helpPage === pages.length - 1;

  for (const dot of $('help-dots').querySelectorAll('[data-page]')) {
    dot.addEventListener('click', () => { state.helpPage = Number(dot.dataset.page); renderHelp(); });
  }
}

// ────────────────────────────── settings ──────────────────────────────

async function openSettings() {
  const estimate = await store.storageEstimate();
  const current = prefs.settings();
  const { past } = store.partition(state.tickets);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);

  $('settings-body').innerHTML = `
    <section class="group">
      <h2>After you travel</h2>
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
      <p class="group-note">
        ${escapeHtml(prefs.retentionSummary(past.length))}
        You can change this whenever you like — switching back to <em>Keep them</em> stops
        any further deletion at once, though anything already removed is gone.
      </p>
      ${current.retention !== 'keep' ? `<p class="group-note warn-note">
        Automatic deletion cannot be undone. Export a backup if you might want these later.
      </p>` : ''}
    </section>

    <section class="group">
      <h2>Backup</h2>
      <button class="row" id="export" type="button">
        <span>Export a backup</span>
        <span class="row-note">${state.tickets.length} ticket${state.tickets.length === 1 ? '' : 's'}</span>
      </button>
      <button class="row" id="import" type="button"><span>Restore from a backup</span></button>
      <p class="group-note">
        A single readable file holding every ticket. Nothing here is locked to this app.
      </p>
    </section>

    <section class="group">
      <h2>While showing a code</h2>
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
    </section>

    <section class="group">
      <h2>Appearance</h2>
      <div class="segmented" id="theme-segment" role="group" aria-label="Appearance">
        <button data-theme="light" type="button">Light</button>
        <button data-theme="auto" type="button">Auto</button>
        <button data-theme="dark" type="button">Dark</button>
      </div>
    </section>

    <section class="group">
      <h2>Storage</h2>
      <div class="info-card">
        ${estimate ? `<p>Using ${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)} available.</p>` : ''}
        <p class="${persisted ? '' : 'warn-note'}">
          ${persisted
            ? 'Your browser has agreed to keep this data.'
            : 'Your browser has not promised to keep this data, so it could be cleared if space runs short. Keep a backup.'}
        </p>
      </div>
    </section>

    <section class="group">
      <h2>Everything</h2>
      <button class="row danger" id="delete-all" type="button"><span>Delete every ticket</span></button>
      <p class="group-note">
        Removing this app from your home screen also deletes everything in it. There is no
        copy anywhere else — that is the direct consequence of nothing being uploaded.
      </p>
    </section>

    <div class="colophon">
      ${wordmarkSvg({ height: 26, colour: 'currentColor' })}
      <p>Everything happens on your device. No server, no account, nothing uploaded.</p>
    </div>
  `;

  for (const button of $('settings-body').querySelectorAll('[data-retention]')) {
    button.addEventListener('click', () => {
      prefs.update({ retention: button.dataset.retention });
      openSettings();
    });
  }

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

async function exportBackup() {
  const payload = await store.exportAll();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `tickets-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup saved.');
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

function transitGlyph(transitType) {
  const paths = {
    PKTransitTypeAir: 'M12 1.6c.95 0 1.7.85 1.7 1.9v4.9l7.9 4.55v2.2l-7.9-2.35v4.35l2.4 1.75v1.75l-4.1-1.15-4.1 1.15V19.3l2.4-1.75v-4.35L2.4 15.55v-2.2l7.9-4.55V3.5c0-1.05.75-1.9 1.7-1.9z',
    PKTransitTypeTrain: 'M8 2.6h8a3.4 3.4 0 0 1 3.4 3.4v8.6a2.6 2.6 0 0 1-2.6 2.6H7.2a2.6 2.6 0 0 1-2.6-2.6V6A3.4 3.4 0 0 1 8 2.6zM9.4 17.2 7 21.4M14.6 17.2 17 21.4',
    PKTransitTypeBus: 'M2.6 5.4h14.2a4.6 4.6 0 0 1 3.5 1.6l1.2 1.5a2 2 0 0 1 .5 1.3v5.4a1.4 1.4 0 0 1-1.4 1.4H2.6a1.4 1.4 0 0 1-1.4-1.4V6.8a1.4 1.4 0 0 1 1.4-1.4z',
  };
  const path = paths[transitType];
  if (!path) return '<span class="plain-arrow">→</span>';
  return `<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
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
function toast(message, { detail = '', tone = 'good' } = {}) {
  const element = $('toast');
  element.className = `toast ${tone}`;
  element.innerHTML = `<strong>${escapeHtml(message)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}`;
  element.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, detail ? 5200 : 2800);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const escapeAttr = escapeHtml;

// ────────────────────────────── wiring ──────────────────────────────

function wire() {
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
    revealScanControls();
  });

  $('review-cancel').addEventListener('click', () => { state.draft = null; show('home', { remember: false }); });
  $('review-save').addEventListener('click', saveDraft);
  $('open-help').addEventListener('click', () => openHelp(0));
  $('help-close').addEventListener('click', back);
  $('help-prev').addEventListener('click', () => { state.helpPage--; renderHelp(); });
  $('help-next').addEventListener('click', () => { state.helpPage++; renderHelp(); });
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', back);

  $('pass-menu').addEventListener('click', async () => {
    if (!state.viewing) return;
    if (!confirm('Remove this ticket? Your original file is untouched.')) return;
    await store.remove(state.viewing.id);
    state.tickets = await store.all();
    state.viewing = null;
    renderHome();
    show('home', { remember: false });
    toast('Ticket removed.');
  });

  const dropzone = $('dropzone');
  const file = $('file');

  dropzone.addEventListener('click', () => file.click());
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
