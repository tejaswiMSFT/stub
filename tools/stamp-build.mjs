/**
 * Stamps the current commit into js/build.js and the service worker's cache name.
 *
 * Two problems this solves, both of which cost real time already:
 *
 *   1. "Are you on the latest?" could only be answered by asking someone to try again.
 *      Settings now shows a version, so it can be answered by looking.
 *   2. The service worker's VERSION had to be bumped by hand, and a forgotten bump means
 *      every returning user keeps the old app indefinitely — the fix reaches nobody.
 *      Deriving it from the commit makes forgetting impossible.
 *
 * Run before deploying:  node tools/stamp-build.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

function git(command, fallback) {
  try {
    return execSync(command, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

const commit = git('git rev-parse --short HEAD', 'unknown');
const isoDate = git('git log -1 --format=%cI', new Date().toISOString());
const count = git('git rev-list --count HEAD', '0');

const date = new Date(isoDate);
const readable = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Human-meaningful and monotonic: the number of commits, then the commit itself for
// anyone who needs to find the exact code.
//
// The "v" is not decoration. Shown bare, "25 (7ac6230)" reads as a quantity of something
// — 25 of what? — and this number is the first thing anyone quotes when reporting a
// problem. A version has to announce that it is one.
const version = `v${count} (${commit})`;

const buildFile = new URL('../js/build.js', import.meta.url);
await writeFile(buildFile, `/**
 * What build this is.
 *
 * Written by tools/stamp-build.mjs from the current git commit, so it cannot drift from
 * what was actually deployed. Shown in Settings, which turns "are you on the latest
 * version?" from a conversation into a glance.
 *
 * Do not edit by hand.
 */

export const BUILD = {
  version: ${JSON.stringify(version)},
  date: ${JSON.stringify(readable)},
  commit: ${JSON.stringify(commit)},
};
`);

// The cache name must change whenever the code does, or the service worker serves the
// old files forever. Tying it to the commit removes the chance of forgetting.
const swFile = new URL('../sw.js', import.meta.url);
const sw = await readFile(swFile, 'utf8');
const stamped = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${commit}';`);

if (stamped === sw) {
  console.error('could not find VERSION in sw.js — has it been renamed?');
  process.exit(1);
}

await writeFile(swFile, stamped);

console.log(`stamped build ${version}, ${readable}`);
console.log(`service worker cache: ticket-${commit}`);
