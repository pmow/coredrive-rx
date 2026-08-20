// coredrive-rx — wiring + Home monitor UI + Settings + on-screen debug.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
// The companion's own pubkey (from SELF_INFO) is the identity / clientId / topic;
// the user never types it.
//
// Home is a pure monitor (counters, status strip, last-reception SNR meter, recently
// heard). Discover runs automatically with a traffic backoff (see monitor.js). Config
// and diagnostics live on the Settings tab.
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex, isFloodRoute, ADV_TYPE_REPEATER } from './meshpacket.js';
import { requestSelfInfo, requestDeviceInfo, setPathHashMode } from './selfinfo.js';
import { resolveName, resolvePubkey } from './names.js';
import { upsertHeard, sameNode, addNodeKey } from './recent.js';
import { updateMotion, captureDecision } from './motion.js';
import { createWakeLock } from './wakelock.js';
import { createBeeper } from './beeper.js';
import { createLocalMap } from './localmap.js';
import { hexCellAt } from './hexgrid.js';
import {
  discoverDecision, isOrganicHeard, snrToPct, decayPeak, pruneTimestamps,
  regionDiscoverDue,
} from './monitor.js';
import { shareLog } from './sharelog.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher } from './publisher.js';
import { loadConfig, getConfig } from './config.js';
import { buildRfLogRecord } from './capture.js';
import { buildStatsRequest, parseStats, mergeSample, nextSampleDelay, STATS_CORE, STATS_RADIO, STATS_PACKETS } from './rfstats.js';
import { buildRegionsRequest, parseRegionsResponse, selectNextTarget, parseSentAck, applyRegionsReply, heardAskEligible } from './regionreq.js';
import { regionsRows } from './regionsview.js';
import {
  buildGetContactByKey, parseContactReply, needsPathOverride, buildOverrideFrame,
  buildRestoreFrame, encodePendingRestore, decodePendingRestore, RESP_CODE_OK, RESP_CODE_ERR,
  RESTORE_STORAGE_KEY,
} from './contactpath.js';

// Region discovery needs FIRMWARE_VER_CODE >= 13 (companion_radio/MyMesh.cpp,
// CMD_SEND_ANON_REQ's non-contact allowance) to address a repeater it hasn't
// already got as a saved contact — which is the normal case out on a drive.
const REGION_DISCOVERY_MIN_FW = 13;

const els = (id) => document.getElementById(id);
const state = {
  transport: null, gps: new Gps(), queue: new Queue(), publisher: null,
  companionPubkey: '', companionName: '', connected: false, recent: [],
  localMap: null, verbose: false, motion: null, paused: false, wakeLock: null,
  soundEnabled: false, beeper: null,
  // monitor counters / state
  rxTotal: 0, rfLogged: 0, nodeKeys: [], hexCells: new Set(), rxTimes: [],
  lastUploadAt: null, brokerState: 'offline',
  lastHeard: null, snrBarPct: 0, snrPeakPct: 0,
  // auto-discover
  lastHeardAt: null, lastFireAt: 0, tick: null,
  // RF environment sampler
  rfTimer: null, lastRfSample: null, rfGen: 0,
  // Region discovery (ANON_REQ_TYPE_REGIONS) — round-robin scheduler state, ridden
  // on the discover clock at half rate. candidates/answered/demoted/cursor feed
  // selectNextTarget (src/regionreq.js) directly; round counts discover sweeps so
  // every SECOND one queries a repeater; pending holds the one outstanding request
  // this app ever has in flight; supported reflects the FIRMWARE_VER_CODE gate.
  regions: {
    candidates: new Map(), answered: new Map(), demoted: new Set(), cursor: 0,
    // attempts/lastAskedAt drive the per-target retry backoff (see selectNextTarget):
    // a repeater that never answers must not be re-asked every single round.
    attempts: new Map(), lastAskedAt: new Map(),
    lastAskAt: null, lastEvalAt: null, pending: null, supported: false,
    // overridePending: { target, raw, timer } while a saved contact's out_path is
    // temporarily forced to zero-hop for the ask currently in flight (see
    // prepareAndAskRegions / finishOverrideRound below). null the rest of the time.
    overridePending: null,
    // answers: accepted replies, oldest first, for the Home "declared scopes" panel
    // (src/regionsview.js does the last-5/most-recent-first transform). Each entry
    // is { target, regions, truncated, at, name }; name is filled in lazily once
    // resolveName returns (see noteRegionsAnswer).
    answers: [],
  },
};

const RECENT_MAX = 20;
const REGIONS_ANSWERS_MAX = 200; // display only shows the last 5 (regionsview.js); this just bounds session memory
const HEX_COUNT_RES = 10; // fixed res (~90 m cells) for the distinct-hex session counter
// Build version, injected from package.json by Vite (see vite.config.js).
const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

// SNR → colour bucket (LoRa-ish). Returns a CSS colour.
function snrColor(snr) {
  if (snr == null) return '#95a5a6';
  if (snr >= 5) return '#2ecc71';
  if (snr >= -3) return '#f1c40f';
  if (snr >= -10) return '#e67e22';
  return '#e74c3c';
}

// noteHeard merges a heard node into the recent list (most-recent first). The same
// node can arrive under different key representations (path hash vs pubkey); the merge
// collapses them into one row. See src/recent.js.
function noteHeard(key, keylen, snr, rssi, src) {
  state.recent = upsertHeard(state.recent, { key, keylen, snr, rssi, src, now: Date.now() }, RECENT_MAX);
  const e = state.recent[0]; // merged entry is at the front
  // Resolve the name once per node, keyed on the canonical (longest) key. Re-find the
  // entry in the callback by sameNode (not exact key) so a key promotion mid-flight
  // (short hash → full pubkey) still writes the name to the merged row.
  if (e.name === undefined && !e._req) {
    e._req = true;
    const canon = e.key;
    resolveName(canon)
      .then((nm) => { const cur = state.recent.find((x) => sameNode(x.key, canon)); if (cur) { cur.name = nm || ''; renderRecent(); } })
      .catch(() => { const cur = state.recent.find((x) => sameNode(x.key, canon)); if (cur) cur._req = false; });
  }
  renderRecent();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRecent() {
  const el = els('recent');
  if (!state.recent.length) { el.innerHTML = '<div class="muted">— nothing yet —</div>'; return; }
  el.innerHTML = state.recent.map((e) => {
    const snr = e.snr != null ? e.snr.toFixed(1) + ' dB' : 'no sig';
    const label = e.name ? esc(e.name) : '<span class="rk">' + e.key + '</span>';
    return '<div class="rr">' +
      '<span class="dot" style="background:' + snrColor(e.snr) + '"></span>' +
      '<span class="rname">' + label + '</span>' +
      '<span class="rsnr" style="color:' + snrColor(e.snr) + '">' + snr + '</span>' +
      '<span class="rc">×' + e.count + '</span></div>';
  }).join('');
}

// MQTT config comes from the runtime config.json (loaded at startup via
// loadConfig), never the UI. The publish account is a shared, publish-only
// ingest account (EMQX ACL); not a real secret.

function log(msg) { els('status').textContent = msg; }

// dbg(msg, level): newest-first log line. level 'ok'=green (captured/published),
// 'tx'=orange (our own discover sends), 'no'=red (held back/failed), default=grey (status).
function dbg(msg, level) {
  const el = els('log');
  const line = document.createElement('div');
  line.className = level === 'ok' ? 'lg-ok' : level === 'no' ? 'lg-no' : level === 'tx' ? 'lg-tx' : 'lg-st';
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  el.insertBefore(line, el.firstChild);
  while (el.childNodes.length > 200) el.removeChild(el.lastChild);
}

// switchView cycles between Home (monitor), the full-screen Map, and Settings via the
// bottom bar. Leaflet must be invalidated when its container becomes visible, otherwise
// the tiles render at the wrong size.
function switchView(v) {
  els('view-home').style.display = v === 'home' ? 'block' : 'none';
  els('view-map').style.display = v === 'map' ? 'block' : 'none';
  els('view-settings').style.display = v === 'settings' ? 'block' : 'none';
  els('tabHome').classList.toggle('active', v === 'home');
  els('tabMap').classList.toggle('active', v === 'map');
  els('tabSettings').classList.toggle('active', v === 'settings');
  if (v === 'map' && state.localMap) state.localMap.invalidate();
}

// --- Discover (inbound: who can I hear?) ---
// Sends a ZERO-HOP CONTROL/DISCOVER_REQ (CMD_SEND_CONTROL_DATA=0x37). Every node in DIRECT
// RF range (repeater, companion, room server, sensor) replies with a DISCOVER_RESP carrying
// its pubkey, which arrives as a 0x88 frame and is attributed by deriveHeardKey (src=discover).
// Zero-hop, so it is NOT re-broadcast across the mesh — only local airtime. Wire format verified
// against meshcore_py commands/control_data.py + firmware payloads.md.
const CMD_SEND_CONTROL_DATA = 0x37;
const CTRL_NODE_DISCOVER_REQ = 0x80; // sub_type 0x8 in the upper nibble
const DISCOVER_PREFIX_ONLY = 0x01;   // lowest flag bit: responders send an 8-byte pubkey prefix
const DISCOVER_FILTER_ALL = 0xff;    // type_filter: bit per ADV_TYPE_*; all bits = every node type

function sendNodeDiscover() {
  if (!state.transport || !state.connected) return false;
  const tag = crypto.getRandomValues(new Uint8Array(4)); // reflected back in each DISCOVER_RESP
  const frame = new Uint8Array([CMD_SEND_CONTROL_DATA, CTRL_NODE_DISCOVER_REQ | DISCOVER_PREFIX_ONLY, DISCOVER_FILTER_ALL, ...tag]);
  state.transport.send(frame).catch((e) => dbg('discover send failed: ' + e.message, 'no'));
  return true;
}

// fireDiscover sends one zero-hop sweep and records the time so the next one is paced.
function fireDiscover(now) {
  if (sendNodeDiscover()) dbg('discover → zero-hop node-discover req (all types)', 'tx');
  state.lastFireAt = now;
}

// --- Region discovery (outbound: what does a repeater CLAIM to forward?) ---
// The ONLY part of this app that transmits addressed to one specific node. Asking
// only works zero-hop DIRECT, and this receiver is moving — a repeater picked a
// minute later by a clock may already be out of range — so the ask is primarily
// event-driven: maybeAskHeardTarget fires it the moment a suitable repeater is
// actually heard (see the heard-packet handler below). maybeQueryRegions is the
// timer fallback for a candidate heard once and never heard again. Both share the
// SAME one-ask-per-60s budget (state.regions.lastAskAt) and the same per-target
// backoff, so which path fires never changes the airtime spent — only the timing.
const REGION_SENT_ACK_TIMEOUT_MS = 4000;

function maybeQueryRegions() {
  if (!state.transport) return;
  const r = state.regions;
  const cfg = getConfig();
  if (!cfg || !cfg.regionDiscovery || !r.supported) return;
  // lastEvalAt throttles THIS path's re-entry (and its log line) to once a
  // minute; lastAskAt is the airtime budget and is stamped only by commitAndAsk,
  // when something is actually transmitted. Stamping the budget here spent it on
  // evaluations that sent nothing, which then blocked the heard-packet path —
  // observed in the field as a repeater heard at :27 and not asked until :09 of
  // the next minute, by which time a moving receiver is long past it.
  r.lastEvalAt = Date.now();
  const candidates = Array.from(r.candidates, ([pubkey, advertTs]) => ({ pubkey, advertTs }));
  const target = selectNextTarget({
    candidates, answered: r.answered, demoted: r.demoted, cursor: r.cursor,
    attempts: r.attempts, lastAskedAt: r.lastAskedAt, now: Date.now(),
  });
  if (!target) {
    // Silence here has two very different causes and they must not read alike.
    const why = r.candidates.size === 0
      ? 'no repeater heard yet'
      : 'every repeater heard so far has already answered';
    dbg('regions: nothing to ask — ' + why, 'st');
    return; // do not transmit
  }
  commitAndAsk(target, r.candidates.get(target));
}

// maybeAskHeardTarget is the event-driven counterpart to maybeQueryRegions: called
// right after a repeater is recorded as a region-discovery candidate from a heard
// packet, it asks THAT repeater immediately if the shared budget/backoff allow it,
// instead of waiting for whichever candidate the next timer tick happens to pick.
// This is normally what fires the ask in practice — the timer above stays wired as
// the fallback for a candidate heard once and never heard again (see monitorTick).
// heardAskEligible (src/regionreq.js) is the pure decision; this is just wiring.
function maybeAskHeardTarget(target, advertTs) {
  if (!state.transport) return;
  const r = state.regions;
  const cfg = getConfig();
  if (!cfg || !cfg.regionDiscovery || !r.supported) return;
  const now = Date.now();
  if (!heardAskEligible(target, advertTs, r, now)) return;
  // Consume the shared budget here, same as the timer path — both paths stamp the
  // SAME clock (r.lastAskAt) so the one-ask-per-60s ceiling holds no matter which
  // path actually fires.
  r.lastAskAt = now;
  dbg('regions: heard ' + target.slice(0, 12) + '… directly — asking now', 'st');
  commitAndAsk(target, advertTs);
}

// commitAndAsk mutates the scheduler state for one ask and sends it. Shared by both
// the timer path and the heard-packet path so a request committed either way looks
// identical to everything downstream (the ack listener, the reply matcher, restore).
function commitAndAsk(target, advertTs) {
  const r = state.regions;
  // Build the frame BEFORE committing any scheduler state: buildRegionsRequest
  // throws on a malformed pubkey, and a throw here must not leave cursor/demoted/
  // pending mutated for a request that was never sent — that would escape its
  // caller (monitorTick or the heard-packet handler) and skip the rest of that
  // handler's work.
  const frame = buildRegionsRequest(target);
  r.cursor++;
  r.attempts.set(target, (r.attempts.get(target) ?? 0) + 1);
  r.lastAskedAt.set(target, Date.now());
  r.demoted.add(target); // demoted until it answers — silence must never look like "declared nothing"
  // tag starts null: the reply-matcher (applyRegionsReply) treats a null tag as
  // "not yet confirmed" and refuses to accept ANY reply until the RESP_CODE_SENT
  // ack (captured below) fills it in — a reply must never be attributed on the
  // sole evidence that a request happens to be pending.
  r.pending = { target, advertTs, tag: null };
  prepareAndAskRegions(target, frame);
}

// --- Contact-path override (src/contactpath.js has the frame layout + decision) ---
// A target this app wants to ask may already be a saved contact whose stored
// out_path is not the zero-hop link node-discover just confirmed — sendAnonReq
// then floods or source-routes over a stale path, and a flooded/misrouted ask gets
// no reply (repeaters require a direct route from the CURRENT neighbour). Force the
// contact to zero-hop before asking, then always restore it, whether the ask
// succeeded, failed outright (still flooded), or simply timed out with no reply.
const GET_CONTACT_TIMEOUT_MS = 4000;
const CONTACT_WRITE_TIMEOUT_MS = 4000;
// Upper bound on how long a contact is held zero-hop for one ask. The repeater's own
// est_timeout (returned in the send-ack but otherwise unused here) is normally
// shorter, but nothing tells us a reply is NEVER coming — this is the backstop that
// guarantees restoreContact still runs even if the round never resolves any other way.
const OVERRIDE_ROUND_TIMEOUT_MS = 20000;

// getContact reads one contact by pubkey. Resolves parseContactReply's result, or
// null on a timeout/send failure — callers treat null the same as "not a contact":
// skip the override and ask as-is, since that is exactly today's (broken-for-
// contacts) behaviour and never worse than not asking at all. The ERR_CODE_NOT_FOUND
// reply carries no pubkey to match against (see src/contactpath.js), so a found
// reply is matched by its own echoed pub_key field; nothing else in this app issues
// CMD_GET_CONTACT_BY_KEY concurrently (transport.js serialises writes and this is
// the only per-target BLE flow), so an unmatched not-found reply arriving in this
// window can only be the answer to THIS request.
function getContact(pubkeyHex) {
  if (!state.transport) return Promise.resolve(null); // disconnected between scheduling and running this round
  return new Promise((resolve) => {
    const onFrame = (dv) => {
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      const parsed = parseContactReply(bytes);
      if (!parsed) return;
      if (parsed.found && bytesToHex(parsed.raw.slice(1, 33)) !== pubkeyHex) return; // some other contact's reply
      cleanup();
      resolve(parsed);
    };
    const timer = setTimeout(() => {
      cleanup();
      dbg('regions: contact lookup timed out for ' + pubkeyHex.slice(0, 12) + '… — asking without the path check', 'no');
      resolve(null);
    }, GET_CONTACT_TIMEOUT_MS);
    function cleanup() { clearTimeout(timer); if (state.transport) state.transport.offFrame(onFrame); }
    state.transport.onFrame(onFrame);
    state.transport.send(buildGetContactByKey(pubkeyHex)).catch((e) => { cleanup(); dbg('regions: contact lookup failed: ' + e.message, 'no'); resolve(null); });
  });
}

// writeContact sends a CMD_ADD_UPDATE_CONTACT frame (override or restore) and waits
// for its RESP_CODE_OK/RESP_CODE_ERR reply. Like getContact, this reply carries no
// correlator — same "only one in-flight BLE command of this kind" argument applies.
function writeContact(frame, timeoutMs) {
  if (!state.transport) return Promise.resolve(false); // disconnected mid-round — see getContact
  return new Promise((resolve) => {
    const onFrame = (dv) => {
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      if (bytes[0] !== RESP_CODE_OK && bytes[0] !== RESP_CODE_ERR) return;
      cleanup();
      resolve(bytes[0] === RESP_CODE_OK);
    };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    function cleanup() { clearTimeout(timer); if (state.transport) state.transport.offFrame(onFrame); }
    state.transport.onFrame(onFrame);
    state.transport.send(frame).catch(() => { cleanup(); resolve(false); });
  });
}

// finishOverrideRound restores a temporarily-overridden contact exactly once per
// round — called from every place a round can conclude (accepted reply, an ack that
// still reports FLOOD despite the override, or the OVERRIDE_ROUND_TIMEOUT_MS
// backstop) so a race between two of those can never double-restore.
function finishOverrideRound(target) {
  const ov = state.regions.overridePending;
  if (!ov || ov.target !== target) return;
  clearTimeout(ov.timer);
  state.regions.overridePending = null;
  restoreContact(target, ov.raw);
}

// restoreContact writes the ORIGINAL contact frame back. The localStorage
// crash-safety record is cleared only once the restore actually acks — if it
// doesn't, the record is left in place so the next connect to this same companion
// replays it (see maybeReplayPendingRestore).
async function restoreContact(target, raw) {
  const ok = await writeContact(buildRestoreFrame(raw), CONTACT_WRITE_TIMEOUT_MS);
  if (ok) {
    clearPendingRestore(target);
    dbg('regions: restored ' + target.slice(0, 12) + '…’s original path', 'st');
  } else {
    dbg('regions: restore write for ' + target.slice(0, 12) + '… did not ack — will retry on next connect', 'no');
  }
}

function clearPendingRestore(target) {
  const rec = decodePendingRestore(localStorage.getItem(RESTORE_STORAGE_KEY) || '');
  if (rec && rec.self === state.companionPubkey && rec.target === target) localStorage.removeItem(RESTORE_STORAGE_KEY);
}

// prepareAndAskRegions runs the read/override dance (if this target needs one) and
// then sends the regions request exactly as askRegions always has.
async function prepareAndAskRegions(target, frame) {
  const contact = await getContact(target);
  if (!needsPathOverride(contact)) { askRegions(target, frame); return; }
  const raw = contact.raw;
  localStorage.setItem(RESTORE_STORAGE_KEY, encodePendingRestore(state.companionPubkey, target, raw));
  const ok = await writeContact(buildOverrideFrame(raw), CONTACT_WRITE_TIMEOUT_MS);
  if (!ok) dbg('regions: path override for ' + target.slice(0, 12) + '… did not ack — asking anyway', 'no');
  const timer = setTimeout(() => finishOverrideRound(target), OVERRIDE_ROUND_TIMEOUT_MS);
  state.regions.overridePending = { target, raw, timer };
  askRegions(target, frame);
}

// maybeReplayPendingRestore runs once per connect, before any region-discovery ask:
// if a previous session died between an override write and its restore, the target
// contact is still sitting zero-hop on the companion. Replayed only against the SAME
// companion the record was made for (keyed on self pubkey from SELF_INFO) — never a
// different one, which may have an unrelated contact under that pubkey.
async function maybeReplayPendingRestore() {
  const stored = localStorage.getItem(RESTORE_STORAGE_KEY);
  if (!stored) return;
  const rec = decodePendingRestore(stored);
  if (!rec) { localStorage.removeItem(RESTORE_STORAGE_KEY); return; } // corrupt — nothing safe to replay
  if (rec.self !== state.companionPubkey) return; // belongs to a different companion — leave it for its own connect
  dbg('regions: replaying a pending contact-path restore for ' + rec.target.slice(0, 12) + '… left over from a previous session', 'st');
  const ok = await writeContact(buildRestoreFrame(rec.raw), CONTACT_WRITE_TIMEOUT_MS);
  if (ok) { localStorage.removeItem(RESTORE_STORAGE_KEY); dbg('regions: pending restore replayed OK', 'ok'); }
  else dbg('regions: pending restore did not ack — will retry next connect', 'no');
}

// askRegions sends the request and listens for the immediate RESP_CODE_SENT ack to
// capture the tag the eventual PUSH_CODE_BINARY_RESPONSE must match — the repeater
// rate-limits and replies after a delay, and a DIFFERENT repeater is asked every
// round, so a reply delayed past one round can land while another target is
// pending. Matching on "something is pending" instead of on this tag would
// attribute one repeater's declared regions to a different repeater and store it
// as fact (see applyRegionsReply in src/regionreq.js for the actual decision).
function askRegions(target, frame) {
  const onAck = (dv) => {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const ack = parseSentAck(bytes);
    if (!ack) return;
    cleanup();
    if (!(state.regions.pending && state.regions.pending.target === target)) return;
    if (ack.isFlood) {
      // Flooded: the repeater requires a DIRECT route and drops this silently.
      // Clear the pending slot rather than waiting out a reply that cannot come,
      // and say so — otherwise this looks identical to a repeater in range that
      // simply has not answered yet.
      state.regions.pending = null;
      const overridden = state.regions.overridePending && state.regions.overridePending.target === target;
      if (overridden) {
        // We just forced this contact's out_path to zero-hop and it STILL came
        // back flood — the override assumption was wrong (or didn't take). Say so
        // plainly rather than letting it look like the ordinary not-a-contact case.
        dbg('regions: ' + target.slice(0, 12) + '… still asked over FLOOD after the zero-hop override — override had no effect', 'no');
        finishOverrideRound(target);
      } else {
        dbg('regions: ' + target.slice(0, 12) + '… asked over FLOOD — repeaters only answer DIRECT, no reply will come', 'no');
      }
      return;
    }
    state.regions.pending.tag = ack.tag;
  };
  const timer = setTimeout(() => {
    cleanup();
    dbg('regions: no send-ack for ' + target.slice(0, 12) + '… (tag never captured)', 'no');
  }, REGION_SENT_ACK_TIMEOUT_MS);
  // Disconnecting inside this window nulls state.transport (disconnectAll clears
  // state.regions.pending but has no reference to this timer/listener) — guard the
  // dereference so the timeout callback can't throw on a transport that's gone.
  function cleanup() { clearTimeout(timer); if (state.transport) state.transport.offFrame(onAck); }
  state.transport.onFrame(onAck);
  // Log only once the write has actually gone out. Announcing the ask before the
  // send settles printed "asked" beside "failed" for the same attempt, which read
  // as a request that was made and then broke rather than one never sent.
  state.transport.send(frame).then(
    () => dbg('regions → asked ' + target.slice(0, 12) + '… for its declared list', 'tx'),
    (e) => { cleanup(); dbg('regions request failed: ' + e.message, 'no'); },
  );
}

// onRegionsFrame is a dedicated BLE frame listener for ANON_REQ_TYPE_REGIONS replies.
// parseRegionsResponse checks bytes[0] itself — it must see the RAW notification,
// never parseFrame(...).data (parseFrame strips the leading code byte, which would
// silently misfire this check and discard every reply with no error anywhere).
function onRegionsFrame(dv) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const parsed = parseRegionsResponse(bytes);
  if (!parsed) return;
  const result = applyRegionsReply(state.regions.pending, parsed);
  if (!result.accepted) {
    // Do NOT clear pending either way: the real reply for the current target may
    // still be on its way. Two different facts, logged differently — conflating
    // them ("tag mismatch" for both) is exactly the kind of ambiguity that costs
    // time in the field: an ack not back yet is normal and expected shortly, while
    // an actual tag mismatch is a stray/late reply from an abandoned round.
    if (state.regions.pending && state.regions.pending.tag == null) {
      dbg('regions ← reply arrived before the send-ack tag was captured — ignored, not attributed', 'no');
    } else if (state.regions.pending) {
      dbg('regions ← reply tag mismatch (got ' + parsed.tag + ', want ' + state.regions.pending.tag + ') — stray/late reply, ignored', 'no');
    }
    return;
  }
  state.regions.pending = null;
  state.regions.demoted.delete(result.target); // it answered — no longer a non-answerer
  state.regions.answered.set(result.target, result.advertTs);
  finishOverrideRound(result.target); // no-op unless this round overrode the contact's path
  noteRegionsAnswer(result.target, result.regions, result.truncated);
  const fix = currentFix();
  state.queue.add({
    kind: 'regions', at: new Date().toISOString(), target: result.target,
    regions: result.regions, truncated: result.truncated, repeater_clock: result.repeaterClock,
    lat: fix ? fix.lat : null, lon: fix ? fix.lon : null, acc_m: fix ? fix.acc_m : null,
  }).catch((e) => dbg('regions queue failed: ' + e.message, 'no'));
  dbg('regions ← ' + result.target.slice(0, 12) + '… declares: ' + (result.regions.join(',') || '(none)'), 'ok');
}

function renderDiscoverStatus(dec) {
  const el = els('discStatus');
  if (!state.connected || dec.state === 'paused') { el.textContent = ''; return; }
  if (dec.state === 'backoff') { el.textContent = '🎯 Backoff (verkeer actief)'; return; }
  el.textContent = dec.secs > 0 ? '🎯 Discover actief — volgende in ' + dec.secs + 's' : '🎯 Discover actief';
}

function renderPauseChip() {
  const el = els('pausechip');
  if (state.paused) { el.textContent = '⏸ Paused — stationary (resumes when you move)'; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

// setPaused reacts to a moving↔stationary transition. Capture is gated in processFrame
// on state.paused; the discover loop is gated via discoverDecision (state 'paused').
function setPaused(paused) {
  if (paused === state.paused) return;
  state.paused = paused;
  renderPauseChip();
  dbg(paused ? 'stationary — capture/upload paused' : 'moving again — capture/upload resumed', paused ? 'no' : 'ok');
}

// --- Per-second monitor tick: drives auto-discover, the SNR-meter decay, and the
// time-relative labels (last-heard / last-upload / rate / discover countdown). Runs only
// while connected.
function monitorTick() {
  const now = Date.now();
  const dec = discoverDecision(now, state.lastHeardAt, state.lastFireAt, state.paused);
  if (dec.fire) { fireDiscover(now); renderDiscoverStatus(discoverDecision(now, state.lastHeardAt, state.lastFireAt, state.paused)); }
  else renderDiscoverStatus(dec);
  // Region discovery runs on its own clock and is NOT gated on dec.fire, so the
  // stationary pause cannot silence it — see regionDiscoverDue in monitor.js.
  if (regionDiscoverDue(now, state.regions.lastEvalAt)) maybeQueryRegions();
  state.snrPeakPct = decayPeak(state.snrPeakPct, state.snrBarPct, 1000);
  renderSnrMeter();
  state.rxTimes = pruneTimestamps(state.rxTimes, now);
  renderStatusStrip();
  renderLastHeard();
}

// --- Home renderers ---
function renderCounters() {
  els('cNodes').textContent = String(state.nodeKeys.length);
  els('cHex').textContent = String(state.hexCells.size);
  els('cRx').textContent = String(state.rxTotal);
  const cfg = getConfig();
  const fullRfLog = !!(cfg && cfg.fullRfLog);
  els('cRfLogRow').style.display = fullRfLog ? '' : 'none';
  if (fullRfLog) els('cRfLog').textContent = String(state.rfLogged);
}

function agoText(at, now) {
  if (at == null) return '—';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return s + 's geleden';
  return Math.floor(s / 60) + 'm geleden';
}

async function renderStatusStrip() {
  const now = Date.now();
  const fix = currentFix();
  els('sGps').textContent = fix ? '✓ ' + Math.round(fix.acc_m) + 'm' : '… no fix';
  els('sPending').textContent = (await state.queue.count()) + ' pending';
  els('sRate').textContent = state.rxTimes.length + ' pkt/min';
  const dot = els('uDot');
  const color = !state.publisher ? '#9aa4b2'
    : state.brokerState === 'connect' ? '#2ecc71'
    : state.brokerState === 'reconnect' ? '#e6a23c'
    : '#e74c3c'; // offline / close / error → red so a dead link is obvious, not idle-grey
  dot.style.background = color;
  els('sUpload').lastChild.textContent = state.lastUploadAt ? 'upload ' + agoText(state.lastUploadAt, now) : 'upload —';
}

function renderLastHeard() {
  if (!state.lastHeard) { els('lastHeardCard').style.display = 'none'; return; }
  els('lastHeardCard').style.display = 'block';
  // Derive the label live so it upgrades from ID → resolved name once names.js
  // returns (the per-second tick re-renders this).
  const { key, at } = state.lastHeard;
  els('lhLine').textContent = nodeLabel(key) + ' — ' + agoText(at, Date.now());
}

// renderRegionsCard shows the last 5 repeaters that answered a region-discovery
// request, most recent first. Hidden entirely until there is at least one answer.
// declaresNothing is a real answer (the repeater flood-allows nothing), rendered
// distinctly from a non-empty list — never left blank as if unknown.
function renderRegionsCard() {
  const rows = regionsRows(state.regions.answers);
  if (!rows.length) { els('regionsCard').style.display = 'none'; return; }
  els('regionsCard').style.display = 'block';
  els('regionsList').innerHTML = rows.map((r) => {
    const label = r.name ? esc(r.name) : '<span class="rk">' + r.target.slice(0, 12) + '…</span>';
    const regionsCls = r.declaresNothing ? 'rgregions none' : 'rgregions';
    // '*' is not a region name — it declares that plain, unscoped floods are
    // forwarded. Shown as a separate marker so it cannot be read as a scope.
    const unscopedTag = r.unscoped ? '<span class="rgunscoped">+ unscoped</span>' : '';
    const regionsText = (r.declaresNothing ? 'declares no regions flood-allowed' : esc(r.regions.join(', '))) + unscopedTag;
    const warn = r.truncated ? '<div class="rgwarn">⚠ truncated — some regions may be missing</div>' : '';
    return '<div class="rgrow"><div class="rgname">' + label + '</div>' +
      '<div class="' + regionsCls + '">' + regionsText + '</div>' + warn + '</div>';
  }).join('');
}

// noteRegionsAnswer records an accepted region-discovery reply for the Home panel
// (renderRegionsCard). Name resolution reuses names.js's session cache — one lookup
// per newly-seen target, not a network call on every render.
function noteRegionsAnswer(target, regions, truncated) {
  const rec = { target, regions, truncated, at: Date.now(), name: undefined };
  state.regions.answers.push(rec);
  if (state.regions.answers.length > REGIONS_ANSWERS_MAX) state.regions.answers.shift();
  resolveName(target).then((nm) => { rec.name = nm || ''; renderRegionsCard(); });
  renderRegionsCard();
}

function renderSnrMeter() {
  els('snrFill').style.width = state.snrBarPct + '%';
  els('snrFill').style.background = snrColor(state.lastHeard ? state.lastHeard.snr : null);
  els('snrPeak').style.left = state.snrPeakPct + '%';
  els('snrVal').textContent = state.lastHeard && state.lastHeard.snr != null ? state.lastHeard.snr.toFixed(1) + ' dB' : '';
}

// noteSnr updates the SNR meter from the latest reception (any packet, even no-GPS).
function noteSnr(snr) {
  state.snrBarPct = snrToPct(snr);
  if (state.snrBarPct > state.snrPeakPct) state.snrPeakPct = state.snrBarPct;
  renderSnrMeter();
}

// --- Settings renderers ---
function renderBroker() {
  const m = { connect: 'connected', reconnect: 'reconnecting…', offline: 'offline', close: 'disconnected', error: 'error' };
  els('brokerStatus').textContent = state.publisher ? (m[state.brokerState] || state.brokerState) : '— not connected —';
}

// onBrokerStatus logs every MQTT lifecycle change to the debug log (previously invisible,
// so a field disconnect couldn't be diagnosed) and flushes the backlog on (re)connect.
function onBrokerStatus(s, arg) {
  state.brokerState = s;
  if (s === 'connect') dbg('CoreScope connected', 'ok');
  else if (s === 'reconnect') dbg('CoreScope reconnecting…', 'st');
  else if (s === 'offline') dbg('CoreScope offline (no network?)', 'no');
  else if (s === 'close') dbg('CoreScope connection closed', 'no');
  else if (s === 'error') dbg('CoreScope error: ' + ((arg && arg.message) || arg), 'no');
  renderBroker();
  renderStatusStrip();
  if (s === 'connect') drain().then(refreshCounters).catch(() => {}); // flush backlog on (re)connect
}

function setButton() {
  const b = els('btnConnect');
  b.textContent = state.connected ? 'Disconnect' : 'Connect companion (BLE)';
  b.classList.toggle('danger', state.connected);
}

// Stepped progress block under the button.
function progressReset() { els('progress').innerHTML = ''; }
function step(msg, cls) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (cls) d.className = cls;
  els('progress').appendChild(d);
  return d;
}

function currentFix() { return state.gps.latest(); }

async function processFrame(dv) {
  const f = parseFrame(dv);
  if (!f || f.code !== PUSH_CODE_LOG_RX_DATA) return;
  const rawHex = bytesToHex(f.raw);
  const sig = ' snr=' + f.snr + ' rssi=' + f.rssi;
  if (state.verbose) dbg('0x88 raw=' + rawHex + sig, 'st'); // raw bytes only when verbose-debugging
  const pkt = parsePacket(f.raw);
  const hk = deriveHeardKey('rx', pkt);
  if (!hk) {
    // Explain why a frame wasn't attributed. Direct multi-hop packets can't be credited (the
    // transmitter removed itself from the path's front), and 1-byte hops are collision-prone —
    // both are called out. Everything else (tx / no advert) is pure noise, verbose only.
    const lastHop = pkt && pkt.hops.length ? pkt.hops[pkt.hops.length - 1] : null;
    const cfg = getConfig();
    const logged = cfg && cfg.fullRfLog;
    const suffix = logged ? ', logged' : ', skipped';
    if (lastHop && pkt.hops.length && !isFloodRoute(pkt.routeType)) dbg('direct route — transmitter not in path' + suffix, 'st');
    else if (lastHop && lastHop.length === 2) dbg('1-byte path-hash (' + lastHop + ') — seen' + suffix, 'st');
    else if (state.verbose) dbg('not attributable (tx / no advert)' + suffix + sig, 'no');

    // fullRfLog: the packet is not coverage, so the counters, SNR meter,
    // recently-heard list, beeper and map hexes must not move. The motion/
    // idle-gate state below IS deliberately shared with the coverage path —
    // updateMotion is a pure function of the latest GPS fix and now, the same
    // fix already drives it on every GPS callback, and applying the idle gate
    // here is the point (a stationary phone shouldn't queue RF-log rows either).
    if (!logged) return;
    const rfFix = currentFix();
    let rfCapture = false;
    if (rfFix) {
      const rfDec = captureDecision(state.motion, rfFix, Date.now());
      state.motion = rfDec.motion;
      setPaused(state.motion.paused);
      rfCapture = rfDec.capture;
    }
    const rfRec = buildRfLogRecord({
      hk, fullRfLog: logged, rawHex, snr: f.snr, rssi: f.rssi,
      fix: rfFix, captureAllowed: rfCapture, nowISO: new Date().toISOString(),
    });
    if (!rfRec) return;
    state.rfLogged++;
    await state.queue.add(rfRec);
    renderCounters();
    return;
  }

  // Organic traffic (an overheard forwarder/advert, not our own discover reply) means we're
  // in an active area — back off discover so we don't poll on top of live traffic.
  if (isOrganicHeard(hk)) state.lastHeardAt = Date.now();

  // Region-discovery candidates: only a 0-hop advert (hk.src === 'advert') carries the
  // full pubkey ANON_REQ_TYPE_REGIONS needs to address, and only ADV_TYPE_REPEATER
  // firmware implements the reply (simple_repeater/MyMesh.cpp) — a chat/room/sensor
  // node would just be a request that can never be answered.
  //
  // advertTs is stored ONLY as the answered-key, which makes the policy "ask each
  // repeater once per session". It does NOT signal a config change: Mesh.cpp:418
  // sets it to getCurrentTime() on every advert, so it moves every advert interval
  // (47h in this network) whether or not anything changed. The firmware DOES track
  // a real config-change signal — _prefs.discovery_mod_timestamp, set on `regions
  // save` (CommonCLI.cpp:1037) and filterable via the discover request's optional
  // `since` field (simple_repeater/MyMesh.cpp:791-798) — but asking once per drive
  // is deliberate: it costs ~19 requests against the ~180 the discover sweep already
  // sends, and it keeps every stored list demonstrably current instead of assumed.
  const regionsCfg = getConfig();
  if (regionsCfg && regionsCfg.regionDiscovery && hk.src === 'advert' && pkt.advertType === ADV_TYPE_REPEATER && pkt.advertTs != null) {
    state.regions.candidates.set(hk.heardKey, pkt.advertTs);
    maybeAskHeardTarget(hk.heardKey, pkt.advertTs);
  }
  // Discover responses are the common case (47h advert intervals mean real adverts are
  // rare) but carry only an 8-byte pubkey prefix in practice — resolve to the full
  // 32-byte pubkey ANON_REQ_TYPE_REGIONS must address before keying the candidate map,
  // so the same repeater never appears twice under two different keys. advertTs is
  // stored null: selectNextTarget's due() rule (answered.get(pubkey) !== advertTs)
  // then asks it once per session and re-asks automatically if a real advert with a
  // timestamp later arrives. Async and non-blocking — a failed resolve just adds nothing.
  if (regionsCfg && regionsCfg.regionDiscovery && hk.src === 'discover' && pkt.discoverType === ADV_TYPE_REPEATER) {
    resolvePubkey(hk.heardKey).then((pk) => {
      if (!pk) return;
      state.regions.candidates.set(pk, null);
      maybeAskHeardTarget(pk, null);
    });
  }

  noteHeard(hk.heardKey, hk.heardKeyLen, f.snr, f.rssi, hk.src); // show in the list even without a GPS fix
  state.rxTotal++;
  state.rxTimes.push(Date.now());
  addNodeKey(state.nodeKeys, hk.heardKey);
  state.lastHeard = { key: hk.heardKey, snr: f.snr, at: Date.now() };
  noteSnr(f.snr); // sets bar/peak + colour from the now-current lastHeard
  renderCounters();
  renderLastHeard();

  const fix = currentFix();
  if (!fix) { dbg('heard ' + hk.heardKey + ' (' + hk.src + ')' + sig + ' — no GPS, not queued', 'no'); return; }
  // Wake-on-packet (issue #9): a heard packet advances the idle gate too, so movement
  // resumes capture even when the GPS callback cadence stalled while backgrounded /
  // screen-off. A packet from a moved position unpauses; one still at the parked
  // anchor stays paused.
  const dec = captureDecision(state.motion, fix, Date.now());
  state.motion = dec.motion;
  setPaused(state.motion.paused);
  if (!dec.capture) { dbg('heard ' + hk.heardKey + ' (' + hk.src + ')' + sig + ' — stationary, not queued', 'no'); return; }
  dbg('heard ' + hk.heardKey + ' (' + hk.heardKeyLen + 'B, ' + hk.src + ')' + sig, 'ok');
  state.hexCells.add(hexCellAt(fix.lat, fix.lon, HEX_COUNT_RES));
  renderCounters();
  const rec = { rx_at: new Date().toISOString(), raw: rawHex, snr: f.snr, rssi: f.rssi, lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m };
  await state.queue.add(rec);
  if (state.soundEnabled && state.beeper) state.beeper.beep(); // audio cue per mapped node (#7)
  if (state.localMap) state.localMap.addPoint(fix.lat, fix.lon, f.snr); // live hex on the map
  refreshCounters();
}

// nodeLabel returns the resolved name for a heard key if known, else the key itself.
function nodeLabel(key) {
  const e = state.recent.find((x) => sameNode(x.key, key));
  return e && e.name ? e.name : key;
}

async function refreshCounters() {
  renderCounters();
  renderStatusStrip();
}

// drain publishes all buffered receptions once. Returns the count published. Isolated
// from the loop so the "Push pending now" button can call it directly.
async function drain() {
  if (!(state.publisher && state.publisher.connected() && state.companionPubkey)) return 0;
  const rows = await state.queue.takeAll();
  const done = [];
  for (const r of rows) { await state.publisher.publish(state.companionPubkey, r, state.companionName); done.push(r.id); }
  if (done.length) {
    await state.queue.remove(done);
    state.lastUploadAt = Date.now();
    dbg('published ' + done.length + ' record(s)', 'ok');
  }
  return done.length;
}

// drainLoop runs forever every 5 s. A publish to a dead socket never acks, but
// publisher.publish now times out (rejecting), and rescheduling lives in `finally`, so a
// stalled send can never kill the loop (the +60-pending-on-WiFi bug).
async function drainLoop() {
  try {
    await drain();
    refreshCounters();
  } catch (e) {
    dbg('publish error (kept buffered): ' + e.message, 'no');
  } finally {
    setTimeout(drainLoop, 5000);
  }
}

// pushNow is the Settings button: force a drain, or force a reconnect first if the link
// is down — so a stuck disconnected client with a full queue has a manual way to recover.
async function pushNow() {
  const b = els('btnPush');
  b.disabled = true;
  try {
    if (state.publisher && !state.publisher.connected()) {
      dbg('CoreScope not connected — forcing reconnect…', 'st');
      state.publisher.reconnect(); // drain fires automatically on the 'connect' event
      return;
    }
    const n = await drain();
    dbg(n ? 'pushed ' + n + ' record(s)' : 'nothing pending / not connected', n ? 'ok' : 'st');
  } catch (e) {
    dbg('push failed (kept buffered): ' + e.message, 'no');
  } finally {
    b.disabled = false;
    refreshCounters();
  }
}

async function connectAll() {
  els('btnConnect').disabled = true;
  progressReset();
  els('companionInfo').textContent = '— not connected —';
  els('hashinfo').textContent = '';
  log('');
  const s1 = step('① Connecting to companion…', 'pending');
  try {
    state.transport = new WebBluetoothTransport();
    state.transport.onFrame(processFrame);
    state.transport.onFrame(onRegionsFrame); // no-op unless a region request is in flight
    state.transport.onStatus((s) => {
      dbg('BLE: ' + s);
      if (state.connected) log(s === 'connected' ? 'capturing' : 'BLE ' + s + '…');
    });
    await state.transport.connect();
    s1.textContent = '① Companion connected ✓';
    s1.className = '';

    const s2 = step('② Reading companion ID…', 'pending');
    const info = await requestSelfInfo(state.transport);
    state.companionPubkey = info.pubkey.toLowerCase();
    state.companionName = info.name || ''; // sent as "origin" so the server can name this observer
    s2.textContent = '② Companion: ' + (info.name || '(unnamed)') + ' ✓';
    s2.className = '';
    els('companionInfo').textContent = (info.name ? info.name + ' · ' : '') + state.companionPubkey.slice(0, 20) + '…';
    dbg('SELF_INFO → ' + (info.name || '(unnamed)') + ' ' + state.companionPubkey);
    await maybeReplayPendingRestore(); // fix up any contact left zero-hop by a crash/BLE-drop last session, before anything else touches it

    // Ensure the companion adverts with 2-byte path hashes — 1-byte mode produces
    // collision-prone IDs that our capture rule rejects, so the contribution is useless.
    // state.regions.supported resets to false BEFORE the query: if requestDeviceInfo
    // throws below, a stale `true` from an earlier connection (e.g. a prior device,
    // or a prior successful connect this session) must never carry over — an
    // unverified device would otherwise spend this feature's one airtime budget on
    // firmware that silently ignores the request, indistinguishable from being out
    // of range.
    state.regions.supported = false;
    try {
      const di = await requestDeviceInfo(state.transport);
      if (di.pathHashMode === 0 || di.pathHashMode == null) {
        await setPathHashMode(state.transport, 1);
        els('hashinfo').textContent = '⚙️ Set companion to 2-byte path-hash mode';
        dbg('path-hash mode was ' + di.pathHashMode + ' → set to 1 (2-byte)');
      } else {
        els('hashinfo').textContent = 'Path-hash mode: ' + (di.pathHashMode + 1) + '-byte ✓';
        dbg('path-hash mode already ' + di.pathHashMode + ' (' + (di.pathHashMode + 1) + '-byte)');
      }
      // Region discovery needs FIRMWARE_VER_CODE >= 13 to address a repeater that
      // isn't already a saved contact (CMD_SEND_ANON_REQ, companion_radio/MyMesh.cpp).
      // di.fwVer IS that byte (RESP_CODE_DEVICE_INFO offset 1). Off by default in
      // config; when on but the firmware is too old, leave it off and say why —
      // no silent failure. Both branches write the Settings line: reconnecting to a
      // v13+ device after a v12 one must not leave a stale "off — firmware v12" on
      // screen while the feature is actually live.
      state.regions.supported = di.fwVer >= REGION_DISCOVERY_MIN_FW;
      const regionsCfg = getConfig();
      if (regionsCfg && regionsCfg.regionDiscovery) {
        if (state.regions.supported) {
          els('regionsInfo').textContent = 'Region discovery: on';
        } else {
          els('regionsInfo').textContent = 'Region discovery: off — firmware v' + di.fwVer + ' (needs v' + REGION_DISCOVERY_MIN_FW + '+)';
          dbg('region discovery disabled: firmware v' + di.fwVer + ' < ' + REGION_DISCOVERY_MIN_FW, 'no');
        }
        els('regionsInfo').style.display = '';
      }
    } catch (e) {
      dbg('hash-mode check skipped: ' + e.message);
      // requestDeviceInfo threw or timed out — state.regions.supported is still the
      // false it was reset to above, but the "on" line written at DOMContentLoaded
      // from config alone is still on screen. Without this, the user sees an enabled
      // feature that will never transmit and is never told why.
      const regionsCfg = getConfig();
      if (regionsCfg && regionsCfg.regionDiscovery) {
        els('regionsInfo').textContent = 'Region discovery: off — could not read firmware version';
        els('regionsInfo').style.display = '';
      }
    }

    state.gps.start((fix) => {
      if (state.localMap) state.localMap.setPosition(fix.lat, fix.lon);
      state.motion = updateMotion(state.motion, fix, Date.now());
      setPaused(state.motion.paused);
    });

    const s3 = step('③ Connecting to CoreScope…', 'pending');
    const cfg = getConfig();
    if (cfg && cfg.mqttUrl) {
      state.publisher = new Publisher({ url: cfg.mqttUrl, username: cfg.mqttUsername, password: cfg.mqttPassword, clientId: state.companionPubkey });
      state.publisher.onStatus(onBrokerStatus);
      await state.publisher.connect();
      state.brokerState = 'connect';
      renderBroker();
      s3.textContent = '③ CoreScope connected ✓';
      s3.className = '';
    } else {
      s3.textContent = '③ MQTT not configured (config.json)';
      s3.className = 'err';
    }

    step('✅ All connected — capturing');
    state.connected = true;
    setButton();
    state.lastFireAt = 0; // fire a discover sweep immediately on the first tick
    state.tick = setInterval(monitorTick, 1000);
    startRfSampler();
    log('capturing as ' + (info.name || state.companionPubkey.slice(0, 12)));
    switchView('home'); // connected → jump to the live monitor

  } catch (e) {
    step('✗ ' + e.message, 'err');
    dbg('connect failed: ' + e.message, 'no');
    log('connect failed: ' + e.message);
    await disconnectAll(true);
  }
  els('btnConnect').disabled = false;
  refreshCounters();
}

// RF environment sampler. Three local BLE queries per tick — nothing goes on
// the air. Whole-sample-or-nothing: a tick that does not collect all three
// responses within RF_TIMEOUT_MS is discarded, because a partial sample would
// skew whichever delta chain it landed in on the server.
const RF_TIMEOUT_MS = 2000;

function renderRfSampler() {
  if (!state.lastRfSample) return;
  els('rfSamplerInfo').textContent = 'RF: ' + state.lastRfSample.noise_floor + ' dBm · RX air ' + state.lastRfSample.rx_air_secs + ' s';
}

function startRfSampler() {
  const cfg = getConfig();
  if (!cfg || !cfg.rfSampler) return;

  // Generation guard: a tick awaits state.queue.add(sample) mid-cycle. If
  // disconnectAll() → stopRfSampler() → startRfSampler() (reconnect) all happen
  // during that await, the stale tick would otherwise resume, overwrite the new
  // session's state.rfTimer with its own reschedule, and run a second concurrent
  // tick loop against this closure's now-orphaned `pending` map. Each session
  // bumps state.rfGen; a tick only reschedules itself if its captured
  // generation is still current.
  state.rfGen += 1;
  const myGen = state.rfGen;

  const pending = new Map(); // subType -> resolve
  state.transport.onFrame((dvFrame) => {
    const bytes = new Uint8Array(dvFrame.buffer, dvFrame.byteOffset, dvFrame.byteLength);
    const s = parseStats(bytes);
    if (!s) return;
    const resolve = pending.get(s.subType);
    if (resolve) { pending.delete(s.subType); resolve(s); }
  });

  const ask = (subType) => new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(subType); resolve(null); }, RF_TIMEOUT_MS);
    pending.set(subType, (v) => { clearTimeout(timer); resolve(v); });
    state.transport.send(buildStatsRequest(subType)).catch(() => {
      clearTimeout(timer);
      pending.delete(subType);
      resolve(null);
    });
  });

  const tick = async () => {
    if (!state.transport || !state.companionPubkey) return;
    const fix = currentFix();
    if (fix) {
      const core = await ask(STATS_CORE);
      const radio = await ask(STATS_RADIO);
      const packets = await ask(STATS_PACKETS);
      const sample = mergeSample(core, radio, packets, fix, new Date().toISOString(), state.motion ? state.motion.paused : false);
      if (sample) {
        await state.queue.add(sample);
        state.lastRfSample = sample; // Settings diagnostics line
        renderRfSampler();
        dbg('rf sample noise=' + sample.noise_floor + 'dBm rx_air=' + sample.rx_air_secs + 's', 'st');
      } else {
        dbg('rf sample incomplete — discarded', 'no');
      }
    }
    if (state.rfGen !== myGen) return; // superseded by a disconnect/reconnect during the await above
    state.rfTimer = setTimeout(tick, nextSampleDelay(state.motion ? state.motion.paused : false));
  };

  state.rfTimer = setTimeout(tick, nextSampleDelay(state.motion ? state.motion.paused : false));
}

function stopRfSampler() {
  state.rfGen += 1; // invalidate any tick currently mid-await so it will not reschedule itself
  if (state.rfTimer) { clearTimeout(state.rfTimer); state.rfTimer = null; }
}

async function disconnectAll(keepProgress) {
  state.connected = false;
  state.motion = null;
  state.paused = false;
  renderPauseChip();
  clearInterval(state.tick); state.tick = null;
  stopRfSampler();
  state.regions.pending = null; // no more frames will arrive on this transport to answer it
  // A contact left zero-hop here is exactly what the localStorage crash-safety record
  // covers — leave it in place (do NOT restore over a transport that's gone, and do NOT
  // clear the record) so maybeReplayPendingRestore fixes it on the next connect.
  if (state.regions.overridePending) { clearTimeout(state.regions.overridePending.timer); state.regions.overridePending = null; }
  els('discStatus').textContent = '';
  if (state.wakeLock) state.wakeLock.disable(); // let the screen sleep again
  if (state.publisher) { state.publisher.end(); state.publisher = null; }
  state.brokerState = 'offline';
  renderBroker();
  try { state.gps.stop(); } catch (e) {}
  if (state.transport) { try { await state.transport.disconnect(); } catch (e) {} state.transport = null; }
  els('companionInfo').textContent = '— not connected —';
  els('hashinfo').textContent = '';
  if (!keepProgress) { progressReset(); log('disconnected.'); }
  setButton();
}

window.addEventListener('DOMContentLoaded', async () => {
  els('appver').textContent = 'v' + VERSION;
  try {
    await loadConfig();
    els('fullRfLogInfo').style.display = getConfig().fullRfLog ? '' : 'none';
    els('rfSamplerInfo').style.display = getConfig().rfSampler ? '' : 'none';
    if (getConfig().regionDiscovery) {
      els('regionsInfo').textContent = 'Region discovery: on';
      els('regionsInfo').style.display = '';
    }
  } catch (e) {
    log('Config error: ' + e.message + ' — copy config.example.json to config.json and fill it in.');
  }
  setButton();
  state.wakeLock = createWakeLock();
  // Audio cue (#7): default off, but remember the choice across app starts.
  state.beeper = createBeeper();
  state.soundEnabled = localStorage.getItem('coredrive.sound') === '1';
  els('chkSound').checked = state.soundEnabled;
  // Web Bluetooth missing (e.g. iOS Safari) — point the user to a supported browser.
  if (!navigator.bluetooth) els('btnotice').style.display = 'block';
  els('btnConnect').addEventListener('click', () => {
    if (state.connected) { disconnectAll(); return; }
    state.wakeLock.enable(); // acquire in the user gesture (iOS needs it for video.play())
    if (state.soundEnabled) state.beeper.ensure(); // unlock audio in the same gesture
    connectAll();
  });
  els('btnClear').addEventListener('click', () => { els('log').textContent = ''; });
  els('chkVerbose').addEventListener('change', (e) => { state.verbose = e.target.checked; });
  els('chkSound').addEventListener('change', (e) => {
    state.soundEnabled = e.target.checked;
    localStorage.setItem('coredrive.sound', state.soundEnabled ? '1' : '0');
    if (state.soundEnabled) state.beeper.ensure(); // unlock + confirm audio in this gesture
  });
  els('btnPush').addEventListener('click', pushNow);
  els('btnShareLog').addEventListener('click', async () => {
    const text = Array.from(els('log').childNodes).map((n) => n.textContent).join('\n');
    try { await shareLog(text || '(empty log)'); } catch (e) { dbg('share failed: ' + e.message, 'no'); }
  });
  els('btnDbg').addEventListener('click', () => {
    const logEl = els('log');
    const show = logEl.style.display === 'none';
    logEl.style.display = show ? 'block' : 'none';
    els('btnDbg').textContent = show ? 'Hide debug log' : 'Show debug log';
  });
  renderRecent();
  renderCounters();
  renderStatusStrip();
  renderBroker();
  drainLoop();
  state.localMap = createLocalMap('liveMap');
  els('tabHome').addEventListener('click', () => switchView('home'));
  els('tabMap').addEventListener('click', () => switchView('map'));
  els('tabSettings').addEventListener('click', () => switchView('settings'));
  switchView(state.connected ? 'home' : 'settings'); // land on Settings (where Connect lives) until connected
  // Network came back (e.g. cellular→WiFi handoff) — kick a drain so backlog flushes
  // without waiting for the 5 s loop.
  window.addEventListener('online', () => { drain().then(refreshCounters).catch(() => {}); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
