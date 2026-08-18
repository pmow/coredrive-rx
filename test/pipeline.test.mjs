// Verifies the full capture pipeline (BLE 0x88 frame → parsed packet → outgoing
// MQTT payload) without a browser/companion, and prints the exact payload layout.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from '../src/frames.js';
import { parsePacket, deriveHeardKey, bytesToHex, hexToBytes } from '../src/meshpacket.js';
import { buildRfLogRecord } from '../src/capture.js';

const SIM_RAW =
  '11451000D818206D3AAC152C8A91F89957E6D30CA51F36E28790228971C473B755F244F718754CF5EE4A2FD58D944466E42CDED140C66D0CC590183E32BAF40F112BE8F3F2BDF6012B4B2793C52F1D36F69EE054D9A05593286F78453E56C0EC4A3EB95DDA2A7543FCCC00B939CACC009278603902FC12BCF84B706120526F6F6620536F6C6172';

// Mirror of Publisher.buildPayload (kept inline so this test needs no mqtt dep).
function buildPayload(rxPubkey, rec) {
  return {
    origin_id: rxPubkey, timestamp: rec.rx_at, type: 'PACKET', direction: 'rx',
    raw: rec.raw, SNR: rec.snr, RSSI: rec.rssi,
    gps: { lat: rec.lat, lon: rec.lon, acc_m: rec.acc_m },
  };
}

test('0x88 frame → MQTT payload (correct layout)', () => {
  // Build the BLE frame exactly as the simulate button does: [0x88][snr×4][rssi][raw].
  const raw = hexToBytes(SIM_RAW);
  const frame = new Uint8Array(3 + raw.length);
  frame[0] = PUSH_CODE_LOG_RX_DATA;
  frame[1] = (-7 * 4) & 0xff;
  frame[2] = -92 & 0xff;
  frame.set(raw, 3);

  const f = parseFrame(new DataView(frame.buffer));
  assert.strictEqual(f.code, PUSH_CODE_LOG_RX_DATA);
  assert.strictEqual(f.snr, -7);
  assert.strictEqual(f.rssi, -92);

  const pkt = parsePacket(f.raw);
  const hk = deriveHeardKey('rx', pkt);
  assert.deepStrictEqual(hk, { heardKey: '152c', heardKeyLen: 2, src: 'rxlog' });

  const rec = { rx_at: '2026-06-09T12:00:00.000Z', raw: bytesToHex(f.raw), snr: f.snr, rssi: f.rssi, lat: 51.05, lon: 3.72, acc_m: 10 };
  const payload = buildPayload('companionpubkeyhex', rec);

  console.log('\n--- outgoing MQTT payload (topic: meshcore/client/companionpubkeyhex/packets) ---');
  console.log(JSON.stringify(payload, null, 2));
  console.log('--- server will re-derive heard_key=' + hk.heardKey + ' from raw ---\n');

  assert.strictEqual(payload.type, 'PACKET');
  assert.strictEqual(payload.direction, 'rx');
  assert.strictEqual(payload.SNR, -7);
  assert.strictEqual(payload.RSSI, -92);
  assert.deepStrictEqual(payload.gps, { lat: 51.05, lon: 3.72, acc_m: 10 });
  assert.ok(payload.raw.startsWith('11451000'));
});

test('DIRECT-route frame is rf-logged, not attributed', () => {
  // header 0x16 = route_type 2 (DIRECT), payload_type 5. path byte 0x41 =
  // hash_size 2, hop_count 1. DIRECT consumes hops from the FRONT, so path[last]
  // is the route's far end and deriveHeardKey must refuse it.
  const rawHex = '16' + '41' + '1a2b' + '33'.repeat(16);
  const raw = hexToBytes(rawHex);
  const frame = new Uint8Array(3 + raw.length);
  frame[0] = PUSH_CODE_LOG_RX_DATA;
  frame[1] = (-7 * 4) & 0xff;
  frame[2] = -92 & 0xff;
  frame.set(raw, 3);

  const f = parseFrame(new DataView(frame.buffer));
  const pkt = parsePacket(f.raw);
  const hk = deriveHeardKey('rx', pkt);
  assert.strictEqual(hk, null, 'DIRECT route must not be attributable');

  const rec = buildRfLogRecord({
    hk, fullRfLog: true, rawHex: bytesToHex(f.raw), snr: f.snr, rssi: f.rssi,
    fix: { lat: 51.05, lon: 3.72, acc_m: 10 }, captureAllowed: true,
    nowISO: '2026-08-17T12:00:00.000Z',
  });
  assert.ok(rec, 'should be rf-logged');
  assert.strictEqual(rec.raw, rawHex);
});
