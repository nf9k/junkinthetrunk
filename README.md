# Junk in the Trunk

Docker/Podman-based APCO P25 trunked radio monitor.

Decodes P25 Phase 1 & 2 control channels via RTL-SDR, stores call records in PostgreSQL, and streams live activity to a React web UI over WebSocket.

## Stack

| Service | Image / Source | Role |
|---|---|---|
| `trunk-recorder` | `ghcr.io/robotastic/trunk-recorder` | P25 decode, voice follow, audio recording |
| `mosquitto` | `eclipse-mosquitto:2` | Internal MQTT event bus |
| `postgres` | `postgres:16-alpine` | Persistent storage — sysid-keyed schema |
| `api` | `./api` (Node.js) | MQTT subscriber, REST API, WebSocket |
| `frontend` | `./frontend` (React + Nginx) | Web UI |

## Prerequisites

- 1+ RTL-SDR dongles (RTL2838/RTL2832U)
- Docker Compose v2 **or** Podman + podman-compose
- Linux host (for USB passthrough); WSL2 with usbipd also works

## First-Time Setup

```bash
git clone <repo> && cd junk-in-the-trunk

# 1. Host prep (root) — DVB blacklist, udev rules, dongle enumeration
sudo ./jitt-host-setup.sh

# 2. Set dongle serials (do once per dongle, survives reboots)
rtl_eeprom -d 0 -s TRUNK0
rtl_eeprom -d 1 -s TRUNK1

# 3. Edit .env
cp .env.example .env
$EDITOR .env   # set DB_PASSWORD

# 4. Configure decoder
$EDITOR config/trunk-recorder.json   # set sysId, control_channel_list

# 5. Drop RadioReference talkgroup CSV into config/talkgroups/
#    RadioReference → Database → <your system> → Export → Talkgroups
cp ~/Downloads/your-system-talkgroups.csv config/talkgroups/

# 6. Launch
docker compose up -d      # or: podman compose up -d
```

Web UI: **http://localhost:8080**
API: **http://localhost:3000/api**

## Talkgroup Import

After startup, import a talkgroup CSV via the API:

```bash
# Parse RadioReference CSV export and post as JSON
python3 - <<'EOF'
import csv, json, requests, sys

SYSID = "1B6"   # your system ID in hex
CSV   = "config/talkgroups/hamilton-co.csv"

tgs = []
with open(CSV) as f:
    for row in csv.DictReader(f):
        tgs.append({
            "tgid":        int(row["Decimal"]),
            "alpha_tag":   row["Alpha Tag"],
            "description": row["Description"],
            "group_tag":   row["Group"],
            "encrypted":   row["Encrypted"] == "1",
        })

r = requests.post(f"http://localhost:3000/api/talkgroups/import",
                  json={"sysid": SYSID, "rows": tgs})
print(r.json())
EOF
```

## MQTT Topic Structure

trunk-recorder publishes under the `jitr` prefix (set via `MQTT_TOPIC_PREFIX`):

| Topic | Event |
|---|---|
| `jitr/calls/start` | Voice channel granted |
| `jitr/calls/end`   | Call complete, duration + audio filename |
| `jitr/rates`       | Decode rate / signal telemetry |

## WebSocket Events

| Event | Description |
|---|---|
| `active:snapshot` | Full active call list (sent on connect) |
| `call:start` | New call — `{ id, sysid, tgid, alpha_tag, group_tag, unit, freq, emergency, encrypted, phase, start_time }` |
| `call:end` | Call ended — `{ sysid, tgid, duration, call_id, has_audio }` |
| `rates` | Decode telemetry pass-through |

## REST API

```
GET  /api/systems
GET  /api/systems/:sysid
GET  /api/systems/:sysid/active
GET  /api/systems/:sysid/stats?hours=24
GET  /api/calls?sysid=&tgid=&unit=&emergency=&encrypted=&limit=&offset=&since=
GET  /api/calls/:id/audio
GET  /api/talkgroups?sysid=&group_tag=&search=&limit=&offset=
POST /api/talkgroups/import    { sysid, rows: [{tgid, alpha_tag, ...}] }
GET  /api/units?sysid=&limit=
GET  /api/health
```

## Podman Notes

USB passthrough requires rootful Podman for the `trunk-recorder` container.
The remaining services can run rootless, but a single rootful compose stack is simpler for this use case.

## Directory Layout

```
junk-in-the-trunk/
├── compose.yml
├── .env.example
├── jitt-host-setup.sh
├── config/
│   ├── trunk-recorder.json       ← edit: sysId, frequencies, dongle serials
│   ├── mosquitto.conf
│   └── talkgroups/
│       └── hamilton-co.csv       ← replace with RadioReference export(s)
├── db/
│   └── init.sql                  ← full schema + upsert_system() function
├── api/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js              ← Express + Socket.IO + stats refresh
│       ├── mqtt.js               ← trunk-recorder event subscriber
│       ├── db.js                 ← pg pool
│       └── routes/
│           ├── systems.js
│           ├── calls.js
│           ├── talkgroups.js
│           └── units.js
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx               ← full UI: Dashboard, Call Log, Talkgroups, Units
        └── styles/
            └── global.css        ← amber / dark tactical ops aesthetic
```
