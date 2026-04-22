# Junk in the Trunk — Project Memory

## What this is
Docker/Podman stack for APCO P25 trunked radio monitoring via RTL-SDR.
Personal homelab project, not on code.roche.com.

## Stack
- trunk-recorder (built locally from `./decoder/Dockerfile`, image tag `jitr-trunk-recorder:local`) — P25 decode + voice follow, with the `tr-plugin-mqtt` status plugin compiled in AND `patches/arc4-decrypt.patch` applied (enables ARC4/ADP decryption, which upstream disables). `decoder/entrypoint.sh` merges `config/keys.json` into the runtime config via `jq`. The stock `ghcr.io/robotastic/trunk-recorder` image does NOT ship the MQTT plugin; it's from `github.com/TrunkRecorder/tr-plugin-mqtt` (produces `libmqtt_status_plugin.so`).
- mosquitto:2 — internal MQTT broker, topic prefix: `jitr`
- postgres:16-alpine — sysid-keyed schema, `upsert_system()` PG function
- Node.js API (Express + Socket.IO) — MQTT subscriber, REST, WebSocket
- React + Vite + Nginx frontend — amber/dark tactical ops aesthetic

## Key conventions
- compose.yml (not docker-compose.yml, not compose.yaml)
- No npm workspaces — api/ and frontend/ are independent packages
- MQTT prefix is `jitr` — must match MQTT_TOPIC_PREFIX in compose.yml and trunk-recorder.json
- sysid is always uppercase hex (e.g. "262" for MESA, "6BD" for SAFE-T), normalized in mqtt.js
- trunk-recorder `shortName` in config must equal the hex sysid — the plugin emits `sys_name` (not sysid); we uppercase `sys_name` → DB key
- trunk-recorder `sysId` in config is decimal (v5+), not the hex string: `0x262 = 610`, `0x6BD = 1725`
- MQTT topics from tr-plugin-mqtt: `jitr/call_start`, `jitr/call_end`, `jitr/rates` (underscored, not slash-subpathed)
- WebSocket events: `active:snapshot`, `call:start`, `call:end`, `rates`
- DB: PostgreSQL user/db both named `jitr`
- Talkgroup CSVs: `<sysid>.csv`; site CSVs: `<sysid>.sites.csv` — both auto-imported on API start
- `sites` table is UNIQUE(sysid, rfss_id, site_id) — RFSS matters (SAFE-T has 2 RFSSes sharing site ids)

## File layout
- compose.yml — all 5 services, named volumes; build context is project root (not ./decoder) so Dockerfile can reach patches/
- decoder/Dockerfile — custom trunk-recorder build (upstream + tr-plugin-mqtt + arc4-decrypt.patch); context must be project root
- decoder/entrypoint.sh — merges config/keys.json into /tmp/config.json at startup via jq
- patches/arc4-decrypt.patch — enables ARC4/ADP decrypt in trunk-recorder (do_nocrypt 1→0, key loading, call_concluder fix, fdma vocoder fix)
- config/trunk-recorder.json — committed decoder config (3-dongle MESA setup: TRUNK0/1/2)
- config/trunk-recorder.sys1.json — alternate config for sys1 (Marion Co. PS, shortName 10A)
- config/keys.example.json — ARC4 key format template (keys.json is gitignored, holds real key)
- config/trunk-recorder.local.json — gitignored single-dongle variant for smoke tests
- config/talkgroups/*.csv — one CSV per system, RadioReference format
- config/mosquitto.conf
- db/init.sql — full schema + upsert_system() function
- api/src/index.js — Express + Socket.IO + 60s stats refresh + stale active call cleanup
- api/src/mqtt.js — trunk-recorder event handler (handleCallStart/End/Rates)
- api/src/import.js — talkgroup CSV auto-import on startup (<sysid>.csv convention)
- api/src/routes/ — systems.js, calls.js, talkgroups.js, units.js
- frontend/src/App.jsx — all UI (Dashboard, Call Log, Talkgroups, Units, Site Info) + day/night toggle
- frontend/src/styles/global.css — CSS variables + day-mode override + all component classes
- jitt-host-setup.sh — run once as root on host (DVB blacklist, udev, rtl_test)
- decoder/Dockerfile — debian:trixie multi-stage build of trunk-recorder + tr-plugin-mqtt

## Versioning
- Images: `jitr-trunk-recorder`, `jitr-api`, `jitr-frontend` — tagged `:local` for dev, `:<version>` + `:latest` for release
- `make release` builds all three and tags them; version is set in Makefile (v1.00, increment by .01 per release)

## What's not done yet
- ntfy push alerts on emergency calls
- Audio playback waveform in UI
- Live RadioReference SOAP API import (blocked on RR appKey request)
- Phase 2 (TDMA) multi-site handling
- Bandpass filter for TRUNK1 (851–854 MHz) — LTE interference causes high BER on that dongle; calls landing there are audible but degraded
