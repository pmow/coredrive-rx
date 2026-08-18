// resolveName must short-circuit (no network) when resolveUrl is unconfigured.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { setConfig } from '../src/config.js';
import { resolveName, resolvePubkey } from '../src/names.js';

test('resolveName returns "" and does not fetch when resolveUrl is empty', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: '' });
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('should not fetch'); };
  try {
    const name = await resolveName('aabb');
    assert.strictEqual(name, '');
    assert.strictEqual(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns "" and does not fetch when resolveUrl is empty', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: '' });
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('should not fetch'); };
  try {
    const pk = await resolvePubkey('aabbccdd11223344');
    assert.strictEqual(pk, '');
    assert.strictEqual(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns an already-full 64-hex key unchanged, with no request', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('should not fetch'); };
  try {
    const full = 'ab'.repeat(32);
    const pk = await resolvePubkey(full.toUpperCase());
    assert.strictEqual(pk, full);
    assert.strictEqual(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns the full pubkey on an unambiguous match', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  const full = 'ef'.repeat(32);
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({ prefix: 'efef7943', pubkey: full, name: 'BE-BRE-ON8AR', ambiguous: false }),
  });
  try {
    const pk = await resolvePubkey('efef7943');
    assert.strictEqual(pk, full);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns "" when the prefix is ambiguous', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({ prefix: 'aa', pubkey: 'aa'.repeat(32), name: '', ambiguous: true }),
  });
  try {
    const pk = await resolvePubkey('aa');
    assert.strictEqual(pk, '');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns "" when the prefix is unknown (no pubkey field)', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ prefix: 'zz112233', ambiguous: false }) });
  try {
    const pk = await resolvePubkey('zz112233');
    assert.strictEqual(pk, '');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey does not cache a network error — a later call retries', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  const full = 'cd'.repeat(32);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('network down');
    return { ok: true, json: async () => ({ pubkey: full, ambiguous: false }) };
  };
  try {
    const first = await resolvePubkey('cdcd1122');
    assert.strictEqual(first, '');
    const second = await resolvePubkey('cdcd1122');
    assert.strictEqual(second, full);
    assert.strictEqual(calls, 2);
  } finally {
    globalThis.fetch = orig;
  }
});
