'use strict';

const { Router } = require('express');
const { query }  = require('../db');
const fs         = require('fs');
const router     = Router();

let _bandplans = null;
function getBandplans() {
  if (_bandplans) return _bandplans;
  try {
    const cfg = JSON.parse(fs.readFileSync('/app/tr-config.json', 'utf8'));
    _bandplans = {};
    for (const sys of (cfg.systems || [])) {
      if (sys.shortName) _bandplans[sys.shortName.toUpperCase()] = sys.bandplan || null;
    }
  } catch { _bandplans = {}; }
  return _bandplans;
}

// GET /api/systems
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT s.*, ss.calls_today, ss.calls_hour, ss.active_tgs
    FROM   systems s
    LEFT JOIN system_stats ss ON ss.sysid = s.sysid
    ORDER  BY s.last_seen DESC
  `);
  res.json(rows);
});

// GET /api/systems/:sysid
router.get('/:sysid', async (req, res) => {
  const sysid = req.params.sysid.toUpperCase();
  const { rows } = await query(`
    SELECT s.*,
           ss.calls_today, ss.calls_hour, ss.active_tgs,
           ss.current_site_id, ss.current_control_freq, ss.current_decode_rate,
           ss.squelch_db, ss.sdr_sources_json, ss.recorders_json,
           ss.recorders_updated_at
    FROM   systems s
    LEFT JOIN system_stats ss ON ss.sysid = s.sysid
    WHERE  s.sysid = $1
  `, [sysid]);
  if (!rows.length) return res.status(404).json({ error: 'System not found' });
  const system = rows[0];

  const { rows: sites } = await query(
    `SELECT * FROM sites WHERE sysid=$1 ORDER BY rfss_id, site_id`, [sysid]
  );
  system.sites = sites;
  system.bandplan = getBandplans()[sysid] || null;
  res.json(system);
});

// GET /api/systems/:sysid/active
router.get('/:sysid/active', async (req, res) => {
  const sysid = req.params.sysid.toUpperCase();
  const { rows } = await query(`
    SELECT * FROM active_calls
    WHERE  sysid = $1
    ORDER  BY start_time ASC
  `, [sysid]);
  res.json(rows);
});

// GET /api/systems/:sysid/stats  — call rate for sparkline
router.get('/:sysid/stats', async (req, res) => {
  const sysid  = req.params.sysid.toUpperCase();
  const hours  = parseInt(req.query.hours || '24', 10);

  const { rows } = await query(`
    SELECT
      date_trunc('hour', start_time) AS hour,
      COUNT(*)                        AS call_count
    FROM  calls
    WHERE sysid     = $1
      AND start_time >= now() - ($2 || ' hours')::INTERVAL
    GROUP BY 1
    ORDER BY 1
  `, [sysid, hours]);
  res.json(rows);
});

module.exports = router;
