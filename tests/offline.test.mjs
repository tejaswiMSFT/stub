/**
 * The service worker's cache list against the files that actually exist.
 *
 * A hand-written asset list drifts silently. This one did: five modules and two adapters
 * were added over months and never listed, so the app opened offline to a blank screen —
 * a worse failure than not loading at all, because it looks like it works until the
 * moment it is needed. A ticket app that fails with no signal has failed entirely.
 *
 * Checked here rather than only in tools/probe-offline.mjs so that adding a module and
 * forgetting the cache list breaks the build, not someone's journey.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

const source = await readFile(new URL('sw.js', root), 'utf8');
const listed = new Set(
  [...source.matchAll(/'\.\/([^']*)'/g)].map((match) => match[1]).filter(Boolean),
);

/** Every .js under a directory, recursively, as paths relative to the project root. */
async function scripts(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(new URL(dir, root), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...await scripts(`${dir}${entry.name}/`, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.js')) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

test('every application module is cached for offline use', async () => {
  const modules = await scripts('js/');

  const missing = modules.filter((file) => !listed.has(`js/${file}`));

  assert.deepEqual(missing, [],
    `these modules are not in the service worker's ASSETS list, so the app will break `
    + `offline — which is exactly where a ticket is needed:\n  ${missing.join('\n  ')}`);
});

test('the cache list names no file that has been deleted or renamed', async () => {
  const modules = new Set((await scripts('js/')).map((file) => `js/${file}`));

  const stale = [...listed]
    .filter((entry) => entry.startsWith('js/'))
    .filter((entry) => !modules.has(entry));

  // A missing file does not fail installation — assets are cached individually for
  // exactly that reason — but it means the list is lying about what it covers.
  assert.deepEqual(stale, [], `listed but no longer present:\n  ${stale.join('\n  ')}`);
});

test('the version is bumped when assets change', async () => {
  const version = source.match(/const VERSION = '([^']+)'/)?.[1];
  assert.ok(version, 'the service worker must declare a VERSION');

  // Returning users keep the old app until this changes, so it is worth stating loudly
  // that it exists rather than discovering it when a fix fails to reach anyone.
  assert.match(version, /^v\d+$/, 'VERSION should look like v1, v2, …');
});
