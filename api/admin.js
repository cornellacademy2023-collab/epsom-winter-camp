// /api/admin — password-protected access to stored consultation requests.
//   GET                               → list all entries (newest first)
//   POST {action:'update', id, status, memo}
//   POST {action:'delete', id}
// Auth: header "x-admin-password" must match the ADMIN_PASSWORD environment variable.
const { HASH, storageReady, redis, clientIp, overLimit, sameSecret, readBody, clip } = require('./_lib');

const STATUSES = ['new', 'contacted', 'registered', 'closed'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: 'password_not_configured' });
  if (!storageReady()) return res.status(503).json({ ok: false, error: 'storage_not_configured' });

  try {
    const ip = clientIp(req);
    if (!sameSecret(req.headers['x-admin-password'] || '', process.env.ADMIN_PASSWORD)) {
      const blocked = await overLimit(`epsom:fail:${ip}`, 20, 3600);
      return res.status(blocked ? 429 : 401).json({ ok: false, error: blocked ? 'too_many' : 'unauthorized' });
    }

    if (req.method === 'GET') {
      const flat = (await redis('HGETALL', HASH)) || [];
      const items = [];
      for (let i = 1; i < flat.length; i += 2) {
        try { items.push(JSON.parse(flat[i])); } catch { /* skip malformed */ }
      }
      items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return res.status(200).json({ ok: true, items });
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      const id = clip(b.id, 40);
      const raw = id && (await redis('HGET', HASH, id));
      if (!raw) return res.status(404).json({ ok: false, error: 'not_found' });

      if (b.action === 'delete') {
        await redis('HDEL', HASH, id);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'update') {
        const entry = JSON.parse(raw);
        if (b.status !== undefined) {
          if (!STATUSES.includes(b.status)) return res.status(400).json({ ok: false, error: 'bad_status' });
          entry.status = b.status;
        }
        if (b.memo !== undefined) entry.memo = clip(b.memo, 1000);
        entry.updatedAt = new Date().toISOString();
        await redis('HSET', HASH, id, JSON.stringify(entry));
        return res.status(200).json({ ok: true, item: entry });
      }
      return res.status(400).json({ ok: false, error: 'bad_action' });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('admin api failed', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};
