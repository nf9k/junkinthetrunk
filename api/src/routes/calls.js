'use strict';

const { Router } = require('express');
const { query }  = require('../db');
const path       = require('path');
const fs         = require('fs');
const router     = Router();

const AUDIO_ROOT = process.env.AUDIO_PATH || '/audio';

// GET /api/calls?sysid=&tgid=&unit=&emergency=&limit=&offset=&since=
router.get('/', async (req, res) => {
  const {
    sysid, tgid, unit,
    emergency, encrypted,
    limit   = 100,
    offset  = 0,
    since,
  } = req.query;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  if (sysid)     { conditions.push(`c.sysid = $${p++}`);       params.push(sysid.toUpperCase()); }
  if (tgid)      { conditions.push(`c.tgid = $${p++}`);        params.push(parseInt(tgid)); }
  if (unit)      { conditions.push(`c.source_unit = $${p++}`); params.push(parseInt(unit)); }
  if (emergency === 'true') { conditions.push(`c.emergency = true`); }
  if (encrypted === 'true') { conditions.push(`c.encrypted = true`); }
  if (since)     { conditions.push(`c.start_time >= $${p++}`); params.push(since); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(`
    SELECT
      c.id, c.sysid, c.tgid, c.source_unit, c.freq,
      c.start_time, c.duration, c.emergency, c.encrypted,
      c.audio_file, c.phase,
      t.alpha_tag, t.group_tag
    FROM  calls c
    LEFT JOIN talkgroups t ON t.sysid = c.sysid AND t.tgid = c.tgid
    ${where}
    ORDER BY c.start_time DESC
    LIMIT  $${p++}
    OFFSET $${p++}
  `, [...params, parseInt(limit), parseInt(offset)]);

  res.json(rows);
});

// GET /api/calls/:id/audio  — stream audio file
router.get('/:id/audio', async (req, res) => {
  const { rows } = await query(
    `SELECT audio_file FROM calls WHERE id = $1`, [req.params.id]
  );
  if (!rows.length || !rows[0].audio_file) {
    return res.status(404).json({ error: 'No audio for this call' });
  }
  let af = rows[0].audio_file;
  // Normalize: strip absolute prefix written by some trunk-recorder builds
  if (af.startsWith('/app/audio/')) af = af.slice('/app/audio/'.length);
  else if (af.startsWith('/'))      af = af.slice(1);
  const filePath = path.join(AUDIO_ROOT, af);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file not found on disk' });
  }
  res.sendFile(filePath);
});

module.exports = router;
