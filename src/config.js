// Runtime deployment config, fetched from config.json (served next to
// index.html) at startup. Nothing is baked into the bundle — sysops edit
// config.json, not source. See config.example.json for the shape.
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
    fullRfLog: !!raw.fullRfLog,
    rfSampler: !!raw.rfSampler,
    regionDiscovery: !!raw.regionDiscovery,
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
