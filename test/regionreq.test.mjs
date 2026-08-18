import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegionsRequest, parseRegionsResponse, CMD_SEND_ANON_REQ } from '../src/regionreq.js';

const PK = 'aa'.repeat(32);
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

test('buildRegionsRequest is [57][pubkey 32][0x01][0x00] — no app timestamp', () => {
  const f = buildRegionsRequest(PK);
  assert.equal(f.length, 1 + 32 + 2);
  assert.equal(f[0], CMD_SEND_ANON_REQ);
  assert.deepEqual(Array.from(f.slice(1, 33)), new Array(32).fill(0xaa));
  assert.equal(f[33], 0x01, 'req type');
  assert.equal(f[34], 0x00, 'reply_path_len = 0 for a zero-hop reply');
});

test('buildRegionsRequest throws on a too-short pubkey', () => {
  assert.throws(() => buildRegionsRequest('aa'.repeat(31)), TypeError);
});

test('buildRegionsRequest throws on a too-long pubkey', () => {
  assert.throws(() => buildRegionsRequest('aa'.repeat(33)), TypeError);
});

test('buildRegionsRequest throws on non-hex characters', () => {
  assert.throws(() => buildRegionsRequest('zz'.repeat(32)), TypeError);
});

test('buildRegionsRequest accepts an uppercase pubkey and lowercases it', () => {
  const f = buildRegionsRequest(PK.toUpperCase());
  assert.deepEqual(Array.from(f.slice(1, 33)), new Array(32).fill(0xaa));
});

test('parseRegionsResponse reads tag, clock and the CSV', () => {
  // [0x8C][reserved][tag 4][repeater_clock 4][CSV]
  const bytes = new Uint8Array([0x8c, 0, ...le32(0x11223344), ...le32(1755518096), ...ascii('*,be,be-vlg,be-van')]);
  const r = parseRegionsResponse(bytes);
  assert.equal(r.tag, 0x11223344);
  assert.equal(r.repeaterClock, 1755518096);
  assert.deepEqual(r.regions, ['*', 'be', 'be-vlg', 'be-van']);
  assert.equal(r.truncated, false);
});

test('parseRegionsResponse flags a CSV near the 172-byte ceiling', () => {
  const long = Array.from({ length: 24 }, (_, i) => `be-x${String(i).padStart(2, '0')}`).join(',');
  assert.ok(long.length > 160, 'fixture must exceed the flag threshold');
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), ...ascii(long)]);
  assert.equal(parseRegionsResponse(bytes).truncated, true);
});

test('parseRegionsResponse rejects a wrong code and a short frame', () => {
  assert.equal(parseRegionsResponse(new Uint8Array([0x88, 0, 1, 2])), null);
  assert.equal(parseRegionsResponse(new Uint8Array([0x8c, 0, 1, 2])), null);
  assert.equal(parseRegionsResponse(new Uint8Array()), null);
});

test('an empty CSV yields an empty list, not null', () => {
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2)]);
  assert.deepEqual(parseRegionsResponse(bytes).regions, []);
});
