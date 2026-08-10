/**
 * Diagnostic: runs the full pipeline in a browser, exactly as the app does.
 *
 * The Node diagnostics cannot render a page, so they never see an image-based barcode
 * and wrongly report that a ticket has none. This runs the real path — render, decode,
 * adapt — and shows what the app would actually produce.
 */
import { ingest } from '../js/ingest.js';
import { readBarcodesFromSource } from '../js/barcode.js';
import { buildLines } from '../js/text.js';
import { extract } from '../js/adapters/index.js';

export async function inspect(file) {
  const ingested = await ingest(file);
  const barcodes = await readBarcodesFromSource(ingested);

  let lines = [];
  if (ingested.textItems?.length) lines = buildLines(ingested.textItems);

  const draft = await extract({ lines, barcode: barcodes.primary, ingested });

  return {
    source: { kind: ingested.kind, pages: ingested.pageCount },
    barcode: barcodes.primary
      ? {
        format: barcodes.primary.format,
        text: barcodes.primary.text,
        walletCompatible: barcodes.primary.walletCompatible,
      }
      : null,
    adapter: draft.adapter,
    type: draft.type,
    score: draft.adapterScore,
    fields: Object.fromEntries(draft.list().map((field) => [field.key, {
      value: field.value,
      source: field.source,
      confidence: field.confidence,
      critical: Boolean(field.critical),
      review: field.needsReview,
    }])),
    passengers: draft.passengers || null,
    warnings: draft.warnings,
  };
}

// Exposed so a headless browser can call it against a fetched sample.
globalThis.inspectUrl = async (url, name) => {
  const response = await fetch(url);
  const blob = await response.blob();
  return inspect(new File([blob], name, { type: blob.type || 'application/pdf' }));
};
