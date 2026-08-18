// On-the-fly node-name resolution: per heard prefix/pubkey, one tiny request to
// the CoreScope resolve endpoint configured as `resolveUrl` in config.json (a
// CORS-enabled URL). Cached in memory for the session, so each distinct node is
// fetched at most once. When resolveUrl is empty the app skips resolution and
// the caller shows the prefix. A name is returned only when the prefix resolves
// uniquely; ambiguous/not-found → '' (caller shows the prefix).
import { getConfig } from './config.js';

const cache = new Map(); // key (lowercase hex) -> name | ''
const pubkeyCache = new Map(); // key (lowercase hex prefix) -> full 32-byte pubkey (hex) | ''

// resolveName resolves a heard key (2-3 byte prefix or full pubkey) to a name.
// Returns '' when unconfigured, ambiguous, or unknown. Network errors are not
// cached (retry later).
export async function resolveName(key) {
  const c = getConfig();
  const base = c && c.resolveUrl ? c.resolveUrl : '';
  if (!base) return '';
  const k = key.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  try {
    const r = await fetch(base + '?prefix=' + encodeURIComponent(k));
    if (!r.ok) { cache.set(k, ''); return ''; }
    const j = await r.json();
    const name = !j.ambiguous && j.name ? j.name : '';
    cache.set(k, name);
    return name;
  } catch (e) {
    return ''; // transient — leave uncached so it can retry
  }
}

// resolvePubkey resolves a heard key (prefix or full pubkey) to the full 32-byte
// pubkey, via the same resolve endpoint as resolveName. Returns '' when
// unconfigured, ambiguous, or unknown. A key that is already a full 64-hex pubkey
// is returned as-is with no request. Network errors are not cached (retry later).
export async function resolvePubkey(key) {
  const k = key.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(k)) return k;
  const c = getConfig();
  const base = c && c.resolveUrl ? c.resolveUrl : '';
  if (!base) return '';
  if (pubkeyCache.has(k)) return pubkeyCache.get(k);
  try {
    const r = await fetch(base + '?prefix=' + encodeURIComponent(k));
    if (!r.ok) { pubkeyCache.set(k, ''); return ''; }
    const j = await r.json();
    const pubkey = !j.ambiguous && j.pubkey ? j.pubkey : '';
    pubkeyCache.set(k, pubkey);
    return pubkey;
  } catch (e) {
    return ''; // transient — leave uncached so it can retry
  }
}
