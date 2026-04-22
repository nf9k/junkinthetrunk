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
git clone https://github.com/nf9k/junkinthetrunk.git && cd junkinthetrunk

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

# 5. Drop RadioReference exports into config/talkgroups/ named by sysid:
#      <sysid>.csv        — talkgroups (classic or trs_tg_NNNN.csv)
#      <sysid>.sites.csv  — sites (trs_sites_NNNN.csv)
cp ~/Downloads/trs_tg_5737.csv    config/talkgroups/262.csv
cp ~/Downloads/trs_sites_5737.csv config/talkgroups/262.sites.csv

# 6. Launch
docker compose up -d      # or: podman compose up -d
```

Web UI: **http://localhost:8080**
API: **http://localhost:3000/api**

## Talkgroup & Site Import

CSVs in `config/talkgroups/` are auto-imported every time the API
container starts. The filename determines what they are and which
P25 system they belong to:

| Pattern | Ingested as | Example |
|---|---|---|
| `<sysid>.csv` | Talkgroups | `262.csv` (MESA), `6BD.csv` (SAFE-T) |
| `<sysid>.sites.csv` | Sites + frequencies | `262.sites.csv` |

The filename `<sysid>` is upper-cased and used as the P25 system ID;
anything else in the directory is logged and skipped. Two RadioReference
export shapes are supported for talkgroups:

- **Classic** (per-system export): `Decimal, Alpha Tag, Description, Tag, Group, Mode, Encrypted`
- **TRS** (`trs_tg_NNNN.csv` dumps): `Decimal, Hex, Alpha Tag, Mode, Description, Tag, Category`

Both are auto-detected. For TRS exports, encryption is inferred from
`Mode` (`D` = clear, `De` or `DE` = encrypted).

Sites come from RR's `trs_sites_NNNN.csv` dump — all fixed columns plus
a variable-length `Frequencies` tail. Control channels (trailing `c`
suffix) and voice channels are split into `control_freqs[]` and
`voice_freqs[]` in the `sites` table.

Imports are idempotent (upsert on `(sysid, tgid)` for talkgroups,
`(sysid, rfss_id, site_id)` for sites), so the refresh flow is:

```bash
# RadioReference → Premium Subscriber → Database → Trunked System → Export
cp ~/Downloads/trs_tg_5737.csv    config/talkgroups/262.csv
cp ~/Downloads/trs_sites_5737.csv config/talkgroups/262.sites.csv
docker compose restart api
```

`POST /api/talkgroups/import` remains available for ad-hoc JSON imports.

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
junkinthetrunk/
├── compose.yml
├── .env.example
├── jitt-host-setup.sh
├── config/
│   ├── trunk-recorder.json       ← edit: sysId, frequencies, dongle serials
│   ├── mosquitto.conf
│   └── talkgroups/
│       ├── 262.csv               ← <sysid>.csv — auto-imported on API startup
│       └── 262.sites.csv         ← <sysid>.sites.csv — sites + frequencies
├── db/
│   └── init.sql                  ← full schema + upsert_system() function
├── api/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js              ← Express + Socket.IO + stats refresh
│       ├── mqtt.js               ← trunk-recorder event subscriber
│       ├── import.js             ← talkgroup CSV auto-import (startup)
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
