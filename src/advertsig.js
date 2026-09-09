// Ed25519 verification of an advert's signature — the only cryptographic proof of
// identity MeshCore offers. Everything else in a packet is plaintext and attacker-
// chosen: pubkey, name and self-reported position are whatever the sender wrote, and
// hop counts, paths and prefixes carry no MAC. A 0-hop advert is genuinely heard
// directly and can still name a node that does not exist.
//
// That matters past this app. Adverts captured here are published to CoreScope, the
// registry the name resolvers read from, so an advert forged once and heard by one
// driver becomes a named node on someone else's screen.
//
// The signed message is assembled in meshpacket.js (parsePacket → advertSig); this
// module does nothing but the crypto.
import { verifyAsync } from '@noble/ed25519';

// verifyAdvert resolves true only for a signature that checks out. A forged advert can
// carry a pubkey or signature that is not a valid curve point at all, which noble
// rejects by throwing — that is a failed verification like any other, not a crash, and
// it must not take the capture path down with it.
export async function verifyAdvert(advertSig) {
  if (!advertSig) return false;
  try {
    return await verifyAsync(advertSig.signature, advertSig.message, advertSig.pubkey);
  } catch (e) {
    return false;
  }
}

// heardKeyAfterVerify is the capture gate: it returns the heard key unchanged, or null
// when a 0-hop advert failed its signature check. Only `src: 'advert'` is gated, because
// that is the one source carrying a full 32-byte identity lifted straight out of the
// packet. A path hash (`rxlog`) or a discover reply names a node that has to exist to
// have transmitted, and neither carries a signature to check.
//
// Dropping the key and keeping the reception is deliberate. The SNR and RSSI at that GPS
// position were genuinely measured, whoever wrote the advert; only the identity attached
// to them is worthless. As a side effect the node also stops being a region-discovery
// candidate (app.js gates that on `src === 'advert'`), so the app never transmits an
// anonymous request at an address somebody invented.
export async function heardKeyAfterVerify(hk, pkt, enabled) {
  if (!enabled || !hk || hk.src !== 'advert') return hk;
  return (await verifyAdvert(pkt && pkt.advertSig)) ? hk : null;
}
