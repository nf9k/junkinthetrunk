'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const mqtt       = require('./mqtt');
const { query }  = require('./db');
const { importTalkgroupsFromDisk } = require('./import');

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

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`[api] Junk in the Trunk API listening on :${PORT}`);
  await importTalkgroupsFromDisk();
  mqtt.connect(io);
  refreshStats();
});
