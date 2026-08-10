/**
 * Tests for the local store.
 *
 * The partitioning rules matter more than they look: deciding what counts as "next" is
 * what the whole home screen rests on, and getting the grace period wrong would file a
 * ticket away while its holder is still standing on the platform.
 *
 * IndexedDB is absent in Node, so the pure functions are tested directly. They are
 * deliberately written to be pure for exactly this reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { partition, next } from '../js/store.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-16T12:00:00Z');

function ticket(id, departsAt, extra = {}) {
  return { id, departsAt, addedAt: NOW, archived: false, fields: {}, ...extra };
}

test('partitioning', async (t) => {
  await t.test('separates what is ahead from what is past', () => {
    const { upcoming, past } = partition([
      ticket('a', NOW + 2 * HOUR),
      ticket('b', NOW - 48 * HOUR),
      ticket('c', NOW + 24 * HOUR),
    ], NOW);

    assert.deepEqual(upcoming.map((r) => r.id), ['a', 'c']);
    assert.deepEqual(past.map((r) => r.id), ['b']);
  });

  await t.test('keeps a just-departed journey visible', () => {
    // A delayed train is still the ticket you need to show.
    const { upcoming } = partition([ticket('a', NOW - 3 * HOUR)], NOW);
    assert.equal(upcoming.length, 1, 'three hours after departure it must still be to hand');
  });

  await t.test('files a journey away once the grace period has passed', () => {
    const { past } = partition([ticket('a', NOW - 7 * HOUR)], NOW);
    assert.equal(past.length, 1);
  });

  await t.test('keeps an undated ticket visible rather than hiding it', () => {
    // Failing to read a date is a reason to keep it in sight, not to bury it.
    const { upcoming } = partition([ticket('a', null)], NOW);
    assert.equal(upcoming.length, 1);
  });

  await t.test('sorts upcoming by departure, soonest first', () => {
    const { upcoming } = partition([
      ticket('later', NOW + 48 * HOUR),
      ticket('soon', NOW + 1 * HOUR),
      ticket('middle', NOW + 12 * HOUR),
    ], NOW);

    assert.deepEqual(upcoming.map((r) => r.id), ['soon', 'middle', 'later']);
  });

  await t.test('puts undated tickets at the top of upcoming', () => {
    const { upcoming } = partition([
      ticket('dated', NOW + 1 * HOUR),
      ticket('undated', null),
    ], NOW);

    assert.equal(upcoming[0].id, 'undated', 'it needs attention, so it should not be buried');
  });

  await t.test('sorts past by most recent first', () => {
    const { past } = partition([
      ticket('old', NOW - 200 * HOUR),
      ticket('recent', NOW - 20 * HOUR),
    ], NOW);

    assert.deepEqual(past.map((r) => r.id), ['recent', 'old']);
  });

  await t.test('respects an explicitly archived ticket', () => {
    const { upcoming, past } = partition([ticket('a', NOW + 5 * HOUR, { archived: true })], NOW);
    assert.equal(upcoming.length, 0);
    assert.equal(past.length, 1);
  });
});

test('choosing what is next', async (t) => {
  await t.test('picks the soonest upcoming journey', () => {
    const chosen = next([
      ticket('later', NOW + 48 * HOUR),
      ticket('soon', NOW + 2 * HOUR),
    ], NOW);

    assert.equal(chosen.id, 'soon');
  });

  await t.test('returns nothing when everything is past', () => {
    assert.equal(next([ticket('a', NOW - 100 * HOUR)], NOW), null);
  });

  await t.test('returns nothing when there are no tickets', () => {
    assert.equal(next([], NOW), null);
  });
});
