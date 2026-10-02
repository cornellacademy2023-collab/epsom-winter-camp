// /api/admin — password-protected access to stored consultation requests.
//   GET                                      → list all entries (newest first)
//   POST {action:'update', id, status, memo}
//   POST {action:'delete', id}
//   POST {action:'setup', password}          → first-time password setup (only while none exists)
// Auth: header "x-admin-password" must match ADMIN_PASSWORD (env) or the stored password hash.
const {
  getEntry, saveEntry, listEntries, deleteEntry,
  getStoredAdmin, setStoredAdmin, checkStoredAdmin,
  clientIp, overLimit, sameSecret, readBody, clip, storageErrorCode,
} = require('./_lib');

const STATUSES = ['new', 'contacted', 'registered', 'closed'];
// SHA-256 of the one-time setup code given to the site owner. Setup needs this code, so a
// stranger who finds /admin first cannot claim the admin password. (The code itself is not in the repo.)
const SETUP_CODE_SHA256 = 'b88da45784252d64fb4185b70f25fc2ecaa2a1c0fbbd854370dc7079605934a1';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = clientIp(req);
  const b = req.method === 'POST' ? readBody(req) : {};

  try {
    const envPw = process.env.ADMIN_PASSWORD;
    const stored = envPw ? null : await getStoredAdmin(req);

    // First-time setup: allowed only while no password exists anywhere.
    if (b.action === 'setup') {
      if (envPw || stored) return res.status(409).json({ ok: false, error: 'already_set' });
      const code = String(b.setupCode || '').trim().toUpperCase();
      if (!sameSecret(require('crypto').createHash('sha256').update(code).digest('hex'), SETUP_CODE_SHA256)) {
        const blocked = await overLimit(`epsom:fail:${ip}`, 20, 3600);
        return res.status(blocked ? 429 : 403).json({ ok: false, error: blocked ? 'too_many' : 'bad_setup_code' });
      }
      const pw = String(b.password || '');
      if (pw.length < 8) return res.status(400).json({ ok: false, error: 'too_short' });
      await setStoredAdmin(req, pw);
      return res.status(200).json({ ok: true });
    }
    if (!envPw && !stored) return res.status(428).json({ ok: false, error: 'setup_required' });

    const given = req.headers['x-admin-password'] || '';
    const okPw = envPw ? sameSecret(given, envPw) : checkStoredAdmin(stored, given);
    if (!okPw) {
      const blocked = await overLimit(`epsom:fail:${ip}`, 20, 3600);
      return res.status(blocked ? 429 : 401).json({ ok: false, error: blocked ? 'too_many' : 'unauthorized' });
    }

    if (req.method === 'GET') {
      const items = await listEntries(req);
      items.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
      return res.status(200).json({ ok: true, items });
    }

    if (req.method === 'POST') {
      const id = clip(b.id, 40);
      const entry = id && /^[0-9a-f-]+$/i.test(id) ? await getEntry(req, id) : null;
      if (!entry) return res.status(404).json({ ok: false, error: 'not_found' });

      if (b.action === 'delete') {
        await deleteEntry(req, id);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'update') {
        if (b.status !== undefined) {
          if (!STATUSES.includes(b.status)) return res.status(400).json({ ok: false, error: 'bad_status' });
          entry.status = b.status;
        }
        if (b.memo !== undefined) entry.memo = clip(b.memo, 1000);
        entry.updatedAt = new Date().toISOString();
        await saveEntry(req, entry);
        return res.status(200).json({ ok: true, item: entry });
      }
      return res.status(400).json({ ok: false, error: 'bad_action' });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('admin api failed', err);
    const code = storageErrorCode(err);
    return res.status(code === 'storage_not_configured' ? 503 : 500).json({ ok: false, error: code, detail: String(err && err.message || '').slice(0, 160) });
  }
};
