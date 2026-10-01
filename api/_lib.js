// Shared helpers for the consultation API.
// Storage: Upstash Redis (Vercel Storage > Upstash for Redis), accessed over its REST API.
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HASH = 'epsom:consults';

function storageReady() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redis(...command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Redis HTTP ${res.status}`);
  return json.result;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Returns true when the caller is over `limit` hits within `windowSec`.
async function overLimit(key, limit, windowSec) {
  const n = await redis('INCR', key);
  if (n === 1) await redis('EXPIRE', key, windowSec);
  return n > limit;
}

function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function clip(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

module.exports = { HASH, storageReady, redis, clientIp, overLimit, sameSecret, readBody, clip, crypto };
