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
