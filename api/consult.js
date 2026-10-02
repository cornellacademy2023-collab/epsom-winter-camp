// POST /api/consult — store one consultation request from the landing page form.
const { saveEntry, clientIp, overLimit, readBody, clip, storageErrorCode, crypto } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const b = readBody(req);
  const rec = {
    parent: clip(b.parent, 40),
    phone: clip(b.phone, 20),
    student: clip(b.student, 40),
    age: clip(b.age, 10),
    camp: clip(b.camp, 60),
    benefit: clip(b.benefit, 80),
    message: clip(b.message, 1000),
  };
  if (!rec.parent || !rec.student || !rec.age || !/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(rec.phone.replace(/\s/g, ''))) {
    return res.status(400).json({ ok: false, error: 'invalid' });
  }

  try {
    if (await overLimit(`epsom:rl:${clientIp(req)}`, 10, 3600)) {
      return res.status(429).json({ ok: false, error: 'too_many' });
    }
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await saveEntry(req, { id, createdAt: new Date().toISOString(), status: 'new', memo: '', ...rec });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('consult save failed', err);
    const code = storageErrorCode(err);
    return res.status(code === 'storage_not_configured' ? 503 : 500).json({ ok: false, error: code });
  }
};
