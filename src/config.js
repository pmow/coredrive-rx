// Runtime deployment config, fetched from config.json (served next to
// index.html) at startup. Nothing is baked into the bundle — sysops edit
// config.json, not source. See config.example.json for the shape.
// FEATURE_DEFAULTS: what a feature flag means when nothing states it — an absent
// key in config.json, or no config at all.
//
// The two LOGGING features default ON. Two field failures made the case: a config
// cached before they existed silently reported both off, and a config that failed to
// load turned off data COLLECTION as well as uploading. Both are invisible, and both
// destroy a window of coverage data that cannot be recovered — whereas data that is
// collected and then discarded server-side costs only bandwidth. Silence therefore
// means "collect it"; an explicit `false` still switches it off.
//
// regionDiscovery stays OFF by default because it is the only feature that
// TRANSMITS. It addresses third-party repeaters, which rate-limit anonymous
// requests to 4 per 180s shared across every requester and type, so one client
// asking once a minute already claims most of that budget. Turning that on by
// assumption spends someone else's airtime; it must be an opt-in.
export const FEATURE_DEFAULTS = { fullRfLog: true, rfSampler: true, regionDiscovery: false };

// featureEnabled resolves one flag, INCLUDING the case every gate in app.js used to
// get wrong: `config === null`. Those gates read `!cfg || !cfg.X`, which treats "we
// do not know yet" as "off" — the reading that cost a session's worth of RF data on
// top of its uploads.
export function featureEnabled(config, name) {
  if (!config || config[name] === undefined) return FEATURE_DEFAULTS[name] === true;
  return !!config[name];
}

let cfg = null;
let inFlight = null; // in-flight loadConfig promise, so concurrent retries share one fetch

// normalizeConfig validates + normalizes a parsed config.json object. Throws on
// a missing required field (mqttUrl). resolveUrl is optional (empty = node-name
// resolution disabled).
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json: expected a JSON object');
  const c = {
    mqttUrl: String(raw.mqttUrl || '').trim(),
    mqttUsername: String(raw.mqttUsername || '').trim(),
    mqttPassword: raw.mqttPassword == null ? '' : String(raw.mqttPassword),
    resolveUrl: String(raw.resolveUrl || '').trim(),
    // Absent → FEATURE_DEFAULTS; present → coerced. See FEATURE_DEFAULTS above for
    // why the two logging flags and the transmitting one differ.
    fullRfLog: featureEnabled(raw, 'fullRfLog'),
    rfSampler: featureEnabled(raw, 'rfSampler'),
    regionDiscovery: featureEnabled(raw, 'regionDiscovery'),
  };
  if (!c.mqttUrl) throw new Error('config.json: "mqttUrl" is required');
  return c;
}

// loadConfig fetches + normalizes config.json and caches it on SUCCESS ONLY, so a
// failed load can be retried. It is safe to call repeatedly and concurrently: the
// app retries it at startup, on every connect attempt, on the `online` event and
// from the monitor tick, because a single transient failure at startup used to
// leave the whole session without config — nothing published, and fullRfLog,
// rfSampler and regionDiscovery all silently off. Throws on a missing/unreadable
// file, an HTML body, or invalid JSON.
export function loadConfig(url = 'config.json') {
  if (cfg) return Promise.resolve(cfg);
  // Dedupe concurrent callers into one request. `finally` clears the slot whether
  // the attempt succeeded or failed, so a rejected attempt never poisons the next
  // retry (which is the entire point of retrying).
  if (!inFlight) inFlight = fetchConfig(url).finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchConfig(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('config.json not found (HTTP ' + r.status + ')');
  const text = await r.text();
  // A 200 carrying HTML means something served the app shell instead of the config:
  // a web server with an SPA fallback (`try_files $uri /index.html`), or a service
  // worker answering a failed request with index.html. Read as JSON that produced
  // "Unexpected token '<'", which reads like a corrupt config file and sent a field
  // diagnosis down the wrong path entirely. Name it.
  if (text.trimStart().startsWith('<')) {
    throw new Error('config.json: got an HTML page instead of JSON — the web server or service worker served the app shell instead of the config (usually means the device is offline)');
  }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error('config.json: invalid JSON — ' + e.message); }
  cfg = normalizeConfig(raw);
  return cfg;
}

export function getConfig() { return cfg; }
export function setConfig(c) { cfg = c; inFlight = null; } // test seam
