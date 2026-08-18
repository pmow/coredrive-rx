import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRegionsRequest, parseRegionsResponse, selectNextTarget, CMD_SEND_ANON_REQ,
  parseSentAck, RESP_CODE_SENT, applyRegionsReply,
} from '../src/regionreq.js';

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

const cand = (pk, ts) => ({ pubkey: pk, advertTs: ts });

test('picks an unasked repeater', () => {
  const s = { candidates: [cand('a', 1), cand('b', 1)], answered: new Map(), demoted: new Set(), cursor: 0 };
  assert.equal(selectNextTarget(s), 'a');
});

test('skips one that already answered with the same advert timestamp', () => {
  const s = { candidates: [cand('a', 1), cand('b', 1)], answered: new Map([['a', 1]]), demoted: new Set(), cursor: 0 };
  assert.equal(selectNextTarget(s), 'b');
});

test('re-asks when the advert timestamp changed — the config may have been edited', () => {
  const s = { candidates: [cand('a', 2)], answered: new Map([['a', 1]]), demoted: new Set(), cursor: 0 };
  assert.equal(selectNextTarget(s), 'a');
});

test('returns null when every candidate is satisfied', () => {
  const s = { candidates: [cand('a', 1)], answered: new Map([['a', 1]]), demoted: new Set(), cursor: 0 };
  assert.equal(selectNextTarget(s), null);
});

test('a demoted non-answerer is only chosen once no fresh candidate remains', () => {
  const s = { candidates: [cand('a', 1), cand('b', 1)], answered: new Map(), demoted: new Set(['a']), cursor: 0 };
  assert.equal(selectNextTarget(s), 'b', 'fresh candidate wins');
  const only = { candidates: [cand('a', 1)], answered: new Map(), demoted: new Set(['a']), cursor: 0 };
  assert.equal(selectNextTarget(only), 'a', 'demoted is still retried when it is all we have');
});

test('no candidates yields null rather than throwing', () => {
  assert.equal(selectNextTarget({ candidates: [], answered: new Map(), demoted: new Set(), cursor: 0 }), null);
});

// --- RESP_CODE_SENT ack + tag-matched reply attribution ---
// The repeater rate-limits (anon_limiter) and replies after SERVER_RESPONSE_DELAY,
// and a different repeater is asked every round (60s later) — a reply delayed past
// one round can land while another target is pending. Matching by "something is
// pending" (not by tag) would attribute repeater A's regions to repeater B: wrong
// data stored as a fact. The tag exists in the protocol precisely to prevent this.

test('parseSentAck reads the tag from a RESP_CODE_SENT ack', () => {
  // [0x06][is_flood: 1][tag: 4][est_timeout: 4]
  const bytes = new Uint8Array([RESP_CODE_SENT, 0, ...le32(0x11223344), ...le32(9000)]);
  assert.deepEqual(parseSentAck(bytes), { tag: 0x11223344 });
});

test('parseSentAck rejects a wrong code and a too-short frame', () => {
  assert.equal(parseSentAck(new Uint8Array([5, 0, ...le32(1)])), null);
  assert.equal(parseSentAck(new Uint8Array([RESP_CODE_SENT, 0, 1, 2])), null);
  assert.equal(parseSentAck(null), null);
});

const reply = (tag, regions) => ({ tag, repeaterClock: 100, regions, truncated: false });

test('a reply whose tag matches the pending request is accepted and attributed to that target', () => {
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: 0x11223344 };
  const result = applyRegionsReply(pending, reply(0x11223344, ['be']));
  assert.equal(result.accepted, true);
  assert.equal(result.target, pending.target);
  assert.equal(result.advertTs, 5);
  assert.deepEqual(result.regions, ['be']);
});

test('a reply whose tag does NOT match is ignored — not attributed to the pending target', () => {
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: 0x11223344 };
  const stray = reply(0xdeadbeef, ['wrong-node-regions']);
  assert.deepEqual(applyRegionsReply(pending, stray), { accepted: false });
});

test('after a mismatched reply, the correct reply still arrives and is attributed correctly', () => {
  // applyRegionsReply is pure and does not mutate `pending` — mirroring the real
  // caller, which must only clear its pending slot on accepted:true, so the SAME
  // pending object is still valid to match against the next frame.
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: 0x11223344 };
  const stray = reply(0xdeadbeef, ['wrong-node-regions']);
  const real = reply(0x11223344, ['be', 'be-vlg']);
  assert.equal(applyRegionsReply(pending, stray).accepted, false, 'stray reply must not consume the pending slot');
  const result = applyRegionsReply(pending, real);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.regions, ['be', 'be-vlg']);
});

test('a reply is ignored when no tag has been captured yet (RESP_CODE_SENT ack not back)', () => {
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: null };
  assert.deepEqual(applyRegionsReply(pending, reply(0x11223344, ['be'])), { accepted: false });
});

test('a reply is ignored when there is no pending request at all', () => {
  assert.deepEqual(applyRegionsReply(null, reply(1, [])), { accepted: false });
});
