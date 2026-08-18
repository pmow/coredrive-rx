// Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { regionsRows, REGIONS_ROWS_MAX } from '../src/regionsview.js';

const pk = (n) => n.toString(16).padStart(2, '0').repeat(32);

test('regionsRows returns [] for no answers (empty array or null)', () => {
  assert.deepEqual(regionsRows([]), []);
  assert.deepEqual(regionsRows(null), []);
});

test('regionsRows returns the last REGIONS_ROWS_MAX answers, most-recent-first', () => {
  const answers = Array.from({ length: 7 }, (_, i) => ({ target: pk(i), regions: ['be'], truncated: false }));
  const rows = regionsRows(answers);
  assert.equal(rows.length, REGIONS_ROWS_MAX);
  assert.deepEqual(rows.map((r) => r.target), [pk(6), pk(5), pk(4), pk(3), pk(2)]);
});

test('fewer than REGIONS_ROWS_MAX answers are all returned, most-recent-first', () => {
  const answers = [{ target: pk(1), regions: [], truncated: false }, { target: pk(2), regions: [], truncated: false }];
  const rows = regionsRows(answers);
  assert.deepEqual(rows.map((r) => r.target), [pk(2), pk(1)]);
});

test('a repeater that declared regions: declaresNothing is false, regions listed', () => {
  const rows = regionsRows([{ target: pk(1), regions: ['be', 'be-vlg'], truncated: false }]);
  assert.equal(rows[0].declaresNothing, false);
  assert.deepEqual(rows[0].regions, ['be', 'be-vlg']);
});

test('a repeater that declared an EMPTY list is flagged declaresNothing, not left blank', () => {
  const rows = regionsRows([{ target: pk(1), regions: [], truncated: false }]);
  assert.equal(rows[0].declaresNothing, true);
  assert.deepEqual(rows[0].regions, []);
});

test('truncated passes through as a marker on the row', () => {
  const rows = regionsRows([{ target: pk(1), regions: ['be'], truncated: true }]);
  assert.equal(rows[0].truncated, true);
  const rows2 = regionsRows([{ target: pk(1), regions: ['be'], truncated: false }]);
  assert.equal(rows2[0].truncated, false);
});

test('an already-resolved name passes through; an unresolved one is empty string', () => {
  const rows = regionsRows([{ target: pk(1), regions: [], truncated: false, name: 'BE-BRE-ON8AR' }]);
  assert.equal(rows[0].name, 'BE-BRE-ON8AR');
  const rows2 = regionsRows([{ target: pk(2), regions: [], truncated: false }]);
  assert.equal(rows2[0].name, '');
});
