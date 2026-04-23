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

// ── US state lookup tables ────────────────────────────────────────────────────

const US_STATE_STIDS = {
  AL:1, AK:2, AZ:4, AR:5, CA:6, CO:8, CT:9, DE:10, DC:11, FL:12, GA:13,
  HI:15, ID:16, IL:17, IN:18, IA:19, KS:20, KY:21, LA:22, ME:23, MD:24,
  MA:25, MI:26, MN:27, MS:28, MO:29, MT:30, NE:31, NV:32, NH:33, NJ:34,
  NM:35, NY:36, NC:37, ND:38, OH:39, OK:40, OR:41, PA:42, RI:44, SC:45,
  SD:46, TN:47, TX:48, UT:49, VT:50, VA:51, WA:53, WV:54, WI:55, WY:56,
};

const STID_NAMES = {
  1:'Alabama', 2:'Alaska', 4:'Arizona', 5:'Arkansas', 6:'California',
  8:'Colorado', 9:'Connecticut', 10:'Delaware', 11:'District of Columbia',
  12:'Florida', 13:'Georgia', 15:'Hawaii', 16:'Idaho', 17:'Illinois',
  18:'Indiana', 19:'Iowa', 20:'Kansas', 21:'Kentucky', 22:'Louisiana',
  23:'Maine', 24:'Maryland', 25:'Massachusetts', 26:'Michigan', 27:'Minnesota',
  28:'Mississippi', 29:'Missouri', 30:'Montana', 31:'Nebraska', 32:'Nevada',
  33:'New Hampshire', 34:'New Jersey', 35:'New Mexico', 36:'New York',
  37:'North Carolina', 38:'North Dakota', 39:'Ohio', 40:'Oklahoma', 41:'Oregon',
  42:'Pennsylvania', 44:'Rhode Island', 45:'South Carolina', 46:'South Dakota',
  47:'Tennessee', 48:'Texas', 49:'Utah', 50:'Vermont', 51:'Virginia',
  53:'Washington', 54:'West Virginia', 55:'Wisconsin', 56:'Wyoming',
};

// ── Haversine distance in miles ───────────────────────────────────────────────

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── List all US states ────────────────────────────────────────────────────────

function listStates() {
  return Object.entries(STID_NAMES)
    .map(([stid, name]) => ({ stid: parseInt(stid, 10), name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Counties for a state ──────────────────────────────────────────────────────

async function getCounties(stid) {
  const c = await getClient();
  const [res] = await c.getStateInfoAsync({ stid: parseInt(stid, 10), authInfo: authInfo() });
  return asArray(res?.return?.countyList).map(co => ({
    ctid: val(co.ctid),
    name: (val(co.countyName) || '').toString(),
  }));
}

// ── TRS systems in a county ───────────────────────────────────────────────────

async function getTrsInCounty(ctid) {
  const c = await getClient();
  const [res] = await c.getCountyInfoAsync({ ctid: parseInt(ctid, 10), authInfo: authInfo() });
  const info = res?.return;
  const trsList = asArray(info?.trsList);
  return trsList.map(s => ({
    sid:  val(s.sid),
    name: (val(s.sName)  || '').toString(),
    city: (val(s.sCity)  || '').toString(),
    type: parseInt(val(s.sType) || 0, 10),
  }));
}

// ── Full TRS system details ───────────────────────────────────────────────────

async function getTrsDetail(sid) {
  const c = await getClient();
  const [res] = await c.getTrsDetailsAsync({ sid: parseInt(sid, 10), authInfo: authInfo() });
  const info = res?.return;

  const sysidItems = asArray(info?.sysid);
  const sysids = sysidItems
    .map(item => ({
      sysid: (val(item.sysid) || '').toString(),
      wacn:  (val(item.wacn)  || '').toString(),
    }))
    .filter(s => s.sysid);

  return {
    sid:    parseInt(sid, 10),
    name:   (val(info?.sName) || '').toString(),
    city:   (val(info?.sCity) || '').toString(),
    type:   parseInt(val(info?.sType) || 0, 10),
    lat:    parseFloat(val(info?.lat)  || 0),
    lon:    parseFloat(val(info?.lon)  || 0),
    sysids,
  };
}

// ── Search nearby P25 systems ─────────────────────────────────────────────────

async function searchNearby(lat, lon, stateCode) {
  const stid = US_STATE_STIDS[(stateCode || '').toUpperCase()];
  if (!stid) throw new Error(`Unknown state code: ${stateCode}`);

  const c = await getClient();
  const auth = authInfo();

  // 1. Get state info → county list
  const [stateRes] = await c.getStateInfoAsync({ stid, authInfo: auth });
  const stateInfo = stateRes?.return;
  const countyList = asArray(stateInfo?.countyList);

  // 2. Reverse geocode via Nominatim to find county
  let countyCtid = null;
  try {
    const nmRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'User-Agent': 'JunkInTheTrunk/1.0 (homelab P25 monitor)' } }
    );
    const nmData = await nmRes.json();
    const rawCounty = (nmData?.address?.county || '').replace(/ County$/i, '').trim();
    if (rawCounty) {
      const match = countyList.find(co => {
        const coName = (val(co.countyName) || '').replace(/ County$/i, '').trim();
        return coName.toLowerCase() === rawCounty.toLowerCase();
      });
      if (match) countyCtid = val(match.ctid);
    }
  } catch (err) {
    console.warn('[rr] Nominatim reverse geocode failed:', err.message);
  }

  // 3. Gather TRS systems from county (and state-level trsList as fallback)
  let candidates = [];

  if (countyCtid) {
    try {
      const [coRes] = await c.getCountyInfoAsync({ ctid: parseInt(countyCtid, 10), authInfo: auth });
      const coInfo = coRes?.return;
      const trs = asArray(coInfo?.trsList);
      candidates.push(...trs.map(s => ({ sid: val(s.sid), name: val(s.sName), city: val(s.sCity), type: parseInt(val(s.sType) || 0, 10) })));
    } catch (err) {
      console.warn('[rr] county TRS fetch failed:', err.message);
    }
  }

  // Also include state-level TRS list
  const stateTrs = asArray(stateInfo?.trsList);
  for (const s of stateTrs) {
    const sid = val(s.sid);
    if (sid && !candidates.find(c => String(c.sid) === String(sid))) {
      candidates.push({ sid, name: val(s.sName), city: val(s.sCity), type: parseInt(val(s.sType) || 0, 10) });
    }
  }

  // 4. Fetch details for each system in parallel to get lat/lon + sysid
  const details = await Promise.all(
    candidates.map(async (cand) => {
      try {
        const d = await getTrsDetail(cand.sid);
        return { ...cand, ...d };
      } catch {
        return null;
      }
    })
  );

  // 5. Filter by <= 25 miles, compute distance, sort
  const results = details
    .filter(d => d && d.lat && d.lon)
    .map(d => ({ ...d, dist: haversineMi(lat, lon, d.lat, d.lon) }))
    .filter(d => d.dist <= 25)
    .sort((a, b) => a.dist - b.dist);

  return results;
}

// ── Import sites for a system from RR into DB ─────────────────────────────────

async function importSitesFromRr(rrSid, sysid) {
  const c = await getClient();
  const [res] = await c.getTrsSitesAsync({ sid: parseInt(rrSid, 10), authInfo: authInfo() });
  const sites = asArray(res?.return);
  let count = 0;

  for (const site of sites) {
    const siteNumber = parseInt(val(site.siteNumber) || 0, 10);
    const rfss       = parseInt(val(site.rfss)       || 0, 10);
    const nac        = (val(site.nac)      || '').toString() || null;
    const description= (val(site.siteDescr)|| '').toString() || null;
    const siteLat    = parseFloat(val(site.lat)   || 0) || null;
    const siteLon    = parseFloat(val(site.lon)   || 0) || null;
    const rangeMi    = parseInt(val(site.range)   || 0, 10) || null;

    // Convert MHz frequencies to Hz
    const freqItems = asArray(site.siteFreqs);
    const voiceFreqs = freqItems
      .map(f => {
        const mhz = parseFloat(val(f.freq) || 0);
        return mhz > 0 ? Math.round(mhz * 1e6) : null;
      })
      .filter(Boolean);

    await query(`
      INSERT INTO sites (sysid, site_id, rfss_id, nac, description, lat, lon, range_mi, voice_freqs)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (sysid, rfss_id, site_id) DO UPDATE
        SET nac         = EXCLUDED.nac,
            description = EXCLUDED.description,
            lat         = EXCLUDED.lat,
            lon         = EXCLUDED.lon,
            range_mi    = EXCLUDED.range_mi,
            voice_freqs = EXCLUDED.voice_freqs,
            last_seen   = now()
    `, [sysid, siteNumber, rfss, nac, description, siteLat, siteLon, rangeMi, voiceFreqs]);

    count++;
  }

  console.log(`[rr-sites] ${sysid}: ${count} sites imported`);
  return count;
}

// ── Full add-system flow ──────────────────────────────────────────────────────

async function addSystem(rrSid) {
  const detail = await getTrsDetail(rrSid);
  if (!detail.sysids.length) throw new Error('No sysid found for this system in RadioReference');

  const sysid = detail.sysids[0].sysid.toUpperCase();

  await query(`SELECT upsert_system($1, $2)`, [sysid, sysid]);
  if (detail.name) {
    await query(`UPDATE systems SET name = $1 WHERE sysid = $2 AND name IS NULL`, [detail.name, sysid]);
  }

  let talkgroups = 0, sites = 0;
  try {
    const r = await syncSystem(rrSid, sysid);
    talkgroups = r.total;
  } catch (err) {
    console.warn(`[rr] addSystem talkgroup sync failed for ${sysid}:`, err.message);
  }
  try {
    sites = await importSitesFromRr(rrSid, sysid);
  } catch (err) {
    console.warn(`[rr] addSystem site import failed for ${sysid}:`, err.message);
  }

  return { ok: true, sysid, rrSid, talkgroups, sites };
}

module.exports = { syncAll, parseSystems, listStates, getCounties, getTrsInCounty, getTrsDetail, searchNearby, addSystem };
