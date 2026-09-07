// Unit tests for the runtime config loader's pure validation/normalization.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeConfig } from '../src/config.js';

test('normalizeConfig requires mqttUrl', () => {
  assert.throws(() => normalizeConfig({ mqttUsername: 'x' }), /mqttUrl/);
});

test('normalizeConfig trims fields and defaults resolveUrl to empty', () => {
  const c = normalizeConfig({ mqttUrl: '  wss://b:8084/ws  ', mqttUsername: ' u ' });
  assert.strictEqual(c.mqttUrl, 'wss://b:8084/ws');
  assert.strictEqual(c.mqttUsername, 'u');
  assert.strictEqual(c.resolveUrl, '');
});

test('normalizeConfig keeps resolveUrl when provided', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/api/nodes/resolve' });
  assert.strictEqual(c.resolveUrl, 'https://x/api/nodes/resolve');
});

test('normalizeConfig rejects a non-object', () => {
  assert.throws(() => normalizeConfig(null), /JSON object/);
});

test('normalizeConfig does not trim mqttPassword', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws', mqttPassword: '  s3cr3t  ' });
  assert.strictEqual(c.mqttPassword, '  s3cr3t  ');
});

test('normalizeConfig defaults mqttPassword to empty string when absent', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws' });
  assert.strictEqual(c.mqttPassword, '');
});

test('fullRfLog defaults to false and accepts true', () => {
  const base = { mqttUrl: 'wss://b.example/ws' };
  assert.equal(normalizeConfig(base).fullRfLog, false);
  assert.equal(normalizeConfig({ ...base, fullRfLog: true }).fullRfLog, true);
  // Anything non-boolean is coerced, never left undefined.
  assert.equal(normalizeConfig({ ...base, fullRfLog: 'yes' }).fullRfLog, true);
  assert.equal(normalizeConfig({ ...base, fullRfLog: 0 }).fullRfLog, false);
});

test('rfSampler defaults to false', () => {
  const base = { mqttUrl: 'wss://b.example/ws' };
  assert.equal(normalizeConfig(base).rfSampler, false);
  assert.equal(normalizeConfig({ ...base, rfSampler: true }).rfSampler, true);
});

test('regionDiscovery defaults to false — this is the only transmitting feature, opt-in only', () => {
  const base = { mqttUrl: 'wss://b.example/ws' };
  assert.equal(normalizeConfig(base).regionDiscovery, false);
  assert.equal(normalizeConfig({ ...base, regionDiscovery: true }).regionDiscovery, true);
});

// --- loadConfig: retry + dedupe + a readable error for an HTML body -----------
// Field failure this covers: the config fetch failed once at startup and the app
// ran the whole session without config (nothing published, three features off).
// loadConfig must therefore be safe to call repeatedly from several places.
import { loadConfig, setConfig } from '../src/config.js';

const VALID = { mqttUrl: 'wss://b.example/ws', regionDiscovery: true };

// stubFetch installs a fake global fetch and returns a call counter.
function stubFetch(handler) {
  const calls = { n: 0 };
  globalThis.fetch = async (url, opts) => { calls.n++; return handler(url, opts, calls.n); };
  return calls;
}

const jsonRes = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const htmlRes = () => ({ ok: true, status: 200, text: async () => '<!doctype html>\n<html><body>app shell</body></html>' });

test('loadConfig retries after a failed load instead of caching the failure', async () => {
  setConfig(null);
  const calls = stubFetch(async (_u, _o, n) => {
    if (n === 1) throw new TypeError('Failed to fetch');
    return jsonRes(VALID);
  });
  await assert.rejects(() => loadConfig('config.json'), /Failed to fetch/);
  const c = await loadConfig('config.json'); // the retry the app now performs
  assert.strictEqual(c.mqttUrl, 'wss://b.example/ws');
  assert.strictEqual(calls.n, 2, 'the second call must actually re-fetch');
  setConfig(null);
});

test('loadConfig dedupes concurrent callers into one fetch', async () => {
  setConfig(null);
  const calls = stubFetch(async () => jsonRes(VALID));
  const [a, b, c] = await Promise.all([loadConfig('config.json'), loadConfig('config.json'), loadConfig('config.json')]);
  assert.strictEqual(calls.n, 1, 'startup + connect + online must not each issue their own fetch');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  setConfig(null);
});

test('loadConfig caches a successful load', async () => {
  setConfig(null);
  const calls = stubFetch(async () => jsonRes(VALID));
  await loadConfig('config.json');
  await loadConfig('config.json');
  assert.strictEqual(calls.n, 1);
  setConfig(null);
});

test('loadConfig names an HTML body for what it is instead of leaking a JSON parse error', async () => {
  // The service worker used to answer a failed config fetch with index.html, and
  // a web server with an SPA fallback does the same. Both produced
  // "invalid JSON — Unexpected token '<'", which reads like a corrupt config file.
  setConfig(null);
  stubFetch(async () => htmlRes());
  await assert.rejects(() => loadConfig('config.json'), /HTML page instead of JSON/);
  setConfig(null);
});

test('loadConfig still reports a non-OK status clearly', async () => {
  setConfig(null);
  stubFetch(async () => ({ ok: false, status: 404, text: async () => '' }));
  await assert.rejects(() => loadConfig('config.json'), /HTTP 404/);
  setConfig(null);
});

test('a failed load leaves getConfig() null — callers must be able to detect "no config"', async () => {
  setConfig(null);
  stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(() => loadConfig('config.json'));
  const { getConfig } = await import('../src/config.js');
  assert.strictEqual(getConfig(), null);
  setConfig(null);
});
