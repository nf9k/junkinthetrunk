-- Junk in the Trunk — PostgreSQL schema
-- sysid is the anchor key throughout

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Systems ──────────────────────────────────────────────────────────────────

CREATE TABLE systems (
    sysid        VARCHAR(16)  PRIMARY KEY,   -- P25 hex sys ID, e.g. "1B6"
    short_name   TEXT         NOT NULL,
    name         TEXT,
    wacn         VARCHAR(20),                -- P25 WACN (hex)
    rfss         INTEGER,
    nac          INTEGER,                    -- P25 NAC (decimal)
    first_seen   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ─── Sites ────────────────────────────────────────────────────────────────────

CREATE TABLE sites (
    id             SERIAL       PRIMARY KEY,
    sysid          VARCHAR(16)  NOT NULL REFERENCES systems(sysid) ON DELETE CASCADE,
    site_id        INTEGER      NOT NULL,           -- decimal site id
    rfss_id        INTEGER,
    nac            VARCHAR(8),                      -- P25 site NAC (hex)
    description    TEXT,
    county         TEXT,
    lat            NUMERIC(9,6),
    lon            NUMERIC(10,6),
    range_mi       INTEGER,
    control_freqs  BIGINT[]     NOT NULL DEFAULT '{}',  -- Hz, primary first
    voice_freqs    BIGINT[]     NOT NULL DEFAULT '{}',  -- Hz
    last_seen      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE(sysid, rfss_id, site_id)
);

CREATE INDEX idx_sites_sysid ON sites(sysid);

-- ─── Talkgroups ───────────────────────────────────────────────────────────────

CREATE TABLE talkgroups (
    id            SERIAL       PRIMARY KEY,
    sysid         VARCHAR(16)  NOT NULL REFERENCES systems(sysid) ON DELETE CASCADE,
    tgid          INTEGER      NOT NULL,
    alpha_tag     TEXT,
    description   TEXT,
    group_tag     TEXT,                      -- Law Dispatch, Fire, EMS, etc.
    priority      INTEGER      DEFAULT 0,
    encrypted     BOOLEAN      NOT NULL DEFAULT false,
    call_count    BIGINT       NOT NULL DEFAULT 0,
    last_active   TIMESTAMPTZ,
    UNIQUE(sysid, tgid)
);

CREATE INDEX idx_tg_sysid       ON talkgroups(sysid);
CREATE INDEX idx_tg_last_active ON talkgroups(sysid, last_active DESC NULLS LAST);

-- ─── Calls ────────────────────────────────────────────────────────────────────

CREATE TABLE calls (
    id            BIGSERIAL    PRIMARY KEY,
    sysid         VARCHAR(16)  NOT NULL REFERENCES systems(sysid) ON DELETE CASCADE,
    tgid          INTEGER,
    source_unit   INTEGER,
    freq          BIGINT,
    start_time    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    duration      NUMERIC(8,2),             -- seconds
    emergency     BOOLEAN      NOT NULL DEFAULT false,
    encrypted     BOOLEAN      NOT NULL DEFAULT false,
    audio_file    TEXT,                     -- relative path under audio volume
    phase         SMALLINT     DEFAULT 1   -- P25 Phase 1 or 2
);

CREATE INDEX idx_calls_sysid_time ON calls(sysid, start_time DESC);
CREATE INDEX idx_calls_tgid       ON calls(sysid, tgid, start_time DESC);
CREATE INDEX idx_calls_emergency  ON calls(emergency) WHERE emergency = true;
CREATE INDEX idx_calls_unit       ON calls(sysid, source_unit);

-- ─── Units ────────────────────────────────────────────────────────────────────

CREATE TABLE units (
    id            BIGSERIAL    PRIMARY KEY,
    sysid         VARCHAR(16)  NOT NULL REFERENCES systems(sysid) ON DELETE CASCADE,
    unit_id       INTEGER      NOT NULL,
    last_tgid     INTEGER,
    last_freq     BIGINT,
    last_seen     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    call_count    BIGINT       NOT NULL DEFAULT 0,
    UNIQUE(sysid, unit_id)
);

CREATE INDEX idx_units_sysid     ON units(sysid);
CREATE INDEX idx_units_last_seen ON units(sysid, last_seen DESC);

-- ─── Active Calls (ephemeral) ─────────────────────────────────────────────────

CREATE TABLE active_calls (
    id            SERIAL       PRIMARY KEY,
    sysid         VARCHAR(16)  NOT NULL,
    tgid          INTEGER,
    alpha_tag     TEXT,
    group_tag     TEXT,
    source_unit   INTEGER,
    freq          BIGINT,
    start_time    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    emergency     BOOLEAN      NOT NULL DEFAULT false,
    encrypted     BOOLEAN      NOT NULL DEFAULT false,
    phase         SMALLINT     DEFAULT 1
);

CREATE INDEX idx_active_sysid ON active_calls(sysid);

-- ─── System Stats (materialized, refreshed by API) ────────────────────────────

CREATE TABLE system_stats (
    sysid                 VARCHAR(16)  PRIMARY KEY REFERENCES systems(sysid) ON DELETE CASCADE,
    calls_today           INTEGER      NOT NULL DEFAULT 0,
    calls_hour            INTEGER      NOT NULL DEFAULT 0,
    active_tgs            INTEGER      NOT NULL DEFAULT 0,
    -- Real-time from tr-plugin-mqtt
    current_site_id       INTEGER,                  -- from systems retained msg
    current_control_freq  BIGINT,                   -- from rates msg
    current_decode_rate   NUMERIC(6,2),             -- msgs/sec on the active CC
    squelch_db            INTEGER,                  -- from config msg
    sdr_sources_json      JSONB,                    -- sources[] from config msg
    recorders_json        JSONB,                    -- recorders[] snapshot (every 3s)
    recorders_updated_at  TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ─── Seed helper function: upsert system on first contact ────────────────────

CREATE OR REPLACE FUNCTION upsert_system(
    p_sysid      VARCHAR,
    p_short_name TEXT,
    p_wacn       VARCHAR DEFAULT NULL,
    p_nac        INTEGER DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO systems(sysid, short_name, wacn, nac)
    VALUES (p_sysid, p_short_name, p_wacn, p_nac)
    ON CONFLICT (sysid) DO UPDATE
      SET last_seen  = now(),
          wacn       = COALESCE(EXCLUDED.wacn,  systems.wacn),
          nac        = COALESCE(EXCLUDED.nac,   systems.nac);

    INSERT INTO system_stats(sysid) VALUES (p_sysid)
    ON CONFLICT (sysid) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
