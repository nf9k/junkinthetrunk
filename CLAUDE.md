# Junk in the Trunk — Project Memory

## What this is
Docker/Podman stack for APCO P25 trunked radio monitoring via RTL-SDR.
Personal homelab project, not on code.roche.com.

## Stack
- trunk-recorder (ghcr.io/robotastic/trunk-recorder) — P25 decode + voice follow
- mosquitto:2 — internal MQTT broker, topic prefix: `jitr`
- postgres:16-alpine — sysid-keyed schema, `upsert_system()` PG function
- Node.js API (Express + Socket.IO) — MQTT subscriber, REST, WebSocket
- React + Vite + Nginx frontend — amber/dark tactical ops aesthetic

## Key conventions
- compose.yml (not docker-compose.yml, not compose.yaml)
- No npm workspaces — api/ and frontend/ are independent packages
- MQTT prefix is `jitr` — must match MQTT_TOPIC_PREFIX in compose.yml and trunk-recorder.json
- sysid is always uppercase hex (e.g. "1B6"), normalized in mqtt.js
- WebSocket events: `active:snapshot`, `call:start`, `call:end`, `rates`
- DB: PostgreSQL user/db both named `jitr`

## File layout
- compose.yml — all 5 services, named volumes
- config/trunk-recorder.json — decoder config (edit sysId + device serials here)
- config/talkgroups/*.csv — one CSV per system, RadioReference format
- config/mosquitto.conf
- db/init.sql — full schema + upsert_system() function
- api/src/index.js — Express + Socket.IO + 60s stats refresh + stale active call cleanup
- api/src/mqtt.js — trunk-recorder event handler (handleCallStart/End/Rates)
- api/src/import.js — talkgroup CSV auto-import on startup (<sysid>.csv convention)
- api/src/routes/ — systems.js, calls.js, talkgroups.js, units.js
- frontend/src/App.jsx — all UI (Dashboard, Call Log, Talkgroups, Units)
- frontend/src/styles/global.css — CSS variables + all component classes
- jitt-host-setup.sh — run once as root on host (DVB blacklist, udev, rtl_test)

## What's not done yet
- ntfy push alerts on emergency calls
- Audio playback waveform in UI
- Live RadioReference SOAP API import (blocked on RR appKey request)
- Phase 2 (TDMA) multi-site handling
