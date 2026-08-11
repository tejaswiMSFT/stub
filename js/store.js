/**
 * Local storage for saved tickets.
 *
 * IndexedDB rather than localStorage because tickets carry binary data — the original
 * barcode payload, the extracted logo — and localStorage is strings only, capped at a
 * few megabytes. Encoding binary as base64 to fit would inflate it by a third and risk
 * corrupting the one thing that must survive byte-for-byte.
 *
 * Persistence is requested explicitly. By default WebKit treats an origin as
 * "best-effort" and may evict it under storage pressure or after a period without
 * interaction — which would silently delete someone's boarding pass the week before
 * they travel. Persistent origins are excluded from eviction, and WebKit grants the
 * request based on heuristics including whether the site is installed to the home
 * screen. Hence: ask on install, and tell the user plainly if it is refused.
 *
 * Nothing here talks to a network. There is no server, no sync, no account. The database
 * lives on the device and leaves it only when the user exports a backup deliberately.
 */

import { TicketDraft, Field, Source, Confidence } from './model.js';

const DB_NAME = 'ticket';
const DB_VERSION = 1;
const STORE = 'tickets';

let connection = null;

function open() {
  if (connection) return connection;

  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        // Indexed because the home screen's only question is "what is next?", and
        // scanning every ticket to answer it would scale badly with a year of history.
        store.createIndex('departsAt', 'departsAt');
        store.createIndex('addedAt', 'addedAt');
      }

      void event;
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Another copy of this app is open. Close it and try again.'));
  });

  return connection;
}

function transact(mode, run) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);

    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }

    tx.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The save was interrupted.'));
  }));
}

// ────────────────────────────── persistence ──────────────────────────────

/**
 * Asks the browser not to evict our data.
 *
 * Reported honestly rather than assumed: if the request is refused, the user deserves
 * to know their tickets are only best-effort, and to be nudged toward an export.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) {
    return { supported: false, persisted: false };
  }

  let persisted = await navigator.storage.persisted();
  if (!persisted) persisted = await navigator.storage.persist();

  return { supported: true, persisted };
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota, free: Math.max((quota || 0) - (usage || 0), 0) };
}

// ────────────────────────────── shape ──────────────────────────────

/**
 * Converts a draft into the record we store.
 *
 * Fields are flattened to plain values, but their provenance is kept: a user returning
 * to a ticket a month later still deserves to know which details came from the barcode
 * and which were guessed from a photograph.
 *
 * The barcode payload is stored as raw bytes. This is the single most important value in
 * the record — re-encoding it through a string could alter it, and a barcode that scans
 * to different data at a gate is the worst failure this app can produce.
 */
export function fromDraft(draft, { source = null, id = null } = {}) {
  const fields = {};
  const provenance = {};

  for (const field of draft.list()) {
    if (!field.value) continue;
    fields[field.key] = field.value;
    provenance[field.key] = {
      source: field.source,
      confidence: field.confidence,
      edited: field.edited,
      confirmed: field.confirmed,
      label: field.label,
      note: field.note || null,
      critical: Boolean(field.critical),
    };
  }

  return {
    id: id || crypto.randomUUID(),
    kind: draft.type,
    transitType: draft.transitType || null,

    fields,
    provenance,

    allSeats: draft.allSeats || null,
    passengers: draft.passengers?.length > 1 ? draft.passengers : null,
    additionalLegs: draft.additionalLegs || null,
    originName: draft.originName || null,
    destinationName: draft.destinationName || null,
    warnings: draft.warnings || [],

    barcode: draft.barcode
      ? {
        format: draft.barcode.format,
        // Raw bytes, exactly as decoded. Never re-derived.
        bytes: draft.barcode.bytes || null,
        text: draft.barcode.text ?? null,
        latin1: draft.barcode.latin1 ?? null,
        isBinary: Boolean(draft.barcode.isBinary),
      }
      : null,

    /**
     * A picture of a barcode we could not decode.
     *
     * Kept so the pass can still show something scannable. These are the original
     * pixels, which is why it is stored rather than regenerated — there is nothing to
     * regenerate it from.
     */
    barcodeImage: draft.barcodeImage || null,

    /**
     * A picture of the page as the app read it.
     *
     * Set after this function returns, since it needs the ingested document rather than
     * the draft. Declared here so the record's shape is complete in one place — and so
     * that export, import and the storage estimate all see it.
     */
    snapshot: null,

    colours: draft.colours || null,
    logo: draft.logo || null,

    departsAt: departureTimestamp(draft),
    addedAt: Date.now(),
    updatedAt: Date.now(),
    source,
    archived: false,
  };
}

/**
 * When this journey begins, as a timestamp.
 *
 * Used only for ordering and for deciding what is "next" — never shown. The displayed
 * time is always the wall-clock string printed on the ticket, because a train leaves at
 * 22:40 local whatever timezone the phone believes it is in.
 */
function departureTimestamp(draftOrRecord) {
  const value = (key) => (
    typeof draftOrRecord.value === 'function'
      ? draftOrRecord.value(key)
      : draftOrRecord.fields?.[key] || ''
  );

  const date = value('date');
  if (!date) return null;

  const time = value('departureTime') || value('startTime') || value('boardingTime') || '00:00';
  const stamp = Date.parse(`${date}T${time.length === 5 ? time : '00:00'}:00`);
  return Number.isNaN(stamp) ? null : stamp;
}

// ────────────────────────────── operations ──────────────────────────────

/**
 * Turns a saved ticket back into an editable draft.
 *
 * The inverse of `fromDraft`. Editing reuses the review screen rather than growing a
 * second editor that would slowly drift from it, and this is what makes that possible.
 *
 * Everything comes back marked as already settled — confirmed, at the confidence it was
 * saved with — because the user has seen these values before and agreed to them. Asking
 * them to re-approve every field just to correct one would be a poor trade.
 */
export function toDraft(record) {
  if (!record) return null;

  const draft = new TicketDraft({
    type: record.kind,
    style: record.style || 'generic',
    transitType: record.transitType || null,
    adapter: record.kind,
  });

  for (const [key, value] of Object.entries(record.fields || {})) {
    const provenance = record.provenance?.[key] || {};

    const field = draft.set(key, new Field({
      key,
      label: provenance.label || key,
      value,
      source: provenance.source || Source.INFERRED,
      confidence: provenance.confidence || Confidence.MEDIUM,
      critical: Boolean(provenance.critical),
      note: provenance.note || null,
    }));

    field.confirmed = true;
    field.edited = Boolean(provenance.edited);
  }

  draft.barcode = record.barcode || null;
  draft.barcodeImage = record.barcodeImage || null;
  // Carried so an edit does not silently discard the picture of the page. There is no
  // document behind an edit, so there is nothing to recapture from.
  draft.snapshot = record.snapshot || null;
  draft.colours = record.colours || null;
  draft.logo = record.logo || null;
  draft.originName = record.originName || null;
  draft.destinationName = record.destinationName || null;
  draft.passengers = record.passengers || null;
  draft.additionalLegs = record.additionalLegs || null;
  draft.allSeats = record.allSeats || null;

  // Warnings describe how the ticket was read, which has not changed; carrying them into
  // an edit would repeat advice the user has already acted on.
  draft.warnings = [];

  return draft;
}

export async function save(record) {
  const next = { ...record, updatedAt: Date.now() };
  await transact('readwrite', (store) => store.put(next));
  return next;
}

export function get(id) {
  return transact('readonly', (store) => store.get(id));
}

export function remove(id) {
  return transact('readwrite', (store) => store.delete(id));
}

export async function all() {
  const records = await transact('readonly', (store) => store.getAll());
  return records || [];
}

export async function clear() {
  await transact('readwrite', (store) => store.clear());
}

/**
 * Splits saved tickets into what is ahead and what is past.
 *
 * A journey stays in "upcoming" for six hours after its departure time, because a
 * delayed train is still the ticket you need to show, and a pass that files itself away
 * while its holder is still standing on the platform has failed them.
 *
 * Undated tickets sort to the top of upcoming rather than being hidden: we could not
 * read a date, which is a reason to keep them visible, not to bury them.
 */
const GRACE_MS = 6 * 60 * 60 * 1000;

export function partition(records, now = Date.now()) {
  const upcoming = [];
  const past = [];

  for (const record of records) {
    if (record.archived) { past.push(record); continue; }
    if (record.departsAt === null || record.departsAt === undefined) { upcoming.push(record); continue; }
    if (record.departsAt + GRACE_MS >= now) upcoming.push(record);
    else past.push(record);
  }

  upcoming.sort((a, b) => {
    if (a.departsAt == null) return -1;
    if (b.departsAt == null) return 1;
    return a.departsAt - b.departsAt;
  });
  past.sort((a, b) => (b.departsAt || b.addedAt) - (a.departsAt || a.addedAt));

  return { upcoming, past };
}

/** The one the app opens to. */
export function next(records, now = Date.now()) {
  return partition(records, now).upcoming[0] || null;
}

// ────────────────────────────── backup ──────────────────────────────

const BACKUP_FORMAT = 'ticket-backup-1';

/**
 * Exports everything as a single portable file.
 *
 * Not a convenience. Deleting an installed web app deletes its storage with it on both
 * platforms — there is no "app removed, data kept" state as there is with native apps —
 * so an export is the only thing standing between a reinstall and losing every ticket.
 *
 * Deliberately plain JSON: readable, diffable, and restorable by anything, including by
 * hand. A proprietary format would be a lock-in of exactly the sort this project exists
 * to avoid.
 */
export async function exportAll() {
  const records = await all();

  return {
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    count: records.length,
    tickets: records.map((record) => ({
      ...record,
      // Uint8Array does not survive JSON; kept as a plain array and restored on import.
      barcode: record.barcode
        ? { ...record.barcode, bytes: record.barcode.bytes ? Array.from(record.barcode.bytes) : null }
        : null,
    })),
  };
}

export async function importAll(payload, { replace = false } = {}) {
  if (!payload || payload.format !== BACKUP_FORMAT) {
    throw new Error('That does not look like a Ticket backup file.');
  }

  if (replace) await clear();

  const existing = new Set((await all()).map((record) => record.id));
  let added = 0;
  let skipped = 0;

  for (const ticket of payload.tickets || []) {
    if (!replace && existing.has(ticket.id)) { skipped++; continue; }

    await save({
      ...ticket,
      barcode: ticket.barcode
        ? { ...ticket.barcode, bytes: ticket.barcode.bytes ? new Uint8Array(ticket.barcode.bytes) : null }
        : null,
    });
    added++;
  }

  return { added, skipped };
}
