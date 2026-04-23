'use strict';

const { Router } = require('express');
const { syncAll } = require('../rr');

const router = Router();

router.post('/sync-rr', async (req, res) => {
  try {
    const results = await syncAll();
    const total = results.reduce((n, r) => n + r.total, 0);
    res.json({ ok: true, results, total });
  } catch (err) {
    console.error('[admin] sync-rr error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
