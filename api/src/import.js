'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { query } = require('./db');

const TALKGROUPS_DIR = process.env.TALKGROUPS_DIR || '/talkgroups';
const TG_FILE_RE     = /^([0-9A-Fa-f]+)\.csv$/;
const SITES_FILE_RE  = /^([0-9A-Fa-f]+)\.sites\.csv$/;

// ── Talkgroup CSV import ────────────────────────────────────────────────────

function parseTalkgroupRow(row) {
  const tgid = parseInt(row['Decimal'] || row['decimal'] || row['TGID'] || row['tgid'], 10);
  if (!Number.isFinite(tgid)) return null;

  const alpha = row['Alpha Tag'] || row['alpha_tag'] || null;
  const desc  = row['Description'] || row['description'] || null;
  // classic RR export: "Group"; TRS export: "Category"
  const group = row['Group'] || row['group'] || row['Category'] || row['category'] || row['group_tag'] || null;

  // Classic export has explicit "Encrypted" (0/1). TRS export encodes it in "Mode" —
  // "D" = digital clear, "De" = sometimes encrypted, "DE" = always encrypted.
  let enc;
  if (row['Encrypted'] != null || row['encrypted'] != null) {
    const v = (row['Encrypted'] ?? row['encrypted']).toString().trim().toLowerCase();
    enc = v === '1' || v === 'true' || v === 'yes';
  } else {
    const mode = (row['Mode'] || row['mode'] || '').toString();
    enc = /e/i.test(mode.replace(/^D/, ''));  // any 'e' after the leading D
  }

  return { tgid, alpha, desc, group, enc };
}

const TRS_TG_HEADER = 'Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category';
// RR TRS exports sometimes embed bare double-quotes inside quoted fields
// (e.g. `Ops 3 "Tac"`) without RFC 4180 doubling — csv-parse can't recover.
// For this known shape we fall back to a structural regex.
const TRS_TG_LINE = /^(\d+),([0-9a-fA-F]+),"([\s\S]*?)","([\s\S]*?)","([\s\S]*?)","([\s\S]*?)","([\s\S]*?)"\s*$/;

function parseTrsTalkgroups(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== TRS_TG_HEADER) return null;
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = line.match(TRS_TG_LINE);
    if (!m) { out.push({ __bad: line }); continue; }
    out.push({
      Decimal: m[1], Hex: m[2], 'Alpha Tag': m[3],
      Mode: m[4], Description: m[5], Tag: m[6], Category: m[7],
    });
  }
  return out;
}

async function importTalkgroupFile(filePath, sysid) {
  const text = fs.readFileSync(filePath, 'utf8');
  const trsRows = parseTrsTalkgroups(text);
  const rows = trsRows || parse(text, {
    columns: true, skip_empty_lines: true, trim: true,
    relax_column_count: true, relax_quotes: true,
  });

  await query(`SELECT upsert_system($1, $2)`, [sysid, sysid]);

  let imported = 0, skipped = 0;
  for (const row of rows) {
    if (row.__bad) { skipped++; continue; }
    const parsed = parseTalkgroupRow(row);
    if (!parsed) { skipped++; continue; }
    await query(`
      INSERT INTO talkgroups(sysid, tgid, alpha_tag, description, group_tag, encrypted)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (sysid, tgid) DO UPDATE
        SET alpha_tag   = EXCLUDED.alpha_tag,
            description = EXCLUDED.description,
            group_tag   = EXCLUDED.group_tag,
            encrypted   = EXCLUDED.encrypted
    `, [sysid, parsed.tgid, parsed.alpha, parsed.desc, parsed.group, parsed.enc]);
    imported++;
  }
  return { imported, skipped };
}

// ── Sites CSV import (RR TRS sites export) ──────────────────────────────────

function parseFrequencies(raw) {
  // The RR CSV "Frequencies" cell is itself a comma-separated list inside one
  // csv field (already split by csv-parse). Our row has each freq as its own
  // column because the file has a variable column count — so we reassemble.
  const control = [];
  const voice   = [];
  for (const tok of raw) {
    if (!tok) continue;
    const s = tok.toString().trim();
    if (!s) continue;
    const isControl = /c$/i.test(s);
    const mhz = parseFloat(s.replace(/c$/i, ''));
    if (!Number.isFinite(mhz)) continue;
    const hz = Math.round(mhz * 1e6);
    (isControl ? control : voice).push(hz);
  }
  return { control, voice };
}

async function importSitesFile(filePath, sysid) {
  // Site rows have a variable column count because "Frequencies" is a bare
  // comma-separated tail. Parse without header-mapping, then zip manually.
  const rows = parse(fs.readFileSync(filePath, 'utf8'), {
    columns: false, skip_empty_lines: true, trim: true,
    relax_column_count: true, relax_quotes: true,
  });
  if (rows.length < 2) return { imported: 0, skipped: 0 };

  // Expected header: RFSS, Site Dec, Site Hex, Site NAC, Description, County Name, Lat, Lon, Range, Frequencies...
  const FIXED = 9;
  await query(`SELECT upsert_system($1, $2)`, [sysid, sysid]);

  let imported = 0, skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < FIXED + 1) { skipped++; continue; }
    const rfss   = parseInt(r[0], 10) || null;
    const siteId = parseInt(r[1], 10);
    if (!Number.isFinite(siteId)) { skipped++; continue; }
    const nac    = r[3] || null;
    const desc   = r[4] || null;
    const county = r[5] || null;
    const lat    = parseFloat(r[6]); const lon = parseFloat(r[7]);
    const rng    = parseInt(r[8], 10) || null;
    const { control, voice } = parseFrequencies(r.slice(FIXED));

    await query(`
      INSERT INTO sites(sysid, site_id, rfss_id, nac, description, county, lat, lon, range_mi, control_freqs, voice_freqs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (sysid, rfss_id, site_id) DO UPDATE SET
        nac           = EXCLUDED.nac,
        description   = EXCLUDED.description,
        county        = EXCLUDED.county,
        lat           = EXCLUDED.lat,
        lon           = EXCLUDED.lon,
        range_mi      = EXCLUDED.range_mi,
        control_freqs = EXCLUDED.control_freqs,
        voice_freqs   = EXCLUDED.voice_freqs,
        last_seen     = now()
    `, [sysid, siteId, rfss, nac, desc, county,
        Number.isFinite(lat) ? lat : null, Number.isFinite(lon) ? lon : null,
        rng, control, voice]);
    imported++;
  }
  return { imported, skipped };
}

// ── Orchestration ───────────────────────────────────────────────────────────

async function importTalkgroupsFromDisk() {
  let entries;
  try {
    entries = fs.readdirSync(TALKGROUPS_DIR);
  } catch (err) {
    console.log(`[import] skipped — ${TALKGROUPS_DIR} not readable: ${err.code}`);
    return;
  }

  const sites = [], tgs = [], skipped = [];
  for (const name of entries) {
    let m;
    if      ((m = name.match(SITES_FILE_RE)))  sites.push({ name, sysid: m[1].toUpperCase() });
    else if ((m = name.match(TG_FILE_RE)))     tgs.push({ name, sysid: m[1].toUpperCase() });
    else if (name.toLowerCase().endsWith('.csv')) skipped.push(name);
  }

  if (skipped.length) {
    console.log(`[import] ignoring CSVs not matching <sysid>.csv or <sysid>.sites.csv: ${skipped.join(', ')}`);
  }

  // Sites first so FK + system_stats exist before talkgroups attach
  for (const { name, sysid } of sites) {
    try {
      const { imported, skipped } = await importSitesFile(path.join(TALKGROUPS_DIR, name), sysid);
      console.log(`[import] ${name} → sysid=${sysid}: ${imported} site(s)${skipped ? `, ${skipped} skipped` : ''}`);
    } catch (err) {
      console.error(`[import] ${name} failed: ${err.message}`);
    }
  }
  for (const { name, sysid } of tgs) {
    try {
      const { imported, skipped } = await importTalkgroupFile(path.join(TALKGROUPS_DIR, name), sysid);
      console.log(`[import] ${name} → sysid=${sysid}: ${imported} talkgroup(s)${skipped ? `, ${skipped} skipped` : ''}`);
    } catch (err) {
      console.error(`[import] ${name} failed: ${err.message}`);
    }
  }
}

module.exports = { importTalkgroupsFromDisk };
