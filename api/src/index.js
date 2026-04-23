'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const mqtt       = require('./mqtt');
const { query }  = require('./db');
const { importTalkgroupsFromDisk } = require('./import');

const AUDIO_ROOT = process.env.AUDIO_PATH || '/audio';

const PORT = parseInt(process.env.PORT || '3000', 10);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/systems',    require('./routes/systems'));
app.use('/api/calls',      require('./routes/calls'));
app.use('/api/talkgroups', require('./routes/talkgroups'));
app.use('/api/units',      require('./routes/units'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[ws] client connected: ${socket.id}`);

  // Send current active calls on join
  query(`SELECT * FROM active_calls ORDER BY start_time ASC`)
    .then(({ rows }) => socket.emit('active:snapshot', rows))
    .catch(() => {});

  socket.on('disconnect', () => {
    console.log(`[ws] client disconnected: ${socket.id}`);
  });
});

// ── Periodic system stats refresh (every 60s) ─────────────────────────────────

async function refreshStats() {
  try {
    await query(`
      UPDATE system_stats ss
      SET
        calls_today = (
          SELECT COUNT(*) FROM calls c
          WHERE c.sysid = ss.sysid
            AND c.start_time >= date_trunc('day', now() AT TIME ZONE 'UTC')
        ),
        calls_hour = (
          SELECT COUNT(*) FROM calls c
          WHERE c.sysid = ss.sysid
            AND c.start_time >= now() - INTERVAL '1 hour'
        ),
        active_tgs = (
          SELECT COUNT(DISTINCT tgid) FROM active_calls a
          WHERE a.sysid = ss.sysid
        ),
        updated_at = now()
    `);
  } catch (err) {
    console.error('[stats] refresh error:', err.message);
  }
}

setInterval(refreshStats, 60_000);

// Stale active call cleanup — remove calls older than 5 min with no end event
async function cleanStaleActive() {
  try {
    const { rowCount } = await query(
      `DELETE FROM active_calls WHERE start_time < now() - INTERVAL '5 minutes'`
    );
    if (rowCount > 0) {
      console.log(`[cleanup] removed ${rowCount} stale active call(s)`);
      io.emit('active:snapshot', (await query(`SELECT * FROM active_calls ORDER BY start_time ASC`)).rows);
    }
  } catch (err) {
    console.error('[cleanup] error:', err.message);
  }
}

setInterval(cleanStaleActive, 60_000);

// ── Audio file backfill ───────────────────────────────────────────────────────
// tr-plugin-mqtt doesn't reliably emit call_end, so audio_file is often null.
// Scan the audio volume, parse filenames ({tgid}-{ts}_{freq}-call_{n}.m4a),
// and link each file to the matching call row.

const SYNC_MAX_AGE_MS = 120_000; // only consider files written in last 2 minutes

function walkM4a(dir, base) {
  const out = [];
  const cutoff = Date.now() - SYNC_MAX_AGE_MS;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip entire date directories that are too old
      try { if (fs.statSync(full).mtimeMs < cutoff) continue; } catch { continue; }
      out.push(...walkM4a(full, base));
    } else if (e.name.endsWith('.m4a')) {
      try { if (fs.statSync(full).mtimeMs >= cutoff) out.push({ full, rel: path.relative(base, full), name: e.name }); } catch {}
    }
  }
  return out;
}

async function syncAudioFiles() {
  try {
    const files = walkM4a(AUDIO_ROOT, AUDIO_ROOT);
    let linked = 0;
    const newAudio = [];
    for (const { rel, name } of files) {
      const m = name.match(/^(\d+)-(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)-call_\d+\.m4a$/);
      if (!m) continue;
      const tgid   = parseInt(m[1], 10);
      const unixTs = parseFloat(m[2]);
      const freq   = Math.round(parseFloat(m[3]));
      const { rows, rowCount } = await query(`
        UPDATE calls SET audio_file = $1
        WHERE id = (
          SELECT id FROM calls
          WHERE tgid = $2 AND freq = $3 AND audio_file IS NULL
            AND ABS(EXTRACT(EPOCH FROM start_time) - $4) < 10
          ORDER BY ABS(EXTRACT(EPOCH FROM start_time) - $4)
          LIMIT 1
        )
        RETURNING id, sysid, tgid
      `, [rel, tgid, freq, unixTs]);
      if (rowCount > 0) { linked++; newAudio.push(rows[0]); }
    }
    if (linked > 0) {
      io.emit('calls:updated');
      for (const { id, sysid, tgid } of newAudio)
        io.emit('call:audio', { call_id: id, sysid, tgid });
    }
  } catch (err) {
    console.error('[audioSync] error:', err.message);
  }
}

setInterval(syncAudioFiles, 10_000);

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`[api] Junk in the Trunk API listening on :${PORT}`);
  await importTalkgroupsFromDisk();
  mqtt.connect(io);
  refreshStats();
});
