// Shared helpers for the consultation API.
//
// Storage backends (first one available wins):
//   1. Upstash Redis — when KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_URL/TOKEN) are set.
//   2. Vercel Blob (private store "epsom-consults") — BLOB_READ_WRITE_TOKEN when the store is
//      connected to the project, otherwise the project's Vercel OIDC identity + BLOB_STORE_ID.
//
// Admin password: ADMIN_PASSWORD env var if set; otherwise a scrypt hash stored in the backend,
// created once from the admin page ("first-time setup").
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BLOB_STORE_ID = process.env.BLOB_STORE_ID || 'store_zDDXeB0BoDTW2wl6';
const HASH = 'epsom:consults';
const ADMIN_KEY = 'epsom:admin';

function backend() {
  if (REDIS_URL && REDIS_TOKEN) return 'redis';
  return 'blob';
}

/* ---------------- Redis (REST) ---------------- */
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

/* ---------------- Vercel Blob ---------------- */
let blobSdk;
function blob() {
  if (!blobSdk) blobSdk = require('@vercel/blob');
  return blobSdk;
}
// Credentials for a request: the store's read-write token if the store is connected,
// otherwise the per-request OIDC token Vercel injects for the deployment.
function blobAuth(req) {
  if (process.env.BLOB_READ_WRITE_TOKEN) return { token: process.env.BLOB_READ_WRITE_TOKEN };
  const oidcToken = (req && req.headers && req.headers['x-vercel-oidc-token']) || process.env.VERCEL_OIDC_TOKEN;
  if (!oidcToken) throw Object.assign(new Error('no blob credentials'), { code: 'storage_not_configured' });
  return { oidcToken, storeId: BLOB_STORE_ID };
}
async function blobPutJson(req, pathname, obj) {
  await blob().put(pathname, JSON.stringify(obj), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', ...blobAuth(req),
  });
}
async function blobGetJson(req, pathname) {
  const r = await blob().get(pathname, { access: 'private', useCache: false, ...blobAuth(req) });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return JSON.parse(await new Response(r.stream).text());
}

/* ---------------- Entries ---------------- */
const entryPath = (id) => `consults/${id}.json`;

async function saveEntry(req, entry) {
  if (backend() === 'redis') return redis('HSET', HASH, entry.id, JSON.stringify(entry));
  return blobPutJson(req, entryPath(entry.id), entry);
}

async function getEntry(req, id) {
  if (backend() === 'redis') {
    const raw = await redis('HGET', HASH, id);
    return raw ? JSON.parse(raw) : null;
  }
  try { return await blobGetJson(req, entryPath(id)); } catch (e) { if (isNotFound(e)) return null; throw e; }
}

async function listEntries(req) {
  if (backend() === 'redis') {
    const flat = (await redis('HGETALL', HASH)) || [];
    const out = [];
    for (let i = 1; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i])); } catch { /* skip */ } }
    return out;
  }
  const blobs = [];
  let cursor;
  do {
    const page = await blob().list({ prefix: 'consults/', cursor, limit: 1000, ...blobAuth(req) });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const out = [];
  for (let i = 0; i < blobs.length; i += 10) {
    const chunk = await Promise.all(blobs.slice(i, i + 10).map((b) => blobGetJson(req, b.pathname).catch(() => null)));
    out.push(...chunk.filter(Boolean));
  }
  return out;
}

async function deleteEntry(req, id) {
  if (backend() === 'redis') return redis('HDEL', HASH, id);
  return blob().del(entryPath(id), blobAuth(req));
}

function isNotFound(e) {
  return e && (e.name === 'BlobNotFoundError' || /not.?found/i.test(String(e.message)));
}

/* ---------------- Admin password ---------------- */
async function getStoredAdmin(req) {
  if (backend() === 'redis') {
    const raw = await redis('GET', ADMIN_KEY);
    return raw ? JSON.parse(raw) : null;
  }
  try { return await blobGetJson(req, 'config/admin.json'); } catch (e) { if (isNotFound(e)) return null; throw e; }
}
async function setStoredAdmin(req, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const rec = { salt, hash, setAt: new Date().toISOString() };
  if (backend() === 'redis') return redis('SET', ADMIN_KEY, JSON.stringify(rec));
  return blobPutJson(req, 'config/admin.json', rec);
}
function checkStoredAdmin(rec, password) {
  const given = crypto.scryptSync(String(password), rec.salt, 64);
  const expected = Buffer.from(rec.hash, 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(given, expected);
}

/* ---------------- Misc ---------------- */
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Best-effort limiter: Redis counter when available, otherwise per-instance memory.
const memHits = new Map();
async function overLimit(key, limit, windowSec) {
  if (backend() === 'redis') {
    const n = await redis('INCR', key);
    if (n === 1) await redis('EXPIRE', key, windowSec);
    return n > limit;
  }
  const now = Date.now();
  const rec = memHits.get(key);
  if (!rec || rec.until < now) { memHits.set(key, { n: 1, until: now + windowSec * 1000 }); return false; }
  rec.n += 1;
  return rec.n > limit;
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

// Maps storage failures to a short code the pages can show.
function storageErrorCode(err) {
  if (err && err.code === 'storage_not_configured') return 'storage_not_configured';
  const m = String((err && (err.name + ' ' + err.message)) || '');
  if (/credential|token|unauthori|forbidden|access|BlobStoreNotFound|store.*not.*found/i.test(m)) return 'storage_not_configured';
  return 'storage_error';
}

module.exports = {
  backend, saveEntry, getEntry, listEntries, deleteEntry,
  getStoredAdmin, setStoredAdmin, checkStoredAdmin,
  clientIp, overLimit, sameSecret, readBody, clip, storageErrorCode, crypto,
};
