/**
 * Adapter barrel.
 *
 * Adapters register themselves as a side effect of being imported, so something has to
 * import them or the registry stays empty. Collecting that here means the rest of the
 * app depends on one module rather than on an import list it must remember to update.
 *
 * Import order does not affect selection — `selectAdapter` sorts by score — but it is
 * kept most-specific-first so the registry reads in the order a person would reason.
 */

import './flight.js';
import './rail.js';
import './event.js';
import './lodging.js';
// Last, and it accepts almost nothing: the fallback for a ticket we could not identify
// but whose barcode we could read — a screenshot, typically.
import './generic.js';

export { selectAdapter, extract, registry } from './registry.js';
