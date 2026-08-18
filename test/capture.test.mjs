import { test } from 'node:test';
import assert from 'node:assert';
import { buildRfLogRecord } from '../src/capture.js';

const FIX = { lat: 51.05, lon: 3.72, acc_m: 10 };
const BASE = {
  hk: null, fullRfLog: true, rawHex: 'aabbcc', snr: -7, rssi: -92,
  fix: FIX, captureAllowed: true, nowISO: '2026-08-17T12:00:00.000Z',
};

test('unattributable reception is queued when fullRfLog is on', () => {
  const rec = buildRfLogRecord(BASE);
  assert.ok(rec);
  // Shape is the MQTT contract — it must match the coverage record exactly.
  assert.deepStrictEqual(Object.keys(rec).sort(),
    ['acc_m', 'lat', 'lon', 'raw', 'rssi', 'rx_at', 'snr'].sort());
  assert.strictEqual(rec.raw, 'aabbcc');
  assert.strictEqual(rec.rx_at, '2026-08-17T12:00:00.000Z');
  assert.strictEqual(rec.lat, 51.05);
});

test('returns null when fullRfLog is off', () => {
  assert.strictEqual(buildRfLogRecord({ ...BASE, fullRfLog: false }), null);
});

test('returns null for an attributable reception — coverage owns it', () => {
  const hk = { heardKey: '152c', heardKeyLen: 2, src: 'rxlog' };
  assert.strictEqual(buildRfLogRecord({ ...BASE, hk }), null);
});

test('returns null without a GPS fix', () => {
  assert.strictEqual(buildRfLogRecord({ ...BASE, fix: null }), null);
});

test('returns null while stationary', () => {
  assert.strictEqual(buildRfLogRecord({ ...BASE, captureAllowed: false }), null);
});
