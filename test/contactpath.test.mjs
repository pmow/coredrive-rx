import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGetContactByKey, parseContactReply, needsPathOverride, buildOverrideFrame,
  buildRestoreFrame, encodePendingRestore, decodePendingRestore,
  CMD_GET_CONTACT_BY_KEY, CMD_ADD_UPDATE_CONTACT, RESP_CODE_CONTACT, RESP_CODE_ERR,
  ERR_CODE_NOT_FOUND, CONTACT_FRAME_LEN,
} from '../src/contactpath.js';

const PK = 'ab'.repeat(32);

// Builds a synthetic RESP_CODE_CONTACT frame (writeContactRespFrame layout) with a
// given out_path_len, filling every other field with a distinct, non-zero pattern
// so a byte-diff test can tell "touched" from "untouched".
function makeContactFrame(outPathLen) {
  const b = new Uint8Array(CONTACT_FRAME_LEN);
  b[0] = RESP_CODE_CONTACT;
  for (let i = 0; i < 32; i++) b[1 + i] = 0xab; // pub_key
  b[33] = 2;  // type
  b[34] = 1;  // flags
  b[35] = outPathLen;
  for (let i = 0; i < 64; i++) b[36 + i] = 0x11 + (i % 7); // out_path
  const name = 'repeater-under-test';
  for (let i = 0; i < name.length; i++) b[100 + i] = name.charCodeAt(i);
  const v = new DataView(b.buffer);
  v.setUint32(132, 1755518096, true); // last_advert_timestamp
  v.setInt32(136, 512345678, true);   // gps_lat
  v.setInt32(140, 41234567, true);    // gps_lon
  v.setUint32(144, 1755518200, true); // lastmod
  return b;
}

test('buildGetContactByKey is [30][pubkey 32]', () => {
  const f = buildGetContactByKey(PK);
  assert.equal(f.length, 33);
  assert.equal(f[0], CMD_GET_CONTACT_BY_KEY);
  assert.deepEqual(Array.from(f.slice(1)), new Array(32).fill(0xab));
});

test('buildGetContactByKey throws on a malformed pubkey', () => {
  assert.throws(() => buildGetContactByKey('zz'.repeat(32)), TypeError);
  assert.throws(() => buildGetContactByKey('ab'.repeat(31)), TypeError);
});

test('parseContactReply reads a found contact and its out_path_len', () => {
  const frame = makeContactFrame(5);
  const c = parseContactReply(frame);
  assert.equal(c.found, true);
  assert.equal(c.outPathLen, 5);
  assert.equal(c.raw.length, CONTACT_FRAME_LEN);
  assert.deepEqual(Array.from(c.raw), Array.from(frame));
});

test('parseContactReply reads ERR_CODE_NOT_FOUND as found:false', () => {
  const c = parseContactReply(new Uint8Array([RESP_CODE_ERR, ERR_CODE_NOT_FOUND]));
  assert.deepEqual(c, { found: false });
});

test('parseContactReply rejects a truncated RESP_CODE_CONTACT frame instead of half-parsing it', () => {
  const short = makeContactFrame(5).slice(0, CONTACT_FRAME_LEN - 1);
  assert.equal(parseContactReply(short), null);
});

test('parseContactReply rejects an unrelated error code', () => {
  assert.equal(parseContactReply(new Uint8Array([RESP_CODE_ERR, 9])), null);
});

test('parseContactReply rejects a frame with the wrong leading code', () => {
  assert.equal(parseContactReply(new Uint8Array([0x8c, 0, 0, 0])), null);
});

test('parseContactReply rejects an empty/absent frame', () => {
  assert.equal(parseContactReply(new Uint8Array([])), null);
  assert.equal(parseContactReply(null), null);
});

test('needsPathOverride: a real (non-zero) out_path_len needs an override', () => {
  assert.equal(needsPathOverride(parseContactReply(makeContactFrame(3))), true);
});

test('needsPathOverride: OUT_PATH_UNKNOWN (0xFF) needs an override', () => {
  assert.equal(needsPathOverride(parseContactReply(makeContactFrame(0xff))), true);
});

test('needsPathOverride: an already zero-hop contact needs none', () => {
  assert.equal(needsPathOverride(parseContactReply(makeContactFrame(0))), false);
});

test('needsPathOverride: a not-found contact needs none', () => {
  assert.equal(needsPathOverride(parseContactReply(new Uint8Array([RESP_CODE_ERR, ERR_CODE_NOT_FOUND]))), false);
});

test('needsPathOverride: a rejected (null) parse needs none', () => {
  assert.equal(needsPathOverride(null), false);
});

test('buildOverrideFrame differs from the original in exactly byte 0 and byte 35, otherwise byte-identical', () => {
  const original = makeContactFrame(7);
  const override = buildOverrideFrame(original);
  assert.equal(override.length, original.length);
  const diffs = [];
  for (let i = 0; i < original.length; i++) if (override[i] !== original[i]) diffs.push(i);
  assert.deepEqual(diffs, [0, 35]);
  assert.equal(override[0], CMD_ADD_UPDATE_CONTACT);
  assert.equal(override[35], 0);
});

test('buildOverrideFrame on an original with OUT_PATH_UNKNOWN also zeroes byte 35 only', () => {
  const original = makeContactFrame(0xff);
  const override = buildOverrideFrame(original);
  const diffs = [];
  for (let i = 0; i < original.length; i++) if (override[i] !== original[i]) diffs.push(i);
  assert.deepEqual(diffs, [0, 35]);
});

test('buildRestoreFrame equals the original bytes with only byte 0 rewritten', () => {
  const original = makeContactFrame(7);
  const restore = buildRestoreFrame(original);
  assert.equal(restore.length, original.length);
  const diffs = [];
  for (let i = 0; i < original.length; i++) if (restore[i] !== original[i]) diffs.push(i);
  assert.deepEqual(diffs, [0]);
  assert.equal(restore[0], CMD_ADD_UPDATE_CONTACT);
  assert.equal(restore[35], original[35], 'restore must put the original out_path_len back, not force zero-hop');
});

test('buildRestoreFrame preserves last_mod (offset 144) verbatim', () => {
  const original = makeContactFrame(7);
  const restore = buildRestoreFrame(original);
  const vOrig = new DataView(original.buffer);
  const vRestore = new DataView(restore.buffer);
  assert.equal(vRestore.getUint32(144, true), vOrig.getUint32(144, true));
});

test('encodePendingRestore / decodePendingRestore round-trip', () => {
  const raw = makeContactFrame(9);
  const json = encodePendingRestore('EE'.repeat(32), PK.toUpperCase(), raw);
  const rec = decodePendingRestore(json);
  assert.equal(rec.self, 'ee'.repeat(32));
  assert.equal(rec.target, PK);
  assert.deepEqual(Array.from(rec.raw), Array.from(raw));
});

test('decodePendingRestore rejects malformed JSON', () => {
  assert.equal(decodePendingRestore('not json'), null);
});

test('decodePendingRestore rejects a record missing fields', () => {
  assert.equal(decodePendingRestore(JSON.stringify({ self: 'aa'.repeat(32) })), null);
});

test('decodePendingRestore rejects a raw payload of the wrong length', () => {
  const bad = JSON.stringify({ self: 'aa'.repeat(32), target: 'bb'.repeat(32), raw: 'ab'.repeat(10) });
  assert.equal(decodePendingRestore(bad), null);
});

test('decodePendingRestore rejects a non-object JSON value', () => {
  assert.equal(decodePendingRestore('42'), null);
  assert.equal(decodePendingRestore('null'), null);
});
