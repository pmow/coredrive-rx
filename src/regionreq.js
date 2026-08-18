// Region discovery request/response framing (ANON_REQ_TYPE_REGIONS).
// Layouts verified against meshcore-firmware; see the spec for citations.
//
// NOTE: the app sends NO timestamp. sendAnonReq (BaseChatMesh.cpp) prepends a
// 4-byte tag itself from getCurrentTimeUnique(), which the repeater echoes back.

export const CMD_SEND_ANON_REQ = 57;
export const PUSH_CODE_BINARY_RESPONSE = 0x8c;
export const ANON_REQ_TYPE_REGIONS = 0x01;
export const RESP_CODE_SENT = 6; // companion_radio/MyMesh.cpp:77 — shared by every CMD_SEND_* path

// The repeater's CSV budget is sizeof(reply_data) - 12 = 172 bytes (MAX_PACKET_PAYLOAD
// 184, minus the 12-byte handleAnonRegionsReq/MyMesh.cpp header room). exportNamesTo
// (RegionMap.cpp) SKIPS a name that does not fit and keeps going, so an overflowing
// list has holes rather than being a truncated prefix — there is no marker to detect.
//
// Derivation of the threshold (RegionMap.cpp exportNamesTo): a name of length L is
// dropped once the bytes already written, W, satisfy `W + L + 2 >= max_len`. The
// longest possible name is L = sizeof(RegionEntry::name) - 1 = 31 - 1 = 30, so the
// drop can occur as early as W = max_len - L - 2 = 172 - 30 - 2 = 140. At that point
// the buffer holds exactly those 140 bytes, ending in the trailing comma written by
// the last successfully appended name — and exportNamesTo trims that trailing comma
// before returning. So the delivered CSV can be as short as 140 - 1 = 139 bytes while
// still hiding a dropped 30-char name right after it. Flag at or above that floor.
export const TRUNCATION_WARN_BYTES = 139;

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

// selectNextTarget picks the next repeater to ask, or null when there is nothing
// worth asking. Fresh candidates come first; a repeater that has never answered is
// DEMOTED rather than dropped, because silence is ambiguous — out of direct range,
// rate-limited, firmware too old, or busy — so dropping loses a node that was merely
// out of range for one stretch, while retrying at equal priority lets a permanent
// non-answerer starve one that would answer.
export function selectNextTarget(state) {
  const due = (c) => state.answered.get(c.pubkey) !== c.advertTs;
  const fresh = state.candidates.filter((c) => due(c) && !state.demoted.has(c.pubkey));
  const pool = fresh.length ? fresh : state.candidates.filter(due);
  if (!pool.length) return null;
  return pool[state.cursor % pool.length].pubkey;
}

export function parseRegionsResponse(bytes) {
  if (!bytes || bytes.length < 10 || bytes[0] !== PUSH_CODE_BINARY_RESPONSE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const csv = new TextDecoder().decode(bytes.slice(10));
  return {
    tag: v.getUint32(2, true),
    repeaterClock: v.getUint32(6, true),
    regions: csv.length ? csv.split(',') : [],
    // Measured on the wire bytes, not csv.length: the firmware budget is bytes, and
    // is_name_char accepts every byte >= 0x80, so an accented name costs more bytes
    // than it does UTF-16 code units. Comparing the decoded length would under-flag
    // exactly the lists most likely to have overflowed.
    truncated: bytes.length - 10 >= TRUNCATION_WARN_BYTES,
  };
}

// parseSentAck reads the tag from the immediate ack for CMD_SEND_ANON_REQ:
// [0x06][is_flood: 1][tag: 4][est_timeout: 4] (companion_radio/MyMesh.cpp:1568-1572).
// RESP_CODE_SENT is shared by every CMD_SEND_* path in the firmware (text message,
// login, anon req, ...) — the caller must only feed this the ack that followed its
// own send, not just any RESP_CODE_SENT frame that happens to arrive.
export function parseSentAck(bytes) {
  if (!bytes || bytes.length < 6 || bytes[0] !== RESP_CODE_SENT) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { tag: v.getUint32(2, true) };
}

// applyRegionsReply decides whether a parsed PUSH_CODE_BINARY_RESPONSE answers the
// currently pending request. `pending` is { target, advertTs, tag } (tag captured
// from parseSentAck) or null. The repeater rate-limits and replies after a delay,
// and a DIFFERENT repeater is asked every round, so a reply delayed past one round
// can arrive while another target is pending — matching on "something is pending"
// rather than on the echoed tag would attribute one repeater's declared regions to
// a different repeater and store it as fact. On any mismatch (including a tag not
// yet captured) this returns accepted:false and the caller MUST NOT clear pending —
// the real reply may still be on its way.
export function applyRegionsReply(pending, parsed) {
  if (!pending || !parsed || pending.tag == null || parsed.tag !== pending.tag) {
    return { accepted: false };
  }
  return {
    accepted: true,
    target: pending.target,
    advertTs: pending.advertTs,
    regions: parsed.regions,
    truncated: parsed.truncated,
    repeaterClock: parsed.repeaterClock,
  };
}
