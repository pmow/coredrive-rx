// The cumulative release-notes rule (AGENTS.md) was broken on nine tags in a row before
// anyone noticed, because it lived only in a human's memory. These tests cover the two
// ways an automated assembler can still get it wrong: ordering versions as strings, and
// publishing a tag that has no notes at all.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { compareTags, assembleBody } from '../scripts/release-notes.mjs';

const E = (tag, text) => ({ tag, text });

test('versions sort by number, so v1.10.0 is newer than v1.9.1', () => {
  const sorted = ['v1.9.1', 'v1.10.0', 'v1.2.0', 'v1.11.3'].sort(compareTags);
  assert.deepStrictEqual(sorted, ['v1.11.3', 'v1.10.0', 'v1.9.1', 'v1.2.0']);
});

test('a body carries the named release and every older one, newest first', () => {
  const body = assembleBody([E('v1.0.0', 'zero'), E('v1.2.0', 'two'), E('v1.1.0', 'one')], 'v1.2.0');
  assert.match(body, /^two/);
  assert.ok(body.indexOf('two') < body.indexOf('one'));
  assert.ok(body.indexOf('one') < body.indexOf('zero'));
});

test('a body never carries a release newer than the one being published', () => {
  const body = assembleBody([E('v1.0.0', 'zero'), E('v1.1.0', 'one'), E('v1.2.0', 'two')], 'v1.1.0');
  assert.ok(!body.includes('two'));
  assert.ok(body.includes('one') && body.includes('zero'));
});

test('sections are separated, so two releases cannot run together', () => {
  const body = assembleBody([E('v1.0.0', 'zero'), E('v1.1.0', 'one')], 'v1.1.0');
  assert.match(body, /one\n+---\n+zero/);
});

test('a tag with no notes file is refused, which is what fails the release job', () => {
  assert.throws(() => assembleBody([E('v1.0.0', 'zero')], 'v1.1.0'), /v1\.1\.0/);
});
