# Investigation — capture dies after standstill auto-pause

**Date:** 2026-07-09
**Reporter:** BE-BOC-myst (operator), drive 2026-07-08 ~13:00–15:00 CEST, Bree (Limburg)
**Symptom:** most of a drive produced no coverage points on the CoreScope map.

## Incident evidence (from live DB, CoreScope analyzer)

Observer pubkey `1fa99e72a2417a477484017d88719e744302710121d2c8349b4196174e101e76`.

- July-8 receptions: **42 rows, all within 13:02–13:30 CEST** (`rx_at` 11:02–11:30 UTC), then nothing.
- Tail shows a standstill: anchored at **~51.1462, 5.5970 (HUBO Bree car park)** from 13:18–13:23,
  then a 5-point burst at 13:30:10–13:30:20 ~120 m away, then dead.
- All 42 rows share `ingested_at = 2026-07-09T13:21Z` → offline buffer, uploaded ~26 h later as one batch.
- Other mobile observers (OT1D, Domi, DinX, Danny) streamed **live** in the same window, ingested within
  ~5 s, 25–200 km away → the analyzer/broker/ingestor pipeline was fully healthy.

## Root cause

Not network. Capture is decoupled from MQTT: `processFrame` writes each reception straight to IndexedDB
(`src/queue.js`), the publisher drains that buffer separately. Everything captured *did* upload (late); the
13:30–15:00 rows are absent from the buffer, i.e. **never captured**.

The failure is a **resume deadlock** under mobile background/screen-off:

- Resume is driven *only* by GPS fixes: `gps.watchPosition → onFix → updateMotion → setPaused`
  (`src/app.js:421-424`). `updateMotion` (`src/motion.js:37`) unpauses only when a fix lands >75 m from the anchor.
- Capture is gated on `!state.paused` (`src/app.js:309`); paused → dropped.
- On a phone PWA, when the screen turns off / the page is hidden: `watchPosition` stops firing, BLE stalls,
  1 s `monitorTick` is throttled, and the native wake lock is auto-released (re-acquired only on
  `visibilitychange` back to foreground — `src/wakelock.js:60-61`).
- So after the 5-min standstill pause, the app needs a GPS fix to wake, but gets none until the user manually
  foregrounds it. The 13:30 10-second burst was a momentary wake; then it went dark for the rest of the drive.

## Candidate fixes (to evaluate — not yet implemented)

1. **Wake-on-packet fallback.** On a heard BLE packet while `paused`, re-evaluate motion against the latest fix
   instead of dropping unconditionally (`src/app.js:309`), so movement can resume capture even if the GPS
   callback cadence dropped.
2. **Don't hard-gate on `paused` for the buffer** — consider capturing at a reduced rate while "paused" rather
   than zero, so a mislabelled pause can't silently lose a whole drive.
3. **Keep the wake lock / surface a loud resume prompt.** The pause chip is invisible with the screen off;
   consider an audible/vibration cue or a notification when paused-while-moving is suspected.
4. **BLE reconnect robustness across background** (`src/transport.js:53`) — verify backoff timers survive
   suspend/resume, and force a reconnect + motion re-eval on `visibilitychange → visible`.
5. **Re-anchor/re-eval motion on `visibilitychange → visible`** so foregrounding immediately clears a stale pause.

## Open question

Confirm on the device: during 13:30–15:00 was the app backgrounded / screen off? Does the in-app rxlog show any
entries after 13:30:20? If the buffer is empty for that window, this diagnosis is confirmed.
