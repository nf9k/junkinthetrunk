'use strict';

const soap = require('soap');
const fs   = require('fs');
const path = require('path');
const { query } = require('./db');

const WSDL           = 'https://api.radioreference.com/soap2/?wsdl';
const TALKGROUPS_DIR = process.env.TALKGROUPS_DIR || '/talkgroups';

let _client = null;
async function getClient() {
  if (!_client) _client = await soap.createClientAsync(WSDL);
  return _client;
}

function authInfo() {
  return {
    username: process.env.RR_USERNAME || '',
    password: process.env.RR_PASSWORD || '',
    appKey:   process.env.RR_APP_KEY  || '',
    version:  '15',
    style:    'rpc',
  };
}

// "5737:262,9999:6BD" → [{ rrSid: 5737, sysid: '262' }, ...]
function parseSystems() {
  return (process.env.RR_SYSTEMS || '')
    .split(',')
    .map(s => {
      const [a, b] = s.trim().split(':');
      return { rrSid: parseInt(a, 10), sysid: b?.toUpperCase() };
    })
    .filter(({ rrSid, sysid }) => Number.isFinite(rrSid) && sysid);
}

// RR SOAP wraps scalars as { attributes: {...}, $value: x } when xsi:type is present
function val(x) {
  if (x == null) return null;
  if (typeof x === 'object' && '$value' in x) return x.$value;
  return x;
}

// RR SOAP returns SOAP-ENC:Arrays as { item: x } where x is an object (1 elem) or array (n>1)
function asArray(v) {
  if (!v) return [];
  const src = (v && 'item' in v) ? v.item : v;
  return Array.isArray(src) ? src : [src];
}

function csvEsc(s) {
  const str = (s ?? '').toString().replace(/"/g, '""');
  return `"${str}"`;
}

// Fetch tag descriptions for a set of tagIds (one call each, in parallel)
async function fetchTagMap(tagIds, auth) {
  const c = await getClient();
  const entries = await Promise.all(
    [...tagIds].map(async id => {
      try {
        const [res] = await c.getTagAsync({ id, authInfo: auth });
        const items = asArray(res?.return);
        const descr = items.length ? (val(items[0].tagDescr) || '') : '';
        return [id, descr];
      } catch {
        return [id, ''];
      }
    })
  );
  return Object.fromEntries(entries);
}

async function syncSystem(rrSid, sysid) {
  const c = await getClient();
  const auth = authInfo();

  const [res] = await c.getTrsTalkgroupsAsync({
    sid: rrSid, tgCid: 0, tgTag: 0, tgDec: 0,
    authInfo: auth,
  });

  const records = asArray(res?.return);

  // Collect unique tagIds so we can fetch names in one parallel batch
  const tagIdSet = new Set();
  for (const tg of records) {
    for (const item of asArray(tg.tags)) {
      const id = val(item.tagId);
      if (id != null) tagIdSet.add(id);
    }
  }
  const tagMap = await fetchTagMap(tagIdSet, auth);

  const csvLines = ['Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category'];
  let upserted = 0;

  for (const tg of records) {
    const tgid = parseInt(val(tg.tgDec), 10);
    if (!Number.isFinite(tgid)) continue;

    const hex   = tgid.toString(16).toUpperCase();
    const alpha = (val(tg.tgAlpha) || '').toString().trim();
    const desc  = (val(tg.tgDescr) || '').toString().trim();
    const mode  = (val(tg.tgMode)  || 'D').toString().trim();
    const enc   = parseInt(val(tg.enc), 10) === 1;

    const tagItems  = asArray(tg.tags);
    const tagDescr  = tagItems.length ? (tagMap[val(tagItems[0].tagId)] || '') : '';

    csvLines.push(
      `${tgid},${hex},${csvEsc(alpha)},${mode},${csvEsc(desc)},${csvEsc(tagDescr)},`
    );

    await query(`
      INSERT INTO talkgroups(sysid, tgid, alpha_tag, description, group_tag, encrypted)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (sysid, tgid) DO UPDATE
        SET alpha_tag   = EXCLUDED.alpha_tag,
            description = EXCLUDED.description,
            group_tag   = EXCLUDED.group_tag,
            encrypted   = EXCLUDED.encrypted
    `, [sysid, tgid, alpha || null, desc || null, tagDescr || null, enc]);
    upserted++;
  }

  const csvPath = path.join(TALKGROUPS_DIR, `${sysid}.csv`);
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf8');
  console.log(`[rr-sync] ${sysid}: ${upserted} talkgroups, ${tagIdSet.size} tags → ${csvPath}`);

  return { sysid, rrSid, total: upserted };
}

async function syncAll() {
  const systems = parseSystems();
  if (!systems.length) throw new Error('RR_SYSTEMS not configured (format: "5737:262")');
  const results = [];
  for (const { rrSid, sysid } of systems) {
    results.push(await syncSystem(rrSid, sysid));
  }
  return results;
}

module.exports = { syncAll, parseSystems };
