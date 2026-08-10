/**
 * Email parsing verification.
 *
 * The MIME layer is worth testing precisely because its failures are silent: a
 * mis-decoded base64 part yields a corrupt QR image rather than an error, and a
 * mangled charset yields a passenger name that looks merely odd. Both would reach the
 * user as a confidently-wrong pass.
 *
 * Only the pure parsing layer is covered here. Layout needs a real browser, so it is
 * exercised through tools/serve.mjs rather than in Node.
 */
import { parseMessage, providerFromSender, looksLikeMessage, looksLikeHtml, itemsFromPlainText, rankBarcodeCandidates } from '../js/email.js';

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}

const crlf = (lines) => lines.join('\r\n');

// A 1x1 transparent PNG, used as a stand-in for an inline barcode image.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ── multipart/related: the shape a mail client produces for an inline barcode ──

const inlineBarcodeMail = crlf([
  'From: "IndiGo Bookings" <noreply@email.goindigo.in>',
  'Subject: =?UTF-8?B?WW91ciBib2FyZGluZyBwYXNz?=',
  'Date: Sat, 8 Aug 2026 09:14:00 +0530',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="OUTER"',
  '',
  '--OUTER',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body><h1>6E 6259</h1><p>Seat 15K =E2=80=94 Gate B</p>',
  '<img src=3D"cid:barcode@indigo" alt=3D"Boarding pass QR code"></body></html>',
  '',
  '--OUTER',
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <barcode@indigo>',
  '',
  PNG_BASE64,
  '',
  '--OUTER--',
  '',
]);

const inline = parseMessage(inlineBarcodeMail);

check('decodes an encoded-word subject', inline.subject, 'Your boarding pass');
check('extracts the sender display name', inline.fromName, 'IndiGo Bookings');
check('extracts the sender domain', inline.fromDomain, 'email.goindigo.in');
check('finds the HTML body', inline.html.includes('6E 6259'), true);
check('decodes quoted-printable UTF-8 as bytes, not characters', inline.html.includes('Seat 15K — Gate B'), true);
check('unescapes quoted-printable soft breaks in attributes', inline.html.includes('src="cid:barcode@indigo"'), true);
check('registers the inline image under its Content-ID', inline.resources.has('cid:barcode@indigo'), true);
check('decodes the image to its true byte length', inline.resources.get('cid:barcode@indigo').size, 70);
check('treats an inline image as a resource, not an attachment', inline.attachments.length, 0);

// A no-reply display name must not become the brand shown on the pass.
check('derives the provider from the domain when the name is generic',
  providerFromSender({ fromName: 'IndiGo Bookings', fromDomain: 'email.goindigo.in' }), 'IndiGo Bookings');
check('strips mail subdomains when falling back to the domain',
  providerFromSender({ fromName: 'no-reply', fromDomain: 'email.goindigo.in' }), 'Goindigo');
check('refuses to brand a pass from a personal mailbox',
  providerFromSender({ fromName: 'do not reply', fromDomain: 'gmail.com' }), null);

// ── multipart/mixed with a PDF: the envelope case ──

const attachedMail = crlf([
  'From: bookings@cinemaco.example',
  'Subject: Your tickets',
  'Content-Type: multipart/mixed; boundary="MIX"',
  '',
  '--MIX',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'Your tickets are attached.',
  '',
  '--MIX',
  'Content-Type: application/pdf; name="tickets.pdf"',
  'Content-Disposition: attachment; filename="tickets.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '',
  '--MIX--',
  '',
]);

const attached = parseMessage(attachedMail);
check('finds a PDF attachment', attached.attachments.map((a) => a.name), ['tickets.pdf']);
check('decodes the attachment bytes', attached.attachments[0].size, 9);
check('still reads the plain-text body', attached.text.trim(), 'Your tickets are attached.');

// ── an unstructured plain-text mail is still a ticket ──

const plainMail = crlf([
  'From: tickets@rail.example',
  'Subject: Booking confirmed',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'PNR  6A2B9C',
  'LON   ->  EDI   09:15',
  '',
]);

const plain = parseMessage(plainMail);
check('reads a single-part message body', plain.text.includes('6A2B9C'), true);
check('reports no HTML for a plain-text mail', plain.html, null);

// Monospace alignment is the only column signal plain text has, so it must survive.
const items = itemsFromPlainText('AB   CD\nEF   GH');
check('lays out plain text on a character grid', items.map((i) => [i.text, i.x, i.y]),
  [['AB', 0, 0], ['CD', 35, 0], ['EF', 0, 16], ['GH', 35, 16]]);

// ── source sniffing ──

check('recognises a saved message by its headers', looksLikeMessage(inlineBarcodeMail), true);
check('does not mistake HTML for a message', looksLikeMessage('<html><body>Hi</body></html>'), false);
check('recognises pasted HTML', looksLikeHtml('  <table><tr><td>Ticket</td></tr></table>'), true);

// ── barcode candidate ranking ──

const ranked = rankBarcodeCandidates([
  { loaded: true, naturalWidth: 220, naturalHeight: 220, alt: 'QR code', width: 220, height: 220 },
  { loaded: true, naturalWidth: 300, naturalHeight: 60, alt: 'Airline logo', width: 300, height: 60 },
  { loaded: true, naturalWidth: 1, naturalHeight: 1, alt: '', width: 1, height: 1 },
  { loaded: false, naturalWidth: 400, naturalHeight: 400, alt: 'qr', width: 400, height: 400 },
]);
check('ranks a square QR above a wide logo', ranked[0].alt, 'QR code');
check('discards tracking pixels and unloaded images', ranked.length, 2);

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
