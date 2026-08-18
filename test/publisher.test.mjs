// Drain robustness: a publish to a dead socket never acks, so publish() must time
// out (reject) instead of hanging forever — that hang is what froze the drain loop
// and left +60 receptions pending on a live WiFi connection.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { Publisher } from '../src/publisher.js';

const rec = { rx_at: 't', raw: 'aa', snr: 1, rssi: -90, lat: 0, lon: 0, acc_m: 5 };

test('publish rejects when the broker never acks (dead socket)', async () => {
  const p = new Publisher({ url: 'x' });
  p.client = { publish() { /* never invokes the callback — simulates a dead socket */ } };
  await assert.rejects(p.publish('pk', rec, 'name', 50), /publish timeout/);
});

test('publish resolves on a normal ack', async () => {
  const p = new Publisher({ url: 'x' });
  p.client = { publish(_t, _pl, _o, cb) { cb(null); } };
  await assert.doesNotReject(p.publish('pk', rec, 'name', 1000));
});

test('publish rejects on a broker error', async () => {
  const p = new Publisher({ url: 'x' });
  p.client = { publish(_t, _pl, _o, cb) { cb(new Error('nope')); } };
  await assert.rejects(p.publish('pk', rec, 'name', 1000), /nope/);
});

test('reconnect() asks the client to reconnect (manual recovery)', () => {
  const p = new Publisher({ url: 'x' });
  let called = false;
  p.client = { reconnect() { called = true; } };
  p.reconnect();
  assert.strictEqual(called, true);
});

test('reconnect() is a no-op when there is no client', () => {
  const p = new Publisher({ url: 'x' });
  assert.doesNotThrow(() => p.reconnect());
});

test('onStatus receives the event and its arg (e.g. error reason)', () => {
  const p = new Publisher({ url: 'x' });
  const seen = [];
  p.onStatus((ev, arg) => seen.push([ev, arg && arg.message]));
  p._emit('reconnect');
  p._emit('error', new Error('boom'));
  assert.deepStrictEqual(seen, [['reconnect', undefined], ['error', 'boom']]);
});

test('records without kind still go to /packets with the unchanged shape', () => {
  const rec = { rx_at: '2026-08-17T10:00:00.000Z', raw: 'aabb', snr: 4.5, rssi: -101, lat: 51.2, lon: 4.4, acc_m: 8 };
  assert.equal(Publisher.topicFor('aa11', rec), 'meshcore/client/aa11/packets');
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.equal(p.type, 'PACKET');
  assert.equal(p.raw, 'aabb');
  assert.equal(p.gps.lat, 51.2);
});

test('kind rf goes to /rf with the RF_SAMPLE shape', () => {
  const rec = { kind: 'rf', at: '2026-08-17T10:00:00.000Z', lat: 51.2, lon: 4.4, acc_m: 8,
    stationary: true, uptime_secs: 84213, noise_floor: -119, rx_air_secs: 20877 };
  assert.equal(Publisher.topicFor('aa11', rec), 'meshcore/client/aa11/rf');
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.equal(p.type, 'RF_SAMPLE');
  assert.equal(p.timestamp, '2026-08-17T10:00:00.000Z');
  assert.equal(p.stationary, true);
  assert.equal(p.noise_floor, -119);
  assert.equal(p.gps.lat, 51.2);
  assert.equal('recv_errors' in p, false, 'absent stays absent');
});

test('kind regions goes to /regions with the REGIONS shape', () => {
  const rec = { kind: 'regions', at: '2026-08-18T10:00:00.000Z', target: 'bb'.repeat(32),
    regions: ['*', 'be'], truncated: false, repeater_clock: 1755518096, lat: 51.2, lon: 4.4, acc_m: 8 };
  assert.equal(Publisher.topicFor('aa11', rec), 'meshcore/client/aa11/regions');
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.equal(p.type, 'REGIONS');
  assert.deepEqual(p.regions, ['*', 'be']);
  assert.equal(p.target, rec.target);
  assert.equal(p.gps.lat, 51.2);
});

test('an rf record and a record with no kind are unaffected by the third branch', () => {
  assert.equal(Publisher.topicFor('aa11', { kind: 'rf', at: 't' }), 'meshcore/client/aa11/rf');
  assert.equal(Publisher.topicFor('aa11', { rx_at: 't', raw: 'aa' }), 'meshcore/client/aa11/packets');
});

test('an empty regions array survives the wire as [], not dropped or coerced', () => {
  const rec = { kind: 'regions', at: '2026-08-18T10:00:00.000Z', target: 'cc'.repeat(32),
    regions: [], truncated: false, repeater_clock: 1755518096, lat: null, lon: null, acc_m: null };
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.deepEqual(p.regions, []);
});

test('truncated is carried faithfully, true and false alike', () => {
  const base = { kind: 'regions', at: 't', target: 'dd'.repeat(32), regions: ['*'],
    repeater_clock: 1, lat: null, lon: null, acc_m: null };
  assert.equal(Publisher.payloadFor('aa11', { ...base, truncated: true }, 'node').truncated, true);
  assert.equal(Publisher.payloadFor('aa11', { ...base, truncated: false }, 'node').truncated, false);
});
