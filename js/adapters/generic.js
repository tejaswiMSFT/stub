/**
 * Generic adapter — the one that accepts what nothing else recognises.
 *
 * It exists for the case that matters most and was handled worst: a **screenshot of a
 * ticket**. A photographed or screenshotted stub has no text layer at all, so every
 * other adapter — all of which detect on words — scores zero, and the app refused the
 * document outright. It did so even when the barcode had decoded perfectly.
 *
 * That is the wrong answer. The barcode is the part that actually gets scanned at the
 * door; everything printed around it is there for the human. A pass carrying a correct
 * barcode is useful even if we understood nothing else about it, and the user can fill
 * in the title themselves. Refusing it helps nobody.
 *
 * So this adapter accepts on one condition: something scannable was found. It never
 * guesses what the ticket is for. Every field it cannot read is left empty and marked
 * for the user, because an empty field invites correction while a wrong one does not.
 */

import {
  register, Field, Source, Confidence, TicketDraft, toPlainText, findLabelled,
} from './registry.js';

/**
 * Accepts when a barcode was read, or when there was nothing to read at all.
 *
 * Two quite different situations, both ending here:
 *
 *   A barcode decoded but no adapter recognised the document. Common for cinema and
 *   event tickets, whose QR holds a booking reference and whose layout we do not know.
 *
 *   The document had no text layer whatsoever — a screenshot, a photograph, a scan.
 *   Refusing these was the single largest source of "this doesn't look like a ticket",
 *   and it was the wrong answer: we had not read the document and *disagreed* with it,
 *   we had not read it at all. Declining on no evidence is not a judgement, it is a
 *   shrug, and the user is left holding a ticket the app will not take.
 *
 * The distinction that keeps the electricity bill out still holds. A bill has a text
 * layer, gets read, matches no adapter, and is refused — as it should be. This only
 * catches documents where there is nothing to disagree with.
 *
 * Low score deliberately: every other adapter earns its score from evidence, and this
 * one has none. It must never win against an adapter that recognised the document.
 */
function detect(context) {
  if (context.barcode?.text || context.barcode?.bytes?.length) return 5;

  // Nothing legible on the page. Note this is `lines`, not the raw text: a scan produces
  // a document with pages and images but no words, which is exactly this case.
  const unreadable = !context.lines?.length;
  return unreadable ? 3 : 0;
}

/**
 * A booking reference, if the barcode is one.
 *
 * Cinema and event platforms encode the booking reference and nothing else — the
 * scanner resolves it against their database — so the payload is frequently the single
 * most useful fact available. BookMyShow's QR holds exactly its booking ID.
 *
 * Only a short, plain alphanumeric run qualifies. A URL, a long opaque token or a
 * structured payload is not a reference a human would be asked to quote, and printing
 * one on the face of a pass as though it were would be worse than leaving it blank.
 */
function referenceFromBarcode(text) {
  if (!text) return '';

  const value = text.trim();
  if (!/^[A-Z0-9][A-Z0-9-]{3,19}$/i.test(value)) return '';
  if (!/[A-Z]/i.test(value) && !/\d/.test(value)) return '';

  return value.toUpperCase();
}

function build(context) {
  const { barcode, lines = [] } = context;

  const draft = new TicketDraft({
    type: 'generic',
    style: 'generic',
    adapter: 'generic',
    confidence: Confidence.LOW,
  });

  // A reference printed on the page is better evidence than one inferred from the
  // barcode payload, so it is preferred where both exist.
  const printed = findLabelled(lines, [
    /\b(?:booking\s*(?:id|ref\w*|code|number)|order\s*(?:id|number)|reference|confirmation\s*(?:code|number))\b/i,
  ]);

  const fromBarcode = referenceFromBarcode(barcode?.text);
  const reference = printed?.value?.split(/\s{2,}/)[0]?.trim() || fromBarcode;

  draft.set('reference', new Field({
    key: 'reference',
    label: 'Reference',
    value: reference,
    source: printed ? Source.PDF_TEXT : (fromBarcode ? Source.BARCODE : Source.INFERRED),
    confidence: Confidence.LOW,
    region: printed?.region || null,
    critical: true,
  }));

  // Deliberately empty. We do not know what this ticket is for, and a placeholder like
  // "Ticket" printed large on a pass is worse than a blank the user is asked to fill:
  // one looks finished, the other asks for help.
  draft.set('title', new Field({
    key: 'title',
    label: 'Title',
    value: '',
    source: Source.INFERRED,
    confidence: Confidence.LOW,
    required: true,
    critical: true,
    note: 'We could not read this from your ticket — please add it.',
  }));

  const text = toPlainText(lines);

  // The barcode is the entire reason this adapter accepts a document that has one. Where
  // there is none, the pass carries only what the user types and the picture of the page.
  draft.barcode = barcode || null;

  const hasCode = Boolean(barcode?.text || barcode?.bytes?.length);

  draft.warnings.push(
    hasCode && text.trim()
      ? 'We recognised the barcode but not what this ticket is for. Please check every '
        + 'detail and add anything missing.'
      : hasCode
        ? 'We read the barcode from this image, but none of the printed text. The barcode '
          + 'is the part that gets scanned, so the pass will work — but please fill in the '
          + 'details yourself and keep the original.'
        // No code and no text: an image or a scan. Saying so plainly matters, because the
        // pass is a picture and a set of typed details, and someone who expected a
        // scannable code should find that out now rather than at a barrier.
        : 'We could not read any text or barcode from this — it looks like a photo or a '
          + 'scan. The picture is kept so you can still show it, but nothing on it can be '
          + 'scanned from the pass. Add the details yourself, and keep the original.',
  );

  return draft;
}

export const genericAdapter = register({
  name: 'generic',
  detect,
  build,
});

export { detect, build, referenceFromBarcode };
