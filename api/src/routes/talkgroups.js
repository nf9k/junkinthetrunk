'use strict';

const { Router } = require('express');
const { query }  = require('../db');
const router     = Router();

// GET /api/talkgroups?sysid=&group_tag=&search=&limit=&offset=
router.get('/', async (req, res) => {
  const { sysid, group_tag, search, limit = 200, offset = 0 } = req.query;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  if (sysid)     { conditions.push(`sysid = $${p++}`);          params.push(sysid.toUpperCase()); }
  if (group_tag) { conditions.push(`group_tag = $${p++}`);      params.push(group_tag); }
  if (search)    {
    conditions.push(`(alpha_tag ILIKE $${p} OR description ILIKE $${p} OR tgid::TEXT = $${p})`);
    params.push(`%${search}%`); p++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(`
    SELECT * FROM talkgroups
    ${where}
    ORDER BY last_active DESC NULLS LAST, call_count DESC
    LIMIT $${p++} OFFSET $${p++}
  `, [...params, parseInt(limit), parseInt(offset)]);

  res.json(rows);
});

// POST /api/talkgroups/import  — bulk CSV import (RadioReference format)
// Body: { sysid, rows: [{tgid, alpha_tag, description, group_tag, encrypted}] }
router.post('/import', async (req, res) => {
  const { sysid, rows: tgs } = req.body;
  if (!sysid || !Array.isArray(tgs)) {
    return res.status(400).json({ error: 'sysid and rows[] required' });
  }
  const sid = sysid.toUpperCase();
  let imported = 0;
  for (const tg of tgs) {
    await query(`
      INSERT INTO talkgroups(sysid, tgid, alpha_tag, description, group_tag, encrypted)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (sysid, tgid) DO UPDATE
        SET alpha_tag   = EXCLUDED.alpha_tag,
            description = EXCLUDED.description,
            group_tag   = EXCLUDED.group_tag,
            encrypted   = EXCLUDED.encrypted
    `, [sid, tg.tgid, tg.alpha_tag || null, tg.description || null,
        tg.group_tag || null, !!tg.encrypted]);
    imported++;
  }
  res.json({ imported });
});

module.exports = router;
