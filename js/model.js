/**
 * The field model — every value the user sees carries where it came from and how much
 * we trust it.
 *
 * This exists because the tool's honesty is its product. A value read from a barcode
 * is a fact; a value guessed from a blurry photograph is a suggestion. Presenting both
 * identically would be a lie of omission, and would also produce verification fatigue:
 * if everything is flagged, nothing is checked.
 *
 * Friction is therefore proportional to doubt — only LOW-confidence fields block the
 * download until confirmed.
 */

export const Source = {
  BARCODE: 'barcode',
  PDF_TEXT: 'pdf-text',
  OCR: 'ocr',
  INFERRED: 'inferred',
  USER: 'user',
};

export const Confidence = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  MISSING: 'missing',
};

const SOURCE_LABEL = {
  [Source.BARCODE]: 'From barcode',
  [Source.PDF_TEXT]: 'From PDF text',
  [Source.OCR]: 'Read from image',
  [Source.INFERRED]: 'Worked out',
  [Source.USER]: 'You edited this',
};

const SOURCE_SHORT = {
  [Source.BARCODE]: 'BARCODE',
  [Source.PDF_TEXT]: 'PDF',
  [Source.OCR]: 'OCR',
  [Source.INFERRED]: 'INFERRED',
  [Source.USER]: 'EDITED',
};

/** Baseline trust per source, before validators and cross-checks adjust it. */
const BASE_CONFIDENCE = {
  [Source.BARCODE]: Confidence.HIGH,
  [Source.PDF_TEXT]: Confidence.MEDIUM,
  [Source.OCR]: Confidence.LOW,
  [Source.INFERRED]: Confidence.LOW,
  [Source.USER]: Confidence.HIGH,
};

export class Field {
  constructor({
    key,
    label,
    value = '',
    source = Source.INFERRED,
    confidence = null,
    region = null,
    note = null,
    type = 'text',
    required = false,
    critical = false,
    options = null,
  }) {
    this.key = key;
    this.label = label;
    this.value = value;
    this.source = source;
    this.confidence = confidence || (value ? BASE_CONFIDENCE[source] : Confidence.MISSING);
    /** Bounding box in source coordinates, so the UI can highlight where this came from. */
    this.region = region;
    this.note = note;
    this.type = type;
    this.required = required;
    /**
     * Whether being wrong here stops the journey.
     *
     * A booking reference, a service number and a travel date are not merely important
     * fields — they are the ones a gate agent checks, and a plausible-looking wrong
     * value is as disabling as a blank one. Unlike ordinary fields these are not
     * trusted at medium confidence; they must be corroborated, barcode-sourced, or
     * looked at by the user.
     */
    this.critical = critical;
    this.options = options;
    this.confirmed = false;
    this.edited = false;
    /** Populated by validators; a non-empty list forces review. */
    this.issues = [];
    /** Set when a second source independently produced the same value. */
    this.corroboratedBy = null;
    this.originalValue = value;
  }

  /**
   * A field needs attention when we are not confident, or when a validator objected.
   * Barcode-sourced values are exempt unless something actively contradicts them.
   */
  get needsReview() {
    if (this.confirmed || this.edited) return false;
    if (this.issues.some((issue) => issue.severity === 'error')) return true;
    if (this.required && !this.value) return true;

    // An empty optional field is absent, not doubtful.
    //
    // Review exists for values we might have got wrong; there is nothing to check about
    // a gate that has not been assigned yet. Worse, an empty field shows no "That's
    // right" chip — there is no value to affirm — so it could not be cleared at all, and
    // an itinerary printed before gates are announced could never be saved.
    if (!this.value) return false;

    if (this.confidence === Confidence.LOW) return true;

    // Critical fields get no benefit of the doubt. Anything short of a barcode reading
    // or two sources agreeing is shown to the user, because the cost of a wrong booking
    // reference is a journey not taken.
    if (this.critical && this.confidence !== Confidence.HIGH) return true;

    return false;
  }

  get sourceLabel() { return SOURCE_LABEL[this.source] || ''; }
  get sourceShort() { return SOURCE_SHORT[this.source] || ''; }

  /** Raises confidence when an independent source agrees — the core of cross-validation. */
  corroborate(otherSource) {
    this.corroboratedBy = otherSource;
    if (this.confidence === Confidence.MEDIUM || this.confidence === Confidence.LOW) {
      this.confidence = Confidence.HIGH;
    }
    return this;
  }

  /** Records a disagreement. Never auto-resolves — the user decides which is right. */
  conflict(otherValue, otherSource) {
    this.issues.push({
      severity: 'error',
      code: 'conflict',
      message: `The ${describeSource(otherSource)} says "${otherValue}" instead.`,
      alternative: otherValue,
    });
    this.confidence = Confidence.LOW;
    return this;
  }

  warn(message, code = 'check') {
    this.issues.push({ severity: 'warning', code, message });
    if (this.confidence === Confidence.HIGH) this.confidence = Confidence.MEDIUM;
    return this;
  }

  /**
   * Applies an automatic correction, recording what changed. Silent correction would
   * be dishonest; the user is told and can revert.
   */
  autoCorrect(newValue, reason) {
    if (newValue === this.value) return this;
    this.issues.push({
      severity: 'info',
      code: 'auto-corrected',
      message: reason,
      previous: this.value,
    });
    this.value = newValue;
    return this;
  }

  setByUser(value) {
    this.value = value;
    this.source = Source.USER;
    this.confidence = value ? Confidence.HIGH : Confidence.MISSING;
    this.edited = true;
    // Touching a field is approval of what it now says, whether or not the text changed.
    this.confirmed = true;
    this.issues = this.issues.filter((issue) => issue.severity === 'info');
    return this;
  }

  /**
   * The user has seen this value and accepted it.
   *
   * Confidence is raised as well as the flag being set. Leaving it low meant everything
   * downstream — the badge in review, the "?" on the pass, whether the field blocks
   * saving — kept treating an approved value as doubtful, and the user's answer appeared
   * to do nothing at all.
   */
  confirm() {
    this.confirmed = true;
    if (this.confidence === Confidence.LOW || this.confidence === Confidence.MISSING) {
      this.confidence = Confidence.MEDIUM;
    }
    this.issues = this.issues.filter((issue) => issue.severity === 'info');
    return this;
  }
}

function describeSource(source) {
  return { [Source.BARCODE]: 'barcode', [Source.PDF_TEXT]: 'PDF text', [Source.OCR]: 'scanned image' }[source] || 'other source';
}

/**
 * A complete extracted ticket — the single shape every adapter produces and every
 * consumer reads, so the UI never needs to know whether this came from a boarding
 * pass barcode or a photograph of a cinema stub.
 */
export class TicketDraft {
  constructor({ type, style, transitType = null, adapter, confidence = Confidence.MEDIUM }) {
    /** Our semantic type: 'flight' | 'movie' | 'event' | 'rail' | 'generic'. */
    this.type = type;
    /** Apple pass style: boardingPass | eventTicket | coupon | storeCard | generic. */
    this.style = style;
    this.transitType = transitType;
    this.adapter = adapter;
    this.adapterConfidence = confidence;
    this.fields = new Map();
    this.barcode = null;
    this.warnings = [];
    this.colors = null;
  }

  set(key, definition) {
    const field = definition instanceof Field ? definition : new Field({ key, ...definition });
    this.fields.set(key, field);
    return field;
  }

  get(key) { return this.fields.get(key) || null; }
  value(key) { return this.fields.get(key)?.value || ''; }
  has(key) { return Boolean(this.fields.get(key)?.value); }

  list() { return [...this.fields.values()]; }

  get fieldsNeedingReview() {
    return this.list().filter((field) => field.needsReview);
  }

  /**
   * The fields a gate agent actually checks.
   *
   * Kept as an explicit list rather than inferred, so that adding a ticket type cannot
   * accidentally demote a booking reference to an ordinary field.
   */
  get criticalFields() {
    return this.list().filter((field) => field.critical);
  }

  /** Critical fields that are missing outright — the pass would be useless without them. */
  get missingCritical() {
    return this.criticalFields.filter((field) => !field.value);
  }

  get isReadyToBuild() {
    return this.fieldsNeedingReview.length === 0;
  }

  /** Summary for the UI header: how much of this was actually certain. */
  get confidenceSummary() {
    const fields = this.list().filter((f) => f.value);
    const counts = { high: 0, medium: 0, low: 0 };
    for (const field of fields) {
      if (field.confidence === Confidence.HIGH) counts.high++;
      else if (field.confidence === Confidence.MEDIUM) counts.medium++;
      else counts.low++;
    }
    return { ...counts, total: fields.length, needsReview: this.fieldsNeedingReview.length };
  }
}
