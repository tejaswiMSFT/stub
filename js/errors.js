/**
 * Shared error type.
 *
 * Lives apart from the ingestion modules so that the PDF, image and email paths can
 * all throw the same thing without importing one another — a cycle that would
 * otherwise appear the moment email ingestion learned to hand a PDF attachment back
 * to the PDF reader.
 */

export class IngestError extends Error {
  constructor(message, { cause, hint } = {}) {
    super(message);
    this.name = 'IngestError';
    this.cause = cause;
    /** Plain-language next step for the user; never a library message. */
    this.hint = hint;
  }
}
