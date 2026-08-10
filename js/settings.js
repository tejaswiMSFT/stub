/**
 * User settings.
 *
 * Kept in localStorage rather than IndexedDB: these are a handful of small values read
 * on every launch, and waiting on a database transaction to know which theme to paint
 * would cost a visible flash.
 *
 * The defaults matter more than the mechanism. Every one of them is chosen so that a
 * user who never opens this screen loses nothing: tickets are kept, not purged, and
 * nothing is deleted without being asked for. Destructive behaviour is opted into.
 */

const KEY = 'stub.settings';

/**
 * How long a ticket survives after its journey.
 *
 * `keep` is the default and always will be. Someone who never opened Settings should
 * never discover that a booking reference they needed for a refund was quietly deleted
 * — and refunds, expense claims and disputes all arrive weeks after travel.
 */
export const RETENTION = {
  keep: { id: 'keep', label: 'Keep them', note: 'Nothing is ever deleted automatically.', days: null },
  days30: { id: 'days30', label: 'Delete after 30 days', note: 'Long enough for most refunds and expense claims.', days: 30 },
  days7: { id: 'days7', label: 'Delete after 7 days', note: 'A week after you travel.', days: 7 },
  immediate: { id: 'immediate', label: 'Delete straight away', note: 'Removed six hours after departure.', days: 0 },
};

const DEFAULTS = {
  retention: 'keep',
  keepAwake: true,
  theme: 'auto',
  // Set once the user has been shown the warning about app removal, so it is not
  // repeated at them forever.
  acknowledgedRemoval: false,
};

let cache = null;

export function settings() {
  if (cache) return cache;

  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    cache = { ...DEFAULTS, ...stored };
  } catch {
    // Private browsing, or corrupted JSON. Defaults are safe by construction.
    cache = { ...DEFAULTS };
  }

  return cache;
}

export function update(changes) {
  cache = { ...settings(), ...changes };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Nothing to be done; the choice lasts the session.
  }
  return cache;
}

export function retention() {
  return RETENTION[settings().retention] || RETENTION.keep;
}

/**
 * Decides which tickets automatic deletion should remove.
 *
 * Pure, and separated from the deleting so it can be tested without a database. The
 * grace period matches the store's: a journey is not "past" the moment it was due to
 * depart, because delays are ordinary and the ticket is still the one being shown.
 *
 * Returns nothing at all when retention is `keep`, which is the default — so in the
 * ordinary case this function deletes nothing and can be called freely.
 */
const GRACE_MS = 6 * 60 * 60 * 1000;

export function expiredTickets(tickets, { now = Date.now(), rule = null } = {}) {
  const policy = rule || retention();
  if (policy.days === null) return [];

  const cutoff = now - GRACE_MS - policy.days * 24 * 60 * 60 * 1000;

  return tickets.filter((ticket) => {
    // A ticket whose date we could not read is never deleted automatically. We do not
    // know when it is for, and guessing wrong destroys something irreplaceable.
    if (ticket.departsAt === null || ticket.departsAt === undefined) return false;
    return ticket.departsAt < cutoff;
  });
}

/** Plain-language summary of the current policy, for the interface. */
export function retentionSummary(count = 0) {
  const policy = retention();
  if (policy.days === null) {
    return count
      ? `${count} past ticket${count === 1 ? '' : 's'} kept.`
      : 'Past tickets are kept until you delete them.';
  }
  if (policy.days === 0) return 'Tickets are removed once you have travelled.';
  return `Tickets are removed ${policy.days} days after you travel.`;
}
