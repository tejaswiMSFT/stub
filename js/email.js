/**
 * Email ingestion — for tickets that never became a file.
 *
 * A large share of tickets arrive as an email body and nothing else: the barcode is an
 * inline image, the details are HTML, and there is no PDF to save. The only way to
 * carry one of these today is a screenshot, which is precisely the indignity this tool
 * exists to remove. So the email itself is treated as a first-class source.
 *
 * Three routes lead here:
 *   1. A saved message file (.eml, or .mhtml from a browser "save page")
 *   2. A pasted selection — the user selects the mail body and presses paste, which
 *      hands us text/html on the clipboard. This is the common case, because it needs
 *      no export step from the user.
 *   3. A raw .html file
 *
 * Two properties are non-negotiable here, both stemming from the privacy promise:
 *
 *   Nothing is fetched. Remote images in a marketing-styled ticket email are tracking
 *   pixels as often as they are content; loading one tells the sender when, where and
 *   on what device the mail was opened. The message is rendered under a content policy
 *   that makes remote loading impossible rather than merely discouraged, and any
 *   remote barcode is surfaced to the user as an explicit, individually consented
 *   fetch.
 *
 *   Nothing executes. Mail HTML is hostile input. It is parsed inert, stripped, and
 *   rendered in a script-less sandbox, so a crafted ticket cannot reach the page that
 *   holds the user's signing certificate.
 */

import { IngestError } from './errors.js';

// ───────────────────────────── MIME primitives ─────────────────────────────

/**
 * Decodes quoted-printable to bytes rather than to a string.
 *
 * Decoding to a string first would corrupt any multi-byte character, because a single
 * UTF-8 character arrives as two or three separate =XX escapes that only mean
 * something once reassembled as bytes. Airline and cinema mail is full of non-ASCII
 * passenger names, so this matters more than it looks.
 */
function decodeQuotedPrintable(input) {
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char !== '=') {
      bytes.push(char.charCodeAt(0) & 0xff);
      continue;
    }

    const next = input.slice(i + 1, i + 3);
    // A soft line break: "=" at end of line, joining a wrapped line.
    if (next.startsWith('\r\n')) { i += 2; continue; }
    if (next.startsWith('\n')) { i += 1; continue; }
    if (next.startsWith('\r')) { i += 1; continue; }

    if (/^[0-9a-f]{2}$/i.test(next)) {
      bytes.push(parseInt(next, 16));
      i += 2;
    } else {
      bytes.push(0x3d); // A stray '=' — keep it rather than dropping data.
    }
  }
  return new Uint8Array(bytes);
}

function decodeBase64(input) {
  const cleaned = input.replace(/[^A-Za-z0-9+/]/g, '');
  if (!cleaned) return new Uint8Array(0);
  // Mail wraps base64 at 76 columns and clients differ on whether padding survives,
  // so it is discarded above and reapplied here rather than trusted.
  const padded = cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function bytesFromLatin1(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Mail charset labels are frequently wrong or obsolete. TextDecoder rejects unknown
 * labels outright, so an unrecognised one falls back to windows-1252 — which decodes
 * every byte to something, and is what the sender almost certainly meant when they
 * wrote "iso-8859-1" over content containing smart quotes.
 */
function decodeText(bytes, charset) {
  const label = (charset || 'utf-8').toLowerCase().replace(/["']/g, '');
  for (const candidate of [label, 'utf-8', 'windows-1252']) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      // Try the next fallback.
    }
  }
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}

/** RFC 2047 encoded-words: =?UTF-8?B?...?= in Subject and From lines. */
function decodeEncodedWords(value) {
  if (!value || !value.includes('=?')) return value;

  // Adjacent encoded-words are a single logical string split to fit the line length,
  // so the whitespace between them is an artefact and must not become a space —
  // otherwise a name gets a gap in the middle of a word.
  const joined = value.replace(/\?=[ \t]+(?==\?)/g, '?=');

  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, data) => {
    const bytes = encoding.toLowerCase() === 'b'
      ? decodeBase64(data)
      // In encoded-words specifically, '_' stands for a space.
      : decodeQuotedPrintable(data.replace(/_/g, ' '));
    return decodeText(bytes, charset);
  });
}

function unfoldHeaders(block) {
  // A header value may continue on following lines that begin with whitespace.
  return block.replace(/\r?\n[ \t]+/g, ' ');
}

function parseHeaders(block) {
  const headers = new Map();
  for (const line of unfoldHeaders(block).split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    // Duplicate headers (Received, and occasionally Content-Type) keep the first.
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/** Parses `text/html; charset="utf-8"; boundary=--x` into type plus parameters. */
function parseContentType(raw) {
  const value = raw || 'text/plain';
  const [typePart, ...paramParts] = value.split(';');
  const params = {};
  for (const part of paramParts) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim().toLowerCase();
    let val = part.slice(equals + 1).trim();
    if (val.startsWith('"')) val = val.slice(1, val.lastIndexOf('"') > 0 ? val.lastIndexOf('"') : undefined);
    params[key] = val;
  }
  return { type: typePart.trim().toLowerCase() || 'text/plain', params };
}

function parseDisposition(raw) {
  if (!raw) return { type: '', filename: null };
  const { type, params } = parseContentType(raw);
  // RFC 2231 splits long filenames as filename*0, filename*1, …
  const continued = Object.keys(params)
    .filter((k) => /^filename\*\d+\*?$/.test(k))
    .sort()
    .map((k) => params[k])
    .join('');
  const filename = params.filename || params['filename*'] || continued || null;
  return { type, filename: filename ? decodeEncodedWords(stripRfc2231(filename)) : null };
}

/** filename*=UTF-8''My%20Ticket.pdf */
function stripRfc2231(value) {
  const match = value.match(/^([^']*)'([^']*)'(.*)$/);
  if (!match) return value;
  try {
    return decodeText(bytesFromLatin1(decodeURIComponent(match[3])), match[1]);
  } catch {
    return match[3];
  }
}

function splitOnce(raw) {
  // Headers end at the first blank line. Some clients emit bare LF, others CRLF.
  const match = raw.match(/\r?\n\r?\n/);
  if (!match) return { headerBlock: raw, body: '' };
  return {
    headerBlock: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

/**
 * Recursively parses a MIME entity into a flat list of leaf parts.
 *
 * Depth is capped: a malformed message can otherwise nest boundaries indefinitely and
 * take the tab down with it, which for a tool people run on a phone at a boarding gate
 * is unacceptable.
 */
function parseEntity(raw, depth = 0) {
  const { headerBlock, body } = splitOnce(raw);
  const headers = parseHeaders(headerBlock);
  const contentType = parseContentType(headers.get('content-type'));
  const encoding = (headers.get('content-transfer-encoding') || '7bit').trim().toLowerCase();

  if (contentType.type.startsWith('multipart/') && depth < 8) {
    const boundary = contentType.params.boundary;
    if (boundary) {
      const parts = [];
      const marker = `--${boundary}`;
      const segments = body.split(new RegExp(`(?:\\r?\\n|^)${escapeRegExp(marker)}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
      // The first segment is the preamble, which carries no content.
      for (const segment of segments.slice(1)) {
        if (!segment.trim()) continue;
        parts.push(...parseEntity(segment, depth + 1));
      }
      if (parts.length) {
        for (const part of parts) part.multipartType = part.multipartType || contentType.type;
        return parts;
      }
    }
  }

  let bytes;
  if (encoding === 'base64') bytes = decodeBase64(body);
  else if (encoding === 'quoted-printable') bytes = decodeQuotedPrintable(body);
  else bytes = bytesFromLatin1(body);

  const disposition = parseDisposition(headers.get('content-disposition'));

  return [{
    headers,
    contentType: contentType.type,
    charset: contentType.params.charset,
    name: disposition.filename || contentType.params.name || null,
    disposition: disposition.type,
    contentId: (headers.get('content-id') || '').replace(/^<|>$/g, '') || null,
    contentLocation: headers.get('content-location') || null,
    bytes,
  }];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ───────────────────────────── message assembly ─────────────────────────────

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i;

function isTicketAttachment(part) {
  if (!part.name && !part.contentId) return false;
  if (part.contentType === 'application/pdf') return true;
  if (IMAGE_TYPES.test(part.contentType) && part.disposition === 'attachment') return true;
  return /\.pdf$/i.test(part.name || '');
}

/**
 * Turns a raw message into the pieces we care about: a body to read, resources the
 * body references, and any attachment that might be the real ticket.
 */
export function parseMessage(rawText) {
  const parts = parseEntity(rawText);
  if (!parts.length) throw new IngestError('This message could not be read.');

  const top = parseHeaders(splitOnce(rawText).headerBlock);

  let html = null;
  let text = null;
  const resources = new Map();
  const attachments = [];

  for (const part of parts) {
    const inline = part.disposition !== 'attachment';

    if (part.contentType === 'text/html' && inline && !html) {
      html = decodeText(part.bytes, part.charset);
      continue;
    }
    if (part.contentType === 'text/plain' && inline && !text) {
      text = decodeText(part.bytes, part.charset);
      continue;
    }

    if (IMAGE_TYPES.test(part.contentType)) {
      const blob = new Blob([part.bytes], { type: part.contentType });
      const entry = { blob, contentType: part.contentType, name: part.name, size: part.bytes.length };
      // Referenced two different ways depending on whether this came from a mail
      // client (cid:) or a browser's save-as-MHTML (absolute Content-Location).
      if (part.contentId) resources.set(`cid:${part.contentId}`, entry);
      if (part.contentLocation) resources.set(part.contentLocation, entry);
      if (!part.contentId && !part.contentLocation && part.name) resources.set(part.name, entry);
    }

    if (isTicketAttachment(part)) {
      attachments.push({
        name: part.name || 'attachment',
        contentType: part.contentType,
        size: part.bytes.length,
        file: new File([part.bytes], part.name || 'attachment', { type: part.contentType }),
      });
    }
  }

  // A message with no MIME structure at all is a plain-text mail; its single part is
  // the body, and it may still be an entirely readable ticket.
  if (!html && !text && parts.length === 1) {
    text = decodeText(parts[0].bytes, parts[0].charset);
  }

  const from = decodeEncodedWords(top.get('from') || '');

  return {
    subject: decodeEncodedWords(top.get('subject') || '') || null,
    from: from || null,
    fromName: parseFromName(from),
    fromDomain: parseFromDomain(from),
    date: top.get('date') || null,
    html,
    text,
    resources,
    attachments,
  };
}

function parseFromName(from) {
  if (!from) return null;
  const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named) return named[1].trim() || null;
  return null;
}

function parseFromDomain(from) {
  const match = (from || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Derives a provider name from the sender.
 *
 * The sender is a far better provider signal than anything in the body — a mail from
 * a booking address is unambiguously from that brand, whereas the body's largest text
 * is as likely to be "Your trip is confirmed!". Used only as a hint; an adapter that
 * finds something better is free to ignore it.
 */
export function providerFromSender({ fromName, fromDomain }) {
  const noise = /^(no[\s-]?reply|do[\s-]?not[\s-]?reply|bookings?|tickets?|info|support|noreply|customer\s*care)$/i;
  if (fromName && !noise.test(fromName.trim())) {
    const cleaned = fromName.replace(/\s*(via|through)\s+.*$/i, '').trim();
    if (cleaned.length >= 2 && cleaned.length <= 40) return cleaned;
  }

  if (!fromDomain) return null;
  const generic = /^(gmail|outlook|hotmail|yahoo|icloud|proton|me|live|msn)\./i;
  if (generic.test(fromDomain)) return null;

  // "email.indigo.co.in" → "indigo": strip mail-service subdomains and the TLD.
  const labels = fromDomain.split('.').filter((label) => !/^(email|mail|e|mailer|notify|notifications|send|smtp|www|m)$/i.test(label));
  const core = labels.length > 1 ? labels[0] : fromDomain.split('.')[0];
  if (!core || core.length < 2) return null;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

// ───────────────────────────── HTML sanitisation ─────────────────────────────

const FORBIDDEN_ELEMENTS = ['script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'link', 'base', 'form', 'input', 'button', 'noscript'];

/**
 * Strips anything active from mail HTML.
 *
 * The sandbox and content policy applied at render time are the real defence; this is
 * the second layer. Both exist because the page that renders a stranger's HTML is the
 * same page that holds the user's pass-signing certificate, and one layer failing
 * should not be sufficient.
 */
export function sanitiseHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const selector of FORBIDDEN_ELEMENTS) {
    for (const element of [...doc.querySelectorAll(selector)]) element.remove();
  }

  // A meta refresh would navigate the frame the moment it renders.
  for (const meta of [...doc.querySelectorAll('meta[http-equiv]')]) {
    if (/refresh|content-security-policy/i.test(meta.getAttribute('http-equiv') || '')) meta.remove();
  }

  for (const element of [...doc.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value || '';
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      else if (/^(href|src|xlink:href|action|formaction|srcset|background|poster)$/.test(name) &&
               /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return doc;
}

/**
 * Rewrites embedded image references to local blob URLs and reports the remote ones.
 *
 * Remote images are deliberately left broken rather than silently loaded. If the
 * barcode turns out to be one of them, the user is told exactly what fetching it
 * would reveal and asked — the decision is theirs, but it must be a decision.
 */
export function resolveResources(doc, resources) {
  const objectUrls = [];
  const remote = [];

  for (const image of [...doc.querySelectorAll('img')]) {
    // srcset would let a remote candidate load even when src is local.
    image.removeAttribute('srcset');
    const src = image.getAttribute('src') || '';
    if (!src) continue;

    if (src.startsWith('data:')) continue;

    const entry = resources.get(src) ||
                  resources.get(src.replace(/^cid:/i, 'cid:')) ||
                  resources.get(decodeURIComponent(src));

    if (entry) {
      const url = URL.createObjectURL(entry.blob);
      objectUrls.push(url);
      image.setAttribute('src', url);
      image.dataset.stubResource = 'embedded';
      continue;
    }

    if (/^https?:/i.test(src)) {
      remote.push({ url: src, alt: image.getAttribute('alt') || '', element: image });
      image.dataset.stubResource = 'remote';
      image.dataset.stubRemoteUrl = src;
      image.removeAttribute('src');
      continue;
    }

    // A cid: reference with no matching part — the message was truncated or the
    // paste dropped it. Nothing to load, and nothing to fetch either.
    image.dataset.stubResource = 'missing';
    image.removeAttribute('src');
  }

  return { objectUrls, remote };
}

// ───────────────────────────── layout ─────────────────────────────

/** Wide enough for a desktop mail layout without triggering the mobile breakpoint. */
const LAYOUT_WIDTH = 760;
const MAX_LAYOUT_HEIGHT = 20000;

const FRAME_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;";

/**
 * Renders sanitised mail HTML in an inert frame and reads real geometry back.
 *
 * The alternative — inferring structure from the DOM tree — fails on mail, which is
 * built from nested tables where document order bears little relation to what the eye
 * sees. Real layout coordinates put email on exactly the same footing as PDF text, so
 * the whole downstream pipeline, including the review screen's source highlighting,
 * works unchanged.
 */
export async function layoutHtml(html, { resources = new Map(), width = LAYOUT_WIDTH } = {}) {
  if (typeof document === 'undefined') {
    throw new IngestError('Email tickets can only be read in a browser.');
  }

  const doc = sanitiseHtml(html);
  const { objectUrls, remote } = resolveResources(doc, resources);

  const frame = document.createElement('iframe');
  // No allow-scripts: nothing in the message can run. allow-same-origin is required
  // to read geometry back out, and is safe precisely because scripts cannot run.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${MAX_LAYOUT_HEIGHT}px;border:0;visibility:hidden;`;

  const head = doc.head || doc.documentElement;
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', FRAME_CSP);
  head.insertBefore(csp, head.firstChild);

  const reset = doc.createElement('style');
  reset.textContent = 'html,body{margin:0;padding:8px;background:#fff;}';
  head.appendChild(reset);

  frame.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
  document.body.appendChild(frame);

  const cleanup = () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    frame.remove();
  };

  try {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      frame.addEventListener('load', done, { once: true });
      // srcdoc frames occasionally fire load before the listener attaches.
      setTimeout(done, 1500);
    });

    const inner = frame.contentDocument;
    if (!inner) throw new IngestError('This message could not be displayed.');

    // Embedded images decode asynchronously; their boxes are wrong until they do.
    await waitForImages(inner);

    const textItems = collectTextItems(inner);
    const images = collectImages(inner);
    const contentHeight = Math.min(
      MAX_LAYOUT_HEIGHT,
      Math.max(inner.body?.scrollHeight || 0, ...textItems.map((i) => i.y + i.height), ...images.map((i) => i.y + i.height), 1),
    );

    return {
      frame,
      document: inner,
      textItems,
      images,
      remote,
      width,
      height: contentHeight,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function waitForImages(inner) {
  const images = [...inner.querySelectorAll('img')].filter((img) => img.getAttribute('src'));
  await Promise.all(images.map((img) => (img.complete
    ? Promise.resolve()
    : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 1200);
    }))));
}

/**
 * Walks visible text, emitting one item per word with its true on-screen box.
 *
 * Word granularity matches what OCR produces, so `buildLines` regroups both into the
 * same line and column structure and no downstream code needs to know which it got.
 */
function collectTextItems(inner) {
  const items = [];
  const walker = inner.createTreeWalker(inner.body || inner.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (/^(style|script|title|head)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
      const style = inner.defaultView.getComputedStyle(parent);
      // Mail routinely hides preheader text — the one-line summary shown in an inbox
      // list. Including it would put marketing copy at the top of the ticket.
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parseFloat(style.fontSize) < 2) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const range = inner.createRange();

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue;
    const style = inner.defaultView.getComputedStyle(node.parentElement);
    const weight = parseInt(style.fontWeight, 10) || 400;

    for (const match of value.matchAll(/\S+/g)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.top > MAX_LAYOUT_HEIGHT) continue;

      items.push({
        text: match[0],
        x: rect.left + inner.defaultView.scrollX,
        y: rect.top + inner.defaultView.scrollY,
        width: rect.width,
        height: rect.height,
        // Retained so a provider heading can be told from body copy by weight as
        // well as size, which is more reliable in mail than size alone.
        bold: weight >= 600,
        fontName: style.fontFamily,
      });
    }
  }

  range.detach?.();
  return items;
}

function collectImages(inner) {
  const images = [];
  for (const element of inner.querySelectorAll('img')) {
    const rect = element.getBoundingClientRect();
    const natural = { width: element.naturalWidth || 0, height: element.naturalHeight || 0 };
    images.push({
      element,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      naturalWidth: natural.width,
      naturalHeight: natural.height,
      alt: element.getAttribute('alt') || '',
      state: element.dataset.stubResource || 'embedded',
      remoteUrl: element.dataset.stubRemoteUrl || null,
      loaded: element.complete && natural.width > 0,
    });
  }
  return images;
}

/**
 * Ranks images by how much they look like a ticket barcode.
 *
 * A ticket email carries a masthead logo, social icons, a footer banner and, somewhere
 * among them, the barcode. Trying every image through the full decoder escalation
 * would be slow on a phone, so the plausible ones go first: barcodes are square (QR,
 * Aztec) or distinctly wide and short (PDF417, Code 128), and are never tiny.
 */
export function rankBarcodeCandidates(images) {
  return images
    .filter((image) => image.loaded && image.naturalWidth >= 48 && image.naturalHeight >= 24)
    .map((image) => {
      const ratio = image.naturalWidth / image.naturalHeight;
      let score = 0;

      if (ratio > 0.8 && ratio < 1.25) score += 50;           // QR or Aztec
      else if (ratio >= 2.5 && ratio <= 9) score += 35;        // PDF417 or Code 128
      else score -= 20;

      const area = image.naturalWidth * image.naturalHeight;
      score += Math.min(25, Math.round(area / 12000));
      if (area < 8000) score -= 25;

      if (/qr|barcode|bar_code|aztec|pdf417|boarding|scan|ticket/i.test(`${image.alt} ${image.remoteUrl || ''}`)) score += 30;
      if (/logo|icon|banner|header|footer|facebook|twitter|instagram|app[-_]?store|google[-_]?play|pixel|spacer|track/i.test(`${image.alt} ${image.remoteUrl || ''}`)) score -= 40;

      // A 1x1 or hairline image is a tracking pixel or a table spacer.
      if (image.naturalWidth <= 3 || image.naturalHeight <= 3) score -= 100;

      return { ...image, barcodeScore: score };
    })
    .sort((a, b) => b.barcodeScore - a.barcodeScore);
}

/** Draws an already-decoded image element onto a canvas at decoding resolution. */
export function imageToCanvas(image, { scale = 2, maxPixels = 4_000_000 } = {}) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return null;

  let effective = scale;
  if (width * height * scale * scale > maxPixels) {
    effective = Math.max(1, scale * Math.sqrt(maxPixels / (width * height * scale * scale)));
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * effective);
  canvas.height = Math.round(height * effective);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // A transparent QR over a dark page would otherwise decode as black-on-black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image.element || image, 0, 0, canvas.width, canvas.height);

  return { canvas, scale: effective };
}

/**
 * Fetches one remote image, only ever at the user's explicit instruction.
 *
 * Kept as its own narrowly-scoped function so that every call site is visible: this is
 * the only place in the project where a byte leaves the device, and it must stay that
 * way. The request is deliberately credential-free and referrer-free, so the sender
 * learns that *someone* fetched the image, but nothing about who.
 */
export async function fetchRemoteImage(url, { signal } = {}) {
  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    mode: 'cors',
    cache: 'no-store',
    signal,
  }).catch((error) => {
    throw new IngestError('That image could not be downloaded.', {
      cause: error,
      hint: 'The sender’s server may block direct downloads. Saving the image from your mail app and dropping it here always works.',
    });
  });

  if (!response.ok) {
    throw new IngestError(`That image could not be downloaded (${response.status}).`, {
      hint: 'Save the image from your mail app and drop it here instead.',
    });
  }

  const blob = await response.blob();
  if (!IMAGE_TYPES.test(blob.type || '')) {
    throw new IngestError('That link did not return an image.');
  }
  return blob;
}

// ───────────────────────────── source detection ─────────────────────────────

const MIME_HEADER = /^(?:from|to|subject|date|received|return-path|message-id|mime-version|content-type|x-[a-z0-9-]+|delivered-to|dkim-signature)\s*:/i;

/**
 * Recognises a saved message from its opening bytes.
 *
 * Extension sniffing alone is not enough: mail exported from a phone frequently
 * arrives named "message" or "Untitled", and MHTML from a browser may be ".mht",
 * ".mhtml", or nothing at all.
 */
export function looksLikeMessage(text) {
  const head = text.slice(0, 4000);
  if (/^From \S+/.test(head)) return true; // mbox-style envelope line
  const lines = head.split(/\r?\n/).slice(0, 40);

  let headerCount = 0;
  for (const line of lines) {
    if (!line.trim()) break; // Headers ended.
    if (MIME_HEADER.test(line)) headerCount++;
    else if (/^[ \t]/.test(line)) continue; // Folded continuation.
    else if (!/^[A-Za-z0-9-]+\s*:/.test(line)) return false;
  }

  return headerCount >= 2;
}

export function looksLikeHtml(text) {
  return /^\s*(<!doctype html|<html|<body|<table|<div|<meta|<span|<p[\s>])/i.test(text.slice(0, 2000));
}

/**
 * Synthesises geometry for plain-text mail so it joins the same pipeline.
 *
 * Plain text has no layout, but it does have alignment: rail and bus operators in
 * particular still send monospace-aligned tables, and column position is the only
 * thing distinguishing a departure from an arrival. Mapping character cells to a grid
 * preserves that, and `splitColumns` then reads it correctly.
 */
export function itemsFromPlainText(text, { charWidth = 7, lineHeight = 16 } = {}) {
  const items = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\S+/g)) {
      items.push({
        text: match[0],
        x: match.index * charWidth,
        y: index * lineHeight,
        width: match[0].length * charWidth,
        height: lineHeight * 0.75,
      });
    }
  });

  return items;
}
