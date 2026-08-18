// Decides whether a reception the capture path could NOT attribute should still
// be logged as a diagnostic RF observation. Kept out of app.js so it is testable
// without a DOM: app.js does the wiring, this decides.

// buildRfLogRecord returns the queue record for an unattributable reception, or
// null when it must not be queued. Callers pass `hk` exactly as deriveHeardKey
// returned it — a non-null hk means the packet IS attributable and belongs on
// the coverage path, never here.
//
// The returned shape is identical to the coverage record on purpose: it is the
// MQTT payload contract with CoreScope's ingestor, and the server re-derives
// everything from `raw`.
export function buildRfLogRecord({ hk, fullRfLog, rawHex, snr, rssi, fix, captureAllowed, nowISO }) {
  if (hk) return null;            // attributable → coverage path owns it
  if (!fullRfLog) return null;    // feature off
  if (!fix) return null;          // no position → not a map point
  if (!captureAllowed) return null; // stationary → the idle gate applies here too
  return { rx_at: nowISO, raw: rawHex, snr, rssi, lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m };
}
