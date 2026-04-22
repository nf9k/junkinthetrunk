'use strict';

const mqtt   = require('mqtt');
const { query } = require('./db');

const PREFIX = process.env.MQTT_TOPIC_PREFIX || 'jitr';
let   io     = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function emit(event, data) {
  if (io) io.emit(event, data);
}

function mhz(hz) {
  return hz ? (hz / 1e6).toFixed(4) + ' MHz' : null;
}

// tr-plugin-mqtt messages don't carry the P25 sysid (hex) — only sys_name
// (the trunk-recorder `shortName` from config) and sys_num (internal).
// Convention: set `shortName` in trunk-recorder.json to the hex sysid
// ("262", "6BD"), and we use it directly as the DB sysid key.
function sysidFrom(data) {
  const { sys_name, sys_num } = data;
  if (sys_name) return String(sys_name).toUpperCase();
  if (sys_num != null) return `SYS${sys_num}`;
  return null;
}

// ── Call handlers ────────────────────────────────────────────────────────────

async function handleCallStart(payload) {
  const call = payload.call || payload;
  const {
    talkgroup, talkgroup_alpha_tag, talkgroup_group,
    unit, freq, emergency, encrypted, phase2_tdma,
  } = call;

  const sid = sysidFrom(call);
  if (!sid) return;
  const phase = phase2_tdma ? 2 : 1;

  await query(`SELECT upsert_system($1, $2)`, [sid, call.sys_name || sid]);

  if (talkgroup != null) {
    await query(`
      INSERT INTO talkgroups(sysid, tgid, alpha_tag, group_tag, encrypted)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (sysid, tgid) DO UPDATE
        SET alpha_tag  = COALESCE(EXCLUDED.alpha_tag, talkgroups.alpha_tag),
            group_tag  = COALESCE(EXCLUDED.group_tag, talkgroups.group_tag),
            encrypted  = EXCLUDED.encrypted,
            last_active = now(),
            call_count  = talkgroups.call_count + 1
    `, [sid, talkgroup, talkgroup_alpha_tag || null, talkgroup_group || null, !!encrypted]);
  }

  const { rows } = await query(`
    INSERT INTO active_calls(sysid, tgid, alpha_tag, group_tag, source_unit, freq, emergency, encrypted, phase)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id
  `, [sid, talkgroup, talkgroup_alpha_tag || null, talkgroup_group || null,
      (unit && unit > 0) ? unit : null, freq || null, !!emergency, !!encrypted, phase]);

  emit('call:start', {
    id: rows[0].id,
    sysid: sid,
    tgid: talkgroup,
    alpha_tag: talkgroup_alpha_tag,
    group_tag: talkgroup_group,
    unit: (unit && unit > 0) ? unit : null,
    freq,
    freq_label: mhz(freq),
    emergency: !!emergency,
    encrypted: !!encrypted,
    phase,
    start_time: new Date().toISOString(),
  });
  console.log(`[call:start] ${sid} TG${talkgroup} (${talkgroup_alpha_tag || '?'}) ${mhz(freq)}`);
}

// Promote an active call into the permanent calls table, preserving
// start_time / unit / emergency / encrypted / freq from the active row.
// Used by both the real call_end handler and the calls_active synthesizer.
async function promoteActiveToCompleted(sid, tgid, { duration, audio_file }) {
  const { rows } = await query(`
    INSERT INTO calls(sysid, tgid, source_unit, freq, start_time,
                      duration, emergency, encrypted, audio_file, phase)
    SELECT sysid, tgid, source_unit, freq, start_time,
           COALESCE($3, EXTRACT(EPOCH FROM (now() - start_time))::numeric),
           emergency, encrypted, $4, phase
    FROM   active_calls
    WHERE  sysid = $1 AND tgid = $2
    ORDER  BY start_time DESC
    LIMIT  1
    RETURNING id
  `, [sid, tgid, duration ?? null, audio_file || null]);

  if (!rows.length) return null;

  await query(
    `DELETE FROM active_calls WHERE sysid=$1 AND tgid=$2`,
    [sid, tgid]
  );
  return rows[0].id;
}

async function handleCallEnd(payload) {
  const call = payload.call || payload;
  const { talkgroup, freq, length, call_filename } = call;
  const sid = sysidFrom(call);
  if (!sid || talkgroup == null) return;

  const callId = await promoteActiveToCompleted(sid, talkgroup, {
    duration: length,
    audio_file: call_filename,
  });

  emit('call:end', {
    sysid: sid,
    tgid: talkgroup,
    freq,
    duration: length,
    call_id: callId,
    has_audio: !!call_filename,
  });
}

// tr-plugin-mqtt only emits call_end once an audio recording has been
// written. For out-of-band voice frequencies (our single-dongle case)
// recording never starts, so no call_end fires. calls_active is a
// full active-call snapshot published once a second — by diffing
// consecutive snapshots we can detect disappearances and synthesize
// the missing call_end ourselves, keeping the call log populated.

const lastSeenCallNums = new Map();  // `${sysid}|${call_num}` → { sysid, tgid }

async function handleCallsActive(payload) {
  const current = new Map();
  const list = Array.isArray(payload.calls) ? payload.calls : [];
  for (const c of list) {
    const sid = sysidFrom(c);
    if (!sid || c.call_num == null || c.talkgroup == null) continue;
    current.set(`${sid}|${c.call_num}`, { sysid: sid, tgid: c.talkgroup });
  }

  for (const [key, prev] of lastSeenCallNums) {
    if (current.has(key)) continue;
    try {
      const callId = await promoteActiveToCompleted(prev.sysid, prev.tgid, {
        duration: null, audio_file: null,
      });
      if (callId) {
        emit('call:end', {
          sysid: prev.sysid, tgid: prev.tgid,
          call_id: callId, has_audio: false,
        });
      }
    } catch (err) {
      console.error(`[mqtt] synth call_end failed ${prev.sysid} TG${prev.tgid}:`, err.message);
    }
  }

  lastSeenCallNums.clear();
  for (const [key, val] of current) lastSeenCallNums.set(key, val);
}

// ── System metadata / realtime handlers ─────────────────────────────────────

// Retained message: system discovery. Fills in WACN/NAC/RFSS on the systems
// row and records which site is currently primary.
//
// Caveat: the plugin publishes an ALL-ZERO initial message right after the
// decoder starts, before it's received a network status TSBK from the
// control channel. Treat "0" / 0 as sentinels and preserve any existing
// real values via COALESCE so a later real message isn't clobbered.
async function handleSystems(payload) {
  for (const s of payload.systems || []) {
    const sid = sysidFrom(s);
    if (!sid) continue;

    const rawWacn = s.wacn != null ? String(s.wacn).trim() : '';
    const rawNac  = s.nac  != null ? String(s.nac).trim()  : '';
    const wacn   = (rawWacn && rawWacn !== '0') ? rawWacn.toUpperCase() : null;
    const nac    = (rawNac  && rawNac  !== '0') ? (parseInt(rawNac, 16) || null) : null;
    const rfss   = (s.rfss    != null && s.rfss    > 0) ? parseInt(s.rfss, 10)    : null;
    const siteId = (s.site_id != null && s.site_id > 0) ? parseInt(s.site_id, 10) : null;

    await query(`SELECT upsert_system($1, $2)`, [sid, s.sys_name || sid]);

    await query(`
      UPDATE systems SET
        wacn      = COALESCE($2, wacn),
        nac       = COALESCE($3, nac),
        rfss      = COALESCE($4, rfss),
        last_seen = now()
      WHERE sysid = $1
    `, [sid, wacn, nac, rfss]);

    await query(`
      INSERT INTO system_stats(sysid, current_site_id) VALUES ($1, $2)
      ON CONFLICT (sysid) DO UPDATE
        SET current_site_id = COALESCE(EXCLUDED.current_site_id, system_stats.current_site_id),
            updated_at      = now()
    `, [sid, siteId]);
  }
}

// Retained message: full trunk-recorder config. We pluck squelch per system
// and save the full sources[] array (SDR tuning windows) per system.
async function handleConfig(payload) {
  const cfg = payload.config || {};
  const sources = cfg.sources || [];
  const sourcesJson = JSON.stringify(sources);
  for (const sys of cfg.systems || []) {
    const sid = (sys.sys_name || sys.short_name || sys.shortName || '').toString().toUpperCase();
    if (!sid) continue;
    await query(`
      INSERT INTO system_stats(sysid, squelch_db, sdr_sources_json)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (sysid) DO UPDATE
        SET squelch_db       = EXCLUDED.squelch_db,
            sdr_sources_json = EXCLUDED.sdr_sources_json,
            updated_at       = now()
    `, [sid, sys.squelch_db != null ? Math.round(sys.squelch_db) : null, sourcesJson]);
  }
}

// ~every 3s from the plugin. Updates rate + current CC in system_stats.
async function handleRates(payload) {
  for (const r of payload.rates || []) {
    const sid = sysidFrom(r);
    if (!sid) continue;
    await query(`
      INSERT INTO system_stats(sysid, current_control_freq, current_decode_rate)
      VALUES ($1, $2, $3)
      ON CONFLICT (sysid) DO UPDATE
        SET current_control_freq = EXCLUDED.current_control_freq,
            current_decode_rate  = EXCLUDED.current_decode_rate,
            updated_at           = now()
    `, [sid, r.control_channel != null ? Math.round(r.control_channel) : null,
        r.decoderate != null ? Number(r.decoderate).toFixed(2) : null]);
  }
  emit('rates', payload);
}

// Every 3s: snapshot of every recorder's state (idle / recording / ...).
// Recorders aren't naturally per-system (one SDR serves multiple), so we
// write the same snapshot to every configured system — good enough for
// single-system stacks, honest for multi-system.
async function handleRecorders(payload) {
  const recorders = payload.recorders || [];
  await query(`
    UPDATE system_stats
       SET recorders_json       = $1::jsonb,
           recorders_updated_at = now()
  `, [JSON.stringify(recorders)]);
}

// ── Unit handlers ────────────────────────────────────────────────────────────
// Plugin publishes to `<unit_topic>/<shortname>/<event>` where event is
// call / on / off / join / data / ans_req / location / ackresp.
// Payload shape: { type, [type]: { sys_name, unit, ... }, timestamp }

async function handleUnit(payload) {
  const type = payload.type;
  if (!type) return;
  const data = payload[type] || payload;
  const sid = sysidFrom(data);
  const unit = data.unit;
  if (!sid || !unit || unit < 1) return;

  const isCall = type === 'call';
  const hasTg  = (type === 'call' || type === 'join') && data.talkgroup != null;

  await query(`SELECT upsert_system($1, $2)`, [sid, data.sys_name || sid]);

  await query(`
    INSERT INTO units(sysid, unit_id, last_tgid, last_freq, call_count, last_seen)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (sysid, unit_id) DO UPDATE
      SET last_tgid  = COALESCE(EXCLUDED.last_tgid,  units.last_tgid),
          last_freq  = COALESCE(EXCLUDED.last_freq,  units.last_freq),
          call_count = units.call_count + $5,
          last_seen  = now()
  `, [sid, unit,
      hasTg ? data.talkgroup : null,
      isCall ? (data.freq || null) : null,
      isCall ? 1 : 0]);
}

// ── Topic router ──────────────────────────────────────────────────────────────

async function dispatch(topic, raw) {
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const sub = topic.startsWith(`${PREFIX}/`) ? topic.slice(PREFIX.length + 1) : topic;

  try {
    if      (sub === 'call_start')      await handleCallStart(payload);
    else if (sub === 'call_end')        await handleCallEnd(payload);
    else if (sub === 'rates')           await handleRates(payload);
    else if (sub === 'calls_active')    await handleCallsActive(payload);
    else if (sub === 'systems')         await handleSystems(payload);
    else if (sub === 'config')          await handleConfig(payload);
    else if (sub === 'recorders')       await handleRecorders(payload);
    else if (sub.startsWith('units/'))  await handleUnit(payload);
  } catch (err) {
    console.error(`[mqtt] handler error for ${topic}:`, err.message);
  }
}

// ── Connect ───────────────────────────────────────────────────────────────────

function connect(socketIo) {
  io = socketIo;

  const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://mosquitto:1883', {
    clientId: 'jitr-api',
    clean:    true,
    reconnectPeriod: 3000,
  });

  client.on('connect', () => {
    console.log('[mqtt] connected');
    client.subscribe(`${PREFIX}/#`, { qos: 0 }, (err) => {
      if (err) console.error('[mqtt] subscribe error:', err.message);
      else console.log(`[mqtt] subscribed to ${PREFIX}/#`);
    });
  });

  client.on('message', dispatch);
  client.on('error',   (err) => console.error('[mqtt] error:', err.message));
  client.on('offline', ()    => console.warn('[mqtt] offline — reconnecting...'));

  return client;
}

module.exports = { connect };
