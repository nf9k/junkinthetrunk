'use strict';

const mqtt   = require('mqtt');
const { query } = require('./db');

const PREFIX = process.env.MQTT_TOPIC_PREFIX || 'jitr';
let   io     = null;   // Socket.IO instance, set after server init

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
function sysidFrom(payload) {
  const { sys_name, sys_num } = payload;
  if (sys_name) return String(sys_name).toUpperCase();
  if (sys_num != null) return `SYS${sys_num}`;
  return null;
}

// ── trunk-recorder MQTT message handlers ─────────────────────────────────────

async function handleCallStart(payload) {
  // tr-plugin-mqtt wraps the call in a nested `call` object with a type/timestamp envelope
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
    unit,
    freq,
    freq_label: mhz(freq),
    emergency: !!emergency,
    encrypted: !!encrypted,
    phase,
    start_time: new Date().toISOString(),
  });
  console.log(`[call:start] ${sid} TG${talkgroup} (${talkgroup_alpha_tag || '?'}) ${mhz(freq)}`);
}

async function handleCallEnd(payload) {
  const call = payload.call || payload;
  const { talkgroup, freq, length, call_filename } = call;
  const sid = sysidFrom(call);
  if (!sid) return;

  const { rows } = await query(`
    INSERT INTO calls(sysid, tgid, freq, duration, audio_file)
    SELECT sysid, tgid, freq, $3, $4
    FROM   active_calls
    WHERE  sysid = $1 AND tgid = $2
    ORDER  BY start_time DESC
    LIMIT  1
    RETURNING id
  `, [sid, talkgroup, length || null, call_filename || null]);

  await query(
    `DELETE FROM active_calls WHERE sysid=$1 AND tgid=$2`,
    [sid, talkgroup]
  );

  emit('call:end', {
    sysid: sid,
    tgid: talkgroup,
    freq,
    duration: length,
    call_id: rows[0]?.id,
    has_audio: !!call_filename,
  });
}

async function handleRates(payload) {
  // tr-plugin-mqtt rates message — control-channel decode telemetry
  emit('rates', payload);
}

// ── Topic router ──────────────────────────────────────────────────────────────
//
// tr-plugin-mqtt publishes to `<topic>/<event>` where <event> is one of
// call_start, call_end, rates, calls_active, recorder, recorders, config,
// systems, system. We only consume the first three; others are silently
// ignored (fine — they're just retained state we don't use yet).

async function dispatch(topic, raw) {
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const sub = topic.startsWith(`${PREFIX}/`) ? topic.slice(PREFIX.length + 1) : topic;

  try {
    if      (sub === 'call_start')  await handleCallStart(payload);
    else if (sub === 'call_end')    await handleCallEnd(payload);
    else if (sub === 'rates')       await handleRates(payload);
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
