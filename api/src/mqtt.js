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

// ── trunk-recorder MQTT message handlers ─────────────────────────────────────

async function handleCallStart(payload) {
  const {
    sys_name, sys_num, sysid, wacn, nac,
    talkgroup, talkgroup_alpha_tag, talkgroup_group,
    unit, freq, emergency, encrypted, phase
  } = payload;

  const sid = sysid ? String(sysid).toUpperCase() : `SYS${sys_num}`;

  // Ensure system row exists
  await query(
    `SELECT upsert_system($1, $2, $3, $4)`,
    [sid, sys_name || sid, wacn ? String(wacn).toUpperCase() : null, nac || null]
  );

  // Upsert talkgroup
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

  // Insert active call
  const { rows } = await query(`
    INSERT INTO active_calls(sysid, tgid, alpha_tag, group_tag, source_unit, freq, emergency, encrypted, phase)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id
  `, [sid, talkgroup, talkgroup_alpha_tag || null, talkgroup_group || null,
      unit || null, freq || null, !!emergency, !!encrypted, phase || 1]);

  const activeId = rows[0].id;

  const event = {
    id: activeId,
    sysid: sid,
    tgid: talkgroup,
    alpha_tag: talkgroup_alpha_tag,
    group_tag: talkgroup_group,
    unit,
    freq,
    freq_label: mhz(freq),
    emergency: !!emergency,
    encrypted: !!encrypted,
    phase: phase || 1,
    start_time: new Date().toISOString(),
  };

  emit('call:start', event);
  console.log(`[call:start] ${sid} TG${talkgroup} (${talkgroup_alpha_tag || '?'}) ${mhz(freq)}`);
}

async function handleCallEnd(payload) {
  const { sysid, sys_num, talkgroup, freq, length, audio_type, filename } = payload;
  const sid = sysid ? String(sysid).toUpperCase() : `SYS${sys_num}`;

  // Write to permanent calls table
  const { rows } = await query(`
    INSERT INTO calls(sysid, tgid, freq, duration, audio_file)
    SELECT sysid, tgid, freq, $3, $4
    FROM   active_calls
    WHERE  sysid = $1 AND tgid = $2
    ORDER  BY start_time DESC
    LIMIT  1
    RETURNING id
  `, [sid, talkgroup, length || null, filename || null]);

  // Remove from active
  await query(
    `DELETE FROM active_calls WHERE sysid=$1 AND tgid=$2`,
    [sid, talkgroup]
  );

  const event = {
    sysid: sid,
    tgid: talkgroup,
    freq,
    duration: length,
    call_id: rows[0]?.id,
    has_audio: !!filename,
  };

  emit('call:end', event);
}

async function handleRates(payload) {
  // trunk-recorder rates message — system health / signal stats
  emit('rates', payload);
}

// ── Topic router ──────────────────────────────────────────────────────────────

async function dispatch(topic, raw) {
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    return; // non-JSON message, ignore
  }

  // trunk-recorder topics under our prefix:
  //   jitr/calls/start   jitr/calls/end   jitr/rates   jitr/audio
  const sub = topic.replace(`${PREFIX}/`, '');

  try {
    if      (sub === 'calls/start') await handleCallStart(payload);
    else if (sub === 'calls/end')   await handleCallEnd(payload);
    else if (sub === 'rates')       await handleRates(payload);
    // audio chunks: ignored — audio is served from file volume
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
