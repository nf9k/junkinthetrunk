'use strict';

const { Router } = require('express');
const { syncAll, listStates, getCounties, getTrsInCounty, getTrsDetail, searchNearby, addSystem } = require('../rr');

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

// GET /api/admin/rr/states
router.get('/rr/states', async (req, res) => {
  try {
    res.json(listStates());
  } catch (err) {
    console.error('[admin] rr/states error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/rr/counties/:stid
router.get('/rr/counties/:stid', async (req, res) => {
  try {
    const counties = await getCounties(req.params.stid);
    res.json(counties);
  } catch (err) {
    console.error('[admin] rr/counties error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/rr/county-trs/:ctid
router.get('/rr/county-trs/:ctid', async (req, res) => {
  try {
    const systems = await getTrsInCounty(req.params.ctid);
    res.json(systems);
  } catch (err) {
    console.error('[admin] rr/county-trs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/rr/nearby?lat=X&lon=Y&stateCode=XX
router.get('/rr/nearby', async (req, res) => {
  try {
    const { lat, lon, stateCode } = req.query;
    if (!lat || !lon || !stateCode) {
      return res.status(400).json({ error: 'lat, lon, and stateCode are required' });
    }
    const results = await searchNearby(parseFloat(lat), parseFloat(lon), stateCode);
    res.json(results);
  } catch (err) {
    console.error('[admin] rr/nearby error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/rr/system/:sid
router.get('/rr/system/:sid', async (req, res) => {
  try {
    const detail = await getTrsDetail(req.params.sid);
    res.json(detail);
  } catch (err) {
    console.error('[admin] rr/system error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/systems  body: { rrSid }
router.post('/systems', async (req, res) => {
  try {
    const { rrSid } = req.body;
    if (!rrSid) return res.status(400).json({ error: 'rrSid is required' });
    const result = await addSystem(parseInt(rrSid, 10));
    res.json(result);
  } catch (err) {
    console.error('[admin] add system error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
