'use strict';

const { Router } = require('express');
const { query }  = require('../db');
const router     = Router();

// GET /api/units?sysid=&limit=&offset=
router.get('/', async (req, res) => {
  const { sysid, limit = 100, offset = 0 } = req.query;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  if (sysid) { conditions.push(`u.sysid = $${p++}`); params.push(sysid.toUpperCase()); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(`
    SELECT
      u.*,
      t.alpha_tag AS last_tg_name,
      t.group_tag
    FROM  units u
    LEFT JOIN talkgroups t ON t.sysid = u.sysid AND t.tgid = u.last_tgid
    ${where}
    ORDER BY u.last_seen DESC
    LIMIT $${p++} OFFSET $${p++}
  `, [...params, parseInt(limit), parseInt(offset)]);

  res.json(rows);
});

module.exports = router;
