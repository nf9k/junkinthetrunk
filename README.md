# Junk in the Trunk

Docker/Podman-based APCO P25 trunked radio monitor.

Decodes P25 Phase 1 & 2 control channels via RTL-SDR, stores call records in PostgreSQL, and streams live activity to a React web UI over WebSocket.

Full operator guide: [`docs/user-manual.md`](docs/user-manual.md) ([PDF](docs/user-manual.pdf))

## Stack

| Service | Image / Source | Role |
|---|---|---|
| `trunk-recorder` | `./decoder` (debian:trixie multi-stage) | P25 decode, voice follow, audio recording — built locally to bundle the `libmqtt_status_plugin.so` from [TrunkRecorder/tr-plugin-mqtt](https://github.com/TrunkRecorder/tr-plugin-mqtt), which isn't in upstream robotastic/trunk-recorder |
| `mosquitto` | `eclipse-mosquitto:2` | Internal MQTT event bus |
| `postgres` | `postgres:16-alpine` | Persistent storage — sysid-keyed schema |
| `api` | `./api` (Node.js) | MQTT subscriber, REST API, WebSocket |
| `frontend` | `./frontend` (React + Nginx) | Web UI — nginx internally proxies `/api` and `/socket.io` to the api container |

## Prerequisites

- 1+ RTL-SDR dongles (RTL2838/RTL2832U)
- Docker Compose v2 **or** Podman + podman-compose
- Linux host (for USB passthrough); WSL2 with usbipd also works

## First-Time Setup

```bash
git clone https://github.com/nf9k/junkinthetrunk.git && cd junkinthetrunk

# 1. Host prep (root) — DVB blacklist, udev rules, dongle enumeration
sudo ./jitt-host-setup.sh

# 2. Set dongle serials (do once per dongle, survives reboots).
#    One-dongle setups can skip this — use "rtl=0" (USB index) in the
#    decoder config instead of "rtl=serial:TRUNK0".
rtl_eeprom -d 0 -s TRUNK0
rtl_eeprom -d 1 -s TRUNK1

# 3. Edit .env
cp .env.example .env
$EDITOR .env   # set DB_PASSWORD

# 4. Configure decoder — set shortName (= hex sysid, "262" for MESA),
#    sysId (decimal, trunk-recorder v5 requires a number), and
#    control_channels array.
$EDITOR config/trunk-recorder.json

# 5. Drop RadioReference exports into config/talkgroups/ named by sysid:
#      <sysid>.csv        — talkgroups (classic or trs_tg_NNNN.csv)
#      <sysid>.sites.csv  — sites (trs_sites_NNNN.csv)
cp ~/Downloads/trs_tg_5737.csv    config/talkgroups/262.csv
cp ~/Downloads/trs_sites_5737.csv config/talkgroups/262.sites.csv

# 6. Launch
docker compose up -d      # or: podman compose up -d
```

Web UI: **http://localhost:8080** (nginx proxies `/api` and `/socket.io` to the api container — no need to expose the api port).

The first `docker compose up` triggers a local trunk-recorder build (~20 min on modest hardware). Subsequent starts just pull from the named image.

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

## UI

Five tabs, amber-on-dark tactical-ops aesthetic, day/night theme toggle in the nav (persists in `localStorage`):

| Tab | Shows |
|---|---|
| **Dashboard** | Active calls + stat row (active/emergencies/calls per hour/day + 24 h sparkline) + recent call log |
| **Call Log** | All completed calls for the current system, with audio playback when available |
| **Talkgroups** | All imported talkgroups with call counts and last-active time |
| **Units** | Observed radios and their most-recent TGs — requires the plugin's `unit_topic` (enabled by default in our config) |
| **Site Info** | System-level panel (WACN / NAC / RFSS / current site / live CC + decode rate / squelch), SDR source cards, live recorder table, and per-RFSS site cards with NAC / county / lat-lon / coverage range / control + voice frequency chips. Current site gets a `DECODING` badge. |

The `<sys-bar>` under the nav switches between all P25 systems the API has seen — useful for flipping between MESA and SAFE-T.

## MQTT Topic Structure

The decoder's MQTT plugin (`libmqtt_status_plugin.so`) publishes under the `jitr` prefix (set via `MQTT_TOPIC_PREFIX` in `compose.yml` / `trunk-recorder.json`):

| Topic | Direction | Notes |
|---|---|---|
| `jitr/call_start`   | decoder → api | New voice grant |
| `jitr/call_end`     | decoder → api | Call finalized — only fires when the audio recording ran to completion |
| `jitr/calls_active` | decoder → api | Snapshot of all active calls; published once a second. API also uses this to *synthesize* `call_end` for calls whose voice freq was out of the SDR window (so the Call Log populates even without audio capture). |
| `jitr/rates`        | decoder → api | Decode rate per control channel, every ~3 s. Persists into `system_stats.current_control_freq` / `current_decode_rate`. |
| `jitr/systems`      | decoder → api | Retained. Fills WACN / NAC / RFSS / current site on the systems row once the decoder hears a network status TSBK. |
| `jitr/config`       | decoder → api | Retained. Source SDR windows + squelch. |
| `jitr/recorders`    | decoder → api | Every-3 s snapshot of recorder states. |
| `jitr/units/<shortname>/<event>` | decoder → api | Unit activity — `call`, `on`, `off`, `join`. |

The trunk-recorder `shortName` **must equal the hex sysid** (e.g. `"262"` for MESA) — the plugin doesn't carry a sysid field in per-call messages, so we derive our DB key from `sys_name`.

## WebSocket Events

| Event | Description |
|---|---|
| `active:snapshot` | Full active call list (sent on connect) |
| `call:start` | New call — `{ id, sysid, tgid, alpha_tag, group_tag, unit, freq, emergency, encrypted, phase, start_time }` |
| `call:end` | Call ended — `{ sysid, tgid, duration, call_id, has_audio }` |
| `rates` | Decode telemetry pass-through |

## REST API

```
GET  /api/systems                             — list of systems + live stats
GET  /api/systems/:sysid                      — full detail: WACN/NAC/RFSS,
                                                current CC + decode rate,
                                                sdr_sources_json, recorders_json,
                                                and the sites[] array
GET  /api/systems/:sysid/active               — currently-active calls
GET  /api/systems/:sysid/stats?hours=24       — hourly call counts for sparkline
GET  /api/calls?sysid=&tgid=&unit=&emergency=&encrypted=&limit=&offset=&since=
GET  /api/calls/:id/audio                     — WAV/M4A download
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
├── decoder/
│   └── Dockerfile                ← debian:trixie multi-stage; builds
│                                    trunk-recorder + tr-plugin-mqtt
├── config/
│   ├── trunk-recorder.json       ← committed 2-dongle MESA config
│   ├── mosquitto.conf
│   └── talkgroups/
│       ├── README.md             ← filename conventions
│       ├── example.csv           ← placeholder (real RR exports are gitignored)
│       ├── example.sites.csv
│       ├── 262.csv               ← <sysid>.csv — auto-imported on API startup
│       └── 262.sites.csv         ← <sysid>.sites.csv — sites + frequencies
├── db/
│   └── init.sql                  ← full schema + upsert_system() function
├── api/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js              ← Express + Socket.IO + stats refresh
│       ├── mqtt.js               ← plugin subscriber; handlers for call_*,
│       │                           calls_active (call-end synthesis),
│       │                           systems, config, rates, recorders, units
│       ├── import.js             ← talkgroup CSV auto-import (startup)
│       ├── db.js                 ← pg pool
│       └── routes/
│           ├── systems.js        ← /api/systems + detail + active + stats
│           ├── calls.js
│           ├── talkgroups.js
│           └── units.js
└── frontend/
    ├── Dockerfile
    ├── nginx.conf                ← proxies /api and /socket.io to api container
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx               ← UI: Dashboard, Call Log, Talkgroups,
        │                           Units, Site Info + day/night toggle
        └── styles/
            └── global.css        ← amber/dark theme + day mode override
```
