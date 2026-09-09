// An advert's Ed25519 signature is the only cryptographic proof of identity MeshCore
// offers: pubkey, name and self-reported position are all attacker-chosen otherwise, and
// nothing in the header is authenticated. Verifying it is what keeps a forged identity
// out of CoreScope, which is the registry name resolvers read from.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { parsePacket, hexToBytes } from '../src/meshpacket.js';
import { verifyAdvert, heardKeyAfterVerify } from '../src/advertsig.js';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '../src/meshpacket.js';

// Real captured advert (5x2-byte hops), the same fixture meshpacket.test.mjs uses.
// Its signature is genuine, so it is the only test here that proves the signed-message
// construction matches what the firmware actually signed.
const RELAYED_ADVERT =
  '11451000D818206D3AAC152C8A91F89957E6D30CA51F36E28790228971C473B755F244F718754CF5EE4A2FD58D944466E42CDED140C66D0CC590183E32BAF40F112BE8F3F2BDF6012B4B2793C52F1D36F69EE054D9A05593286F78453E56C0EC4A3EB95DDA2A7543FCCC00B939CACC009278603902FC12BCF84B706120526F6F6620536F6C6172';

test('a real captured advert verifies against its own signature', async () => {
  const pkt = parsePacket(hexToBytes(RELAYED_ADVERT));
  assert.strictEqual(await verifyAdvert(pkt.advertSig), true);
});

test('a flipped appdata byte fails verification', async () => {
  const tampered = RELAYED_ADVERT.slice(0, -2) + (RELAYED_ADVERT.slice(-2) === '72' ? '73' : '72');
  const pkt = parsePacket(hexToBytes(tampered));
  assert.strictEqual(await verifyAdvert(pkt.advertSig), false);
});

test('a pubkey swapped for another fails verification', async () => {
  const pkt = parsePacket(hexToBytes(RELAYED_ADVERT));
  pkt.advertSig.pubkey = hexToBytes('ab'.repeat(32));
  assert.strictEqual(await verifyAdvert(pkt.advertSig), false);
});

test('a packet with no signed message is not verifiable', async () => {
  assert.strictEqual(await verifyAdvert(null), false);
});

// A 0-hop advert (heardKey src 'advert') is the only reception that hands CoreScope a
// full 32-byte identity, and the only one an attacker can invent outright. The gate
// drops the identity and keeps the reception: the SNR/RSSI at that GPS position was
// genuinely measured, only the name attached to it was not.
const ZERO_HOP = (pubkeyHex, sigHex, appdataHex) =>
  parsePacket(hexToBytes('11' + '00' + pubkeyHex + '78563412' + sigHex + appdataHex));

test('a forged 0-hop advert loses its identity when verification is on', async () => {
  const pkt = ZERO_HOP('ab'.repeat(32), '11'.repeat(64), '02');
  const hk = { heardKey: 'ab'.repeat(32), heardKeyLen: 32, src: 'advert' };
  assert.strictEqual(await heardKeyAfterVerify(hk, pkt, true), null);
});

test('the same forged advert keeps its identity when verification is off', async () => {
  const pkt = ZERO_HOP('ab'.repeat(32), '11'.repeat(64), '02');
  const hk = { heardKey: 'ab'.repeat(32), heardKeyLen: 32, src: 'advert' };
  assert.strictEqual(await heardKeyAfterVerify(hk, pkt, false), hk);
});

test('a path-hash reception is never gated on a signature it cannot have', async () => {
  const pkt = parsePacket(hexToBytes(RELAYED_ADVERT));
  const hk = { heardKey: '152c', heardKeyLen: 2, src: 'rxlog' };
  assert.strictEqual(await heardKeyAfterVerify(hk, pkt, true), hk);
});

test('an unattributed frame stays unattributed', async () => {
  assert.strictEqual(await heardKeyAfterVerify(null, null, true), null);
});

test('a genuine 0-hop advert keeps its identity when verification is on', async () => {
  // Signed here rather than captured, because no 0-hop advert is in the fixtures: the
  // reject cases above cannot tell a working gate from one that rejects everything.
  const secret = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(secret);
  const tsAndAppdata = hexToBytes('78563412' + '02');
  const message = new Uint8Array(32 + tsAndAppdata.length);
  message.set(pubkey, 0);
  message.set(tsAndAppdata, 32);
  const sig = await ed.signAsync(message, secret);
  const pkt = ZERO_HOP(bytesToHex(pubkey), bytesToHex(sig), '02');
  const hk = { heardKey: bytesToHex(pubkey), heardKeyLen: 32, src: 'advert' };
  assert.strictEqual(await heardKeyAfterVerify(hk, pkt, true), hk);
});
