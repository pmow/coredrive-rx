// Region discovery request/response framing (ANON_REQ_TYPE_REGIONS).
// Layouts verified against meshcore-firmware; see the spec for citations.
//
// NOTE: the app sends NO timestamp. sendAnonReq (BaseChatMesh.cpp) prepends a
// 4-byte tag itself from getCurrentTimeUnique(), which the repeater echoes back.

export const CMD_SEND_ANON_REQ = 57;
export const PUSH_CODE_BINARY_RESPONSE = 0x8c;
export const ANON_REQ_TYPE_REGIONS = 0x01;

// The repeater's CSV budget is sizeof(reply_data) - 12 = 172 bytes. exportNamesTo
// SKIPS names that do not fit and keeps going, so an overflowing list has holes
// rather than being a truncated prefix — there is no marker to detect. Flag when
// the CSV is close enough to the ceiling that a name could have been dropped.
const TRUNCATION_WARN_BYTES = 160;

export function buildRegionsRequest(pubkeyHex) {
  const pk = pubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pk)) {
    throw new TypeError(`buildRegionsRequest: pubkeyHex must be exactly 64 hex characters, got: ${pubkeyHex}`);
  }
  const out = new Uint8Array(1 + 32 + 2);
  out[0] = CMD_SEND_ANON_REQ;
  for (let i = 0; i < 32; i++) out[1 + i] = parseInt(pk.substr(i * 2, 2), 16);
  out[33] = ANON_REQ_TYPE_REGIONS;
  out[34] = 0x00; // reply_path_len — zero-hop reply
  return out;
}

export function parseRegionsResponse(bytes) {
  if (!bytes || bytes.length < 10 || bytes[0] !== PUSH_CODE_BINARY_RESPONSE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const csv = new TextDecoder().decode(bytes.slice(10));
  return {
    tag: v.getUint32(2, true),
    repeaterClock: v.getUint32(6, true),
    regions: csv.length ? csv.split(',') : [],
    truncated: csv.length >= TRUNCATION_WARN_BYTES,
  };
}
