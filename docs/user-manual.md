---
title: "Junk in the Trunk — User Manual"
subtitle: "Docker-based APCO P25 trunked radio monitor"
author: "github.com/nf9k/junkinthetrunk"
date: "\\today"
toc: true
toc-depth: 3
numbersections: true
geometry: margin=0.9in
fontsize: 10pt
colorlinks: true
linkcolor: black
urlcolor: NavyBlue
documentclass: article
---

\newpage

# Introduction

**Junk in the Trunk** is a self-hosted Docker stack that decodes APCO Project 25 (P25) trunked radio traffic using RTL-SDR dongles, stores call records in PostgreSQL, and streams live activity to a web UI. It's intended for hobby radio monitoring of public-safety systems in areas where reception is legal and the traffic of interest is clear or is usefully observed in metadata only (encrypted calls still produce talkgroup / unit / frequency data).

The stack consists of five services:

- **trunk-recorder** — the P25 decoder (built locally from source with the MQTT status plugin compiled in).
- **mosquitto** — the MQTT broker that carries events between the decoder and the API.
- **postgres** — persistent storage, keyed by P25 System ID (sysid, hex).
- **api** — Node.js service: MQTT subscriber, REST endpoint, Socket.IO live feed.
- **frontend** — React/Vite UI served by nginx, which also proxies `/api` and `/socket.io`.

## Concepts and terminology

A P25 trunked system is a network of radios that shares a small pool of RF channels among many users. One channel at a time serves as the **control channel (CC)**; it carries short messages (TSBK — Trunk System Broadcast Keyword) that grant voice channels, update unit registrations, broadcast network status, etc. The remaining channels are **voice channels**, assigned on demand.

| Term | Meaning |
|---|---|
| **sysid** | 12-bit P25 System ID, typically displayed as 3 hex digits. Example: MESA = `262`, Indiana SAFE-T/IPSC = `6BD`. Primary key throughout the stack. |
| **WACN** | Wide-Area Communications Network ID, 20-bit hex. Identifies the parent network; MESA and SAFE-T both operate under WACN `BEE00`. |
| **NAC** | Network Access Code, 12-bit hex. A coarse filter at the radio level — analogous to a CTCSS tone on an analog system. |
| **RFSS** | Radio Frequency Subsystem ID. A logical grouping of sites under a sysid. SAFE-T runs two RFSSes; MESA has one. |
| **Site** | A physical transmitter location. Simulcast sites broadcast the same content from multiple towers in a county. Each site has its own site ID and NAC. |
| **Talkgroup (TG)** | Logical voice group. Decimal and hex notations are both common; we store both. `tgid` field throughout. |
| **Unit** | Individual radio. Each radio has a unit ID (decimal). Encrypted calls hide the source unit. |
| **Phase 1 / Phase 2** | P25 Phase 1 is FDMA (one voice stream per 12.5 kHz channel). Phase 2 is TDMA (two voice streams per 12.5 kHz channel). We record both. |

## What this is *not*

- Not a broadcast-audio streamer. There's a built-in audio player for recorded calls, but no live-listen path (by design — simpler, lower load).
- Not an OpenMHz / Broadcastify uploader. Those plugins are bundled in the decoder image but disabled by default; configure `trunk-recorder.json` manually if you want them.
- Not a decryptor. P25 AES/DES encryption is intact; you see the metadata and nothing more for encrypted calls.

\newpage

# Hardware setup

## RTL-SDR dongles

Any RTL2832U-based dongle with the Rafael Micro R820T or R820T2 tuner works. An R820T covers roughly 24 MHz to 1.7 GHz — more than enough for U.S. 800 MHz trunked systems and UHF/VHF public safety. For marginal signals, the V3-style dongles with a TCXO (temperature-compensated crystal) drift less and are worth the few extra dollars.

**How many dongles do I need?** Rule of thumb:

- **1 dongle** captures the control channel and records voice calls whose voice frequency falls inside its sample window (typically 2.4–3.2 MHz wide). For a multi-site system with voice channels spread across 8+ MHz (MESA Hamilton Co. has voice on 851–859 MHz), one dongle records only a fraction of voice traffic — but you get *all* the metadata.
- **2 dongles** split the work: one tuned to cover the control channels, one tuned to cover the voice range. Typical hobby setup.
- **3+ dongles** for multi-site recording or systems that span a wider voice band.

## Host prep

Run once as root on a fresh LMDE / Debian / Ubuntu host:

```bash
sudo ./jitt-host-setup.sh
```

The script:

1. Blacklists the in-kernel DVB-T drivers (`dvb_usb_rtl28xxu`, `rtl2832`, `rtl2830`) so RTL-SDR userspace can grab the device.
2. Installs a udev rule granting the `plugdev` group access to USB devices with vendor `0bda` product `2838`.
3. Runs `rtl_test -t` on every dongle it can find, so you can verify each one responds.

Reboot after running it, or `sudo modprobe -r dvb_usb_rtl28xxu rtl2832` and re-plug the dongles.

## Flashing dongle serials (optional but recommended)

Factory dongles all report serial `00000001`, which becomes ambiguous with more than one dongle. Burn a unique serial once per dongle; the EEPROM value survives reboots and hardware moves:

```bash
sudo rtl_eeprom -d 0 -s TRUNK0      # unplug/replug after
sudo rtl_eeprom -d 1 -s TRUNK1
```

Then the decoder config can reference them by name (stable across USB port changes):

```json
{ "device": "rtl=serial:TRUNK0" }
```

For a one-dongle setup you can skip the flashing step and use the USB index:

```json
{ "device": "rtl=0" }
```

## Gain, squelch, and sample rate tips

- Start with `"gain": 40`. If the log says *"Requested Gain of 40 not supported, driver using: 40.2"*, that's just the driver snapping to the nearest supported step — harmless.
- `"squelch": -60` is a reasonable default for RF-quiet locations. Noisier environments may need -50 to -40.
- `"rate": 2400000` is safe; `2880000` adds roughly 0.4 MHz of usable bandwidth at the cost of occasional USB buffer underruns on weaker hosts. `3200000` is the dongle's practical max and only works on some V3-grade hardware.

\newpage

# First-time install

```bash
git clone https://github.com/nf9k/junkinthetrunk.git
cd junkinthetrunk

sudo ./jitt-host-setup.sh          # blacklist DVB, udev rules, dongle test
cp .env.example .env                # set DB_PASSWORD to something real

$EDITOR config/trunk-recorder.json   # shortName (= hex sysid), sysId (decimal),
                                     # control_channels, source center/rate

docker compose up -d                 # first build: ~20 min; subsequent <30 s
```

Open **http://localhost:8080**.

The first `docker compose up` triggers a multi-stage build of the trunk-recorder image (clones upstream source, adds `tr-plugin-mqtt` into `user_plugins/`, compiles). Subsequent runs use the cached image.

## Environment variables (`.env`)

| Variable | Required | Meaning |
|---|---|---|
| `DB_PASSWORD` | yes | Postgres password for the `jitr` user. |
| `TZ` | no | Timezone for container logs / timestamps. Default `America/Indiana/Indianapolis`. |
| `MQTT_TOPIC_PREFIX` | no | Base topic for the decoder plugin. Must match the `topic` field in `trunk-recorder.json`. Default `jitr`. |
| `VITE_API_URL` | no | Leave blank for the normal single-host setup — nginx proxies `/api` and `/socket.io`. Only set if the UI is served from a host that can't reach the api via the same origin. |

\newpage

# Configuring a new system

The decoder needs to know five things per system:

1. **`shortName`** — hex sysid, uppercase. This becomes the DB key and the filename prefix for talkgroup imports. Use `"262"` for MESA, `"6BD"` for Indiana SAFE-T, etc.
2. **`sysId`** — same value, but as a **decimal** integer (trunk-recorder v5 rejects strings here). `0x262 = 610`, `0x6BD = 1725`.
3. **`control_channels[]`** — array of control-channel frequencies in Hz. Order matters: the first is tried first; trunk-recorder fails over to the rest.
4. **`bandplan`** — `"rebanded800"` for post-rebanding 800 MHz systems (almost everything built after 2010). `"800_standard"` for older installs.
5. **`talkgroupsFile`** — path to the CSV inside the container: `/app/talkgroups/<sysid>.csv`.

## Where the RF values come from

RadioReference.com's Trunked System Database is the standard source. Look up your system by county or name; for each site you'll see:

- Frequencies with a trailing `c` — those are control channels.
- Frequencies without the `c` — voice.
- The site's NAC (hex) and a description.

The site page also lists the System ID (sysid), WACN, and Network ID somewhere near the top of the page.

## Configuring talkgroups

Drop RadioReference exports in `config/talkgroups/` using the sysid-based filename convention:

```
config/talkgroups/
├── 262.csv            ← MESA talkgroups
├── 262.sites.csv      ← MESA sites + frequencies
├── 6BD.csv            ← SAFE-T talkgroups
└── 6BD.sites.csv      ← SAFE-T sites + frequencies
```

The import module auto-detects two CSV shapes:

- **Classic per-system export** — `Decimal, Alpha Tag, Description, Tag, Group, Mode, Encrypted`
- **TRS full-system dump** — `Decimal, Hex, Alpha Tag, Mode, Description, Tag, Category` (filename on RR is `trs_tg_NNNN.csv`, where NNNN is RR's internal system id — rename it to `<your sysid>.csv`)

The sites CSV (`trs_sites_NNNN.csv` from RR, rename to `<sysid>.sites.csv`) carries control-vs-voice frequencies, NAC, county, lat/lon, and coverage range for each simulcast site.

Both files are read on API container startup. Imports are idempotent — drop an updated CSV and `docker compose restart api` to refresh.

RadioReference premium data is subscriber-licensed. The repo's `.gitignore` excludes `config/talkgroups/*.csv` (keeping only the `example.csv` / `example.sites.csv` placeholders) so real exports stay local.

## Multi-system setups

Nothing about the stack is single-system — the DB keys everything by sysid. To monitor two systems:

1. Drop both pairs of CSVs in `config/talkgroups/`.
2. Add a second entry to `systems[]` in `trunk-recorder.json` with its own `shortName`, `sysId`, and `control_channels`.
3. Add more `sources[]` entries (one per SDR) wide enough to cover both systems' control-channel bands.

The UI's system selector (below the nav) flips between them.

\newpage

# Running the stack

## Everyday commands

```bash
docker compose up -d                  # start everything
docker compose stop                   # stop without removing containers
docker compose down                   # stop and remove containers (volumes persist)
docker compose down -v                # nuclear — wipes DB, audio, MQTT state
docker compose logs -f trunk-recorder # tail the decoder
docker compose logs -f api            # tail the API
docker compose restart api            # after editing mqtt.js or routes
```

## Signals that things are working

After `docker compose up -d`, watch `docker compose logs -f trunk-recorder`. Within ~30 seconds you should see:

```
[MQTT Status]  Connected to broker: tcp://mosquitto:1883
[262]  Started with Control Channel: 856.812500 MHz
[262]  freq: 856.812500 MHz  Control Channel Message Decode Rate: 3/sec, count: 9
```

A steady decode rate above ~2 msgs/sec means the control channel is being heard clearly. Lower than 1/sec usually means an antenna or gain issue.

In parallel, `docker compose logs -f api` should show `[call:start]` entries as traffic appears on the system.

## Checking live via the UI

- **Nav dot** top-left: green means the WebSocket is connected.
- **Dashboard**: the "ACTIVE CALLS" count ticks up as voice grants arrive; the 24 h sparkline is your signal that calls are landing in the DB.
- **Site Info** tab: watch `CURRENT CC` cycle through your control channels and `DECODE RATE` hover around 2–3/sec.

\newpage

# UI guide

The nav has five tabs plus a day/night theme toggle (top-right, ☾ / ☀). The `<sys-bar>` below the nav flips between P25 systems that the API has seen.

## Dashboard

- **Stat row**: active calls, emergencies, calls last 24 h / last hour, and a 24 h call-rate sparkline.
- **ACTIVE CALLS grid**: one card per in-progress call, color-coded by group (law / fire / EMS / public works / ops). Emergency calls bubble to the top with a red left rail; encrypted calls get a purple rail. Each card shows the talkgroup alpha tag, TGID, source unit (if clear), and voice freq.
- **RECENT CALLS table**: the last 50 completed calls, with an audio-playback button for any call that has a recorded WAV.

## Call Log

Full paginated history of completed calls for the selected system. Columns: time, talkgroup, group, freq, duration, flags (emergency / encrypted), play button.

**Why some entries have no duration or audio**: if the voice channel was outside the SDR's tuning window, trunk-recorder never recorded audio but our API still synthesizes the `call_end` from the `calls_active` snapshot stream. You get a row with start time, talkgroup, freq, and an inferred duration, but no `audio_file` — the play button doesn't appear.

## Talkgroups

All imported talkgroups for the selected system. Columns: name, TGID, group, description, call count, last active, encryption badge. Search matches across alpha tag, description, and exact TGID. Sort defaults to most-recently-active first.

## Units

Radios we've observed transmitting. Columns: unit ID, last TG (joined to talkgroups table for the alpha tag), group, last voice freq, call count, last seen.

Encrypted calls don't report a source unit — you'll see fewer unit entries than calls for a heavily-encrypted system.

## Site Info

Four panels, top to bottom:

- **SYSTEM**: shortName, WACN, NAC, RFSS, current site, currently-decoding control channel, decode rate, squelch. Populated from the decoder's retained `systems` and `config` MQTT messages plus the every-3 s `rates` stream. The WACN/NAC/RFSS fields only fill in once the decoder has successfully decoded a network status TSBK from the CC — can take a minute after startup.
- **SDR SOURCES**: one card per configured `sources[]` entry in `trunk-recorder.json`. Shows center, sample rate, usable RF window, gain, and the `antenna` label. Useful for sanity-checking whether your SDR window actually covers the control channels you've listed.
- **RECORDERS**: live table of every trunk-recorder digital recorder and its state. In a single-dongle metadata-only setup this is usually all-idle (no voice to record).
- **SITES**: grouped by RFSS. Each site card shows description, site ID (decimal and hex), NAC, county, coverage range, lat/lon (click to open OpenStreetMap), control channels as amber chips (primary bolded), and voice channels as muted chips. The currently-decoding site gets a `DECODING` badge and amber glow.

\newpage

# MQTT and API reference

## MQTT topics

The decoder's `libmqtt_status_plugin.so` publishes under the `jitr` prefix (override via `MQTT_TOPIC_PREFIX`):

| Topic | Cadence | What it carries |
|---|---|---|
| `jitr/trunk_recorder/status` | on connect (retained) | `{status: "connected"}` heartbeat |
| `jitr/config` | on startup (retained) | Full trunk-recorder config: sources, systems, squelch |
| `jitr/systems` | on startup + as data arrives (retained) | Per-system metadata: sysid, WACN, NAC, RFSS, site_id |
| `jitr/rates` | ~every 3 s | Decode rate per control channel |
| `jitr/call_start` | per voice grant | Full call data, nested under a `call` object |
| `jitr/call_end` | per recording finalized | Fires only if audio was captured; includes filename + duration |
| `jitr/calls_active` | every 1 s | Snapshot of all currently-active calls (the `call_num` inside is the disambiguator) |
| `jitr/recorders` | every 3 s | Every recorder's state: RECORDING / IDLE / AVAILABLE, current TGID and freq |
| `jitr/units/<shortname>/<event>` | per event | Unit activity: `call`, `on`, `off`, `join` |

The API subscribes to `jitr/#` and routes by subtopic.

## WebSocket events (server → browser)

| Event | When |
|---|---|
| `active:snapshot` | On client connect — full active-calls list |
| `call:start` | New voice grant |
| `call:end` | Call finalized (real or synthesized from `calls_active` diff) |
| `rates` | Control-channel decode telemetry pass-through |

## REST endpoints

| Method + path | Description |
|---|---|
| `GET /api/systems` | All systems with live stats |
| `GET /api/systems/:sysid` | Full detail: WACN / NAC / RFSS, current CC + decode rate, `sdr_sources_json`, `recorders_json`, and the `sites[]` array |
| `GET /api/systems/:sysid/active` | Currently-active calls for that system |
| `GET /api/systems/:sysid/stats?hours=24` | Hourly call counts (powers the sparkline) |
| `GET /api/calls` | Call log with filters: `sysid`, `tgid`, `unit`, `emergency`, `encrypted`, `limit`, `offset`, `since` |
| `GET /api/calls/:id/audio` | WAV/M4A download if `audio_file` is set |
| `GET /api/talkgroups` | `sysid`, `group_tag`, `search`, `limit`, `offset` |
| `POST /api/talkgroups/import` | Bulk JSON upsert: `{sysid, rows: [{tgid, alpha_tag, ...}]}` |
| `GET /api/units` | `sysid`, `limit` |
| `GET /api/health` | `{status: "ok", ts: ...}` |

\newpage

# Troubleshooting

**Dashboard is blank** — the frontend JS bundle is probably hitting the wrong backend. Check `localStorage.getItem('jitr-theme')` in the browser console and inspect the Network tab. If requests are going to `http://localhost:3000`, your build baked in the old `VITE_API_URL`. Leave `VITE_API_URL=` blank in `.env` and rebuild frontend.

**`docker compose up -d trunk-recorder` keeps restarting** — check `docker logs jitr-decoder 2>&1 | tail -30`. Most common causes:

- `Failed parsing Config: (/sysId) type must be number, but is string` — trunk-recorder v5 requires `"sysId"` as a decimal integer. `0x262 = 610`.
- `(/control_channels) type must be array, but is null` — the field is named `control_channels` (underscore) in v5, not `control_channel_list`.
- `(/statusServer) type must be string, but is boolean` — delete that field, it no longer accepts `false`.
- `Unable to find a source for this System! Control Channel Freq: X MHz` — your SDR window doesn't cover the listed control channel. Widen `rate` to `2880000` or shift `center`.

**`[R82XX] PLL not locked!`** — informational, not an error. The tuner reports this at startup and when retuning; it settles within a few ms.

**Bad Gateway (502) from the UI** — nginx cached the api container's previous IP after an api restart. `docker compose restart frontend` fixes it.

**No `call_end` events, Call Log empty** — trunk-recorder only emits `call_end` when an audio recording completes. For single-dongle out-of-band voice setups, the API's `calls_active` synthesizer fills in the Call Log without audio; make sure the `unit_topic` and `calls_active` handlers are firing (`docker logs jitr-api 2>&1 | grep call:end`).

**`WACN: 0`, `RFSS: 0` on the Site Info panel** — the decoder plugin publishes a placeholder zeroed `systems` message on startup, before it's heard a network status TSBK. Real values arrive on the next `systems` publish (can take a minute after the first control-channel message). The API's COALESCE logic preserves real values across later empty/zero messages; if you ever see a stale `0` stored in the DB, clear it with `UPDATE systems SET wacn=NULL WHERE wacn='0';` and wait for the next retained publish.

**Port 3000 collision** — if another container on the host is using 3000 (a common default), the committed `compose.yml` still exposes api on 3000, which will fail. The frontend doesn't actually need the api port exposed (nginx proxies internally), so create a `compose.override.yml`:

```yaml
services:
  api:
    ports: !reset []
```

This file is gitignored.

**Talkgroup CSV fails to parse on a handful of rows** — RadioReference TRS exports occasionally embed bare double-quotes inside quoted fields (`"Ops 3 "Tac""`), which isn't RFC-4180 compliant. The import module detects the TRS format and uses a regex parser that tolerates this. If you still see parse failures, it's most likely a row with fewer than 7 commas — inspect with `awk -F',' 'NR==LINE_NUM' your-file.csv`.

\newpage

# Maintenance

## Upgrading

Upstream `trunk-recorder` and `tr-plugin-mqtt` are cloned at image build time using the `TR_REF` / `PLUGIN_REF` build args in `decoder/Dockerfile` (default `master` / `main`). To pin a version:

```bash
docker compose build --build-arg TR_REF=v5.0.4 --build-arg PLUGIN_REF=v1.2.0 trunk-recorder
```

The `api` and `frontend` images build from local source — `docker compose build api frontend` after a code change, then `docker compose up -d`.

## Schema changes

This is a personal project with no migration framework. When `db/init.sql` changes, the clean path is:

```bash
docker compose down -v                # wipes pg-data volume — DB contents are lost
docker compose up -d
```

The talkgroup / sites CSVs are re-imported on API startup so the big tables repopulate automatically. Audio recordings in the `audio-data` volume are also destroyed by `down -v`; back them up first if they matter.

## Backing up the DB

```bash
docker exec jitr-db pg_dump -U jitr jitr > jitr-$(date -u +%Y%m%d-%H%M).sql
```

Restore:

```bash
docker exec -i jitr-db psql -U jitr -d jitr < jitr-YYYYMMDD-HHMM.sql
```

## Refreshing RadioReference data

Download new CSVs, overwrite the files in `config/talkgroups/`, then `docker compose restart api`. Imports are idempotent.

## Local-only overrides

Two files are always gitignored and safe to use for single-host tweaks:

- `compose.override.yml` — docker-compose-level overrides (port remaps, env vars, extra volumes)
- `config/trunk-recorder.local.json` — drop-in alternate decoder config; mount via compose.override.yml

\newpage

# Glossary

**APCO** — Association of Public-Safety Communications Officials, the standards body behind P25.

**CC (control channel)** — The channel carrying TSBK messages that coordinate the trunked system.

**DVB** — Digital Video Broadcasting. Default kernel driver for RTL2832U chips, which must be blacklisted for RTL-SDR userspace to work.

**FDMA / TDMA** — Frequency-division / time-division multiple access. P25 Phase 1 is FDMA, Phase 2 is TDMA.

**Group tag / category** — Free-text label used by RadioReference to cluster talkgroups by agency / function (e.g. `"Hamilton County Law Enforcement"`).

**NAC (Network Access Code)** — 12-bit hex code per site, acts as an access filter.

**OpenMHz / Broadcastify** — third-party audio aggregation services. Trunk-recorder can upload to them via bundled plugins; we don't use them by default.

**Phase 1 / Phase 2** — P25 modulation generations; see introduction.

**RFSS (RF Subsystem)** — A logical subdivision of a P25 system, often corresponding to a geographic region.

**Simulcast** — Multiple transmitters broadcasting the same signal from different towers to give one logical site coverage over a larger area.

**Site** — A physical simulcast or standalone transmitter. Each has its own site ID and NAC.

**sysid** — 12-bit P25 System ID. `0x262` (MESA), `0x6BD` (Indiana SAFE-T / IPSC).

**Talkgroup (TG)** — A logical voice group. The trunk-recorder config lists which TGs to decode; the CSV imports give them friendly names.

**TSBK (Trunk System Broadcast Keyword)** — The control-channel message type. One TSBK per transaction: a voice grant, a unit registration, a network status broadcast, an adjacent site broadcast, etc.

**Unit** — A single radio on the system, identified by a decimal unit ID.

**WACN (Wide-Area Communications Network)** — 20-bit hex ID for the parent network. Multiple sysids can live under one WACN.
