'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { query } = require('./db');

const TALKGROUPS_DIR = process.env.TALKGROUPS_DIR || '/talkgroups';
const SYSID_FILE_RE  = /^([0-9A-Fa-f]+)\.csv$/;

async function importOne(filePath, sysid) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  await query(`SELECT upsert_system($1, $2)`, [sysid, sysid]);

  let imported = 0, skipped = 0;
  for (const row of rows) {
    const tgid = parseInt(row['Decimal'] || row['decimal'] || row['TGID'] || row['tgid'], 10);
    if (!Number.isFinite(tgid)) { skipped++; continue; }

    const alpha = row['Alpha Tag'] || row['alpha_tag'] || null;
    const desc  = row['Description'] || row['description'] || null;
    const group = row['Group'] || row['group'] || row['group_tag'] || null;
    const encStr = (row['Encrypted'] || row['encrypted'] || '').toString().trim();
    const enc = encStr === '1' || encStr.toLowerCase() === 'true' || encStr.toLowerCase() === 'yes';

    await query(`
      INSERT INTO talkgroups(sysid, tgid, alpha_tag, description, group_tag, encrypted)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (sysid, tgid) DO UPDATE
        SET alpha_tag   = EXCLUDED.alpha_tag,
            description = EXCLUDED.description,
            group_tag   = EXCLUDED.group_tag,
            encrypted   = EXCLUDED.encrypted
    `, [sysid, tgid, alpha, desc, group, enc]);
    imported++;
  }
  return { imported, skipped };
}

async function importTalkgroupsFromDisk() {
  let entries;
  try {
    entries = fs.readdirSync(TALKGROUPS_DIR);
  } catch (err) {
    console.log(`[import] skipped — ${TALKGROUPS_DIR} not readable: ${err.code}`);
    return;
  }

  const matched = [];
  const skippedNames = [];
  for (const name of entries) {
    const m = name.match(SYSID_FILE_RE);
    if (m) matched.push({ name, sysid: m[1].toUpperCase() });
    else if (name.toLowerCase().endsWith('.csv')) skippedNames.push(name);
  }

  if (skippedNames.length) {
    console.log(`[import] ignoring non-sysid CSVs: ${skippedNames.join(', ')} (expected <sysid>.csv)`);
  }
  if (matched.length === 0) {
    console.log(`[import] no <sysid>.csv files in ${TALKGROUPS_DIR}`);
    return;
  }

  for (const { name, sysid } of matched) {
    try {
      const { imported, skipped } = await importOne(path.join(TALKGROUPS_DIR, name), sysid);
      console.log(`[import] ${name} → sysid=${sysid}: ${imported} talkgroup(s) upserted${skipped ? `, ${skipped} skipped` : ''}`);
    } catch (err) {
      console.error(`[import] ${name} failed: ${err.message}`);
    }
  }
}

module.exports = { importTalkgroupsFromDisk };
