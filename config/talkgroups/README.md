# Talkgroup & site CSVs

Drop RadioReference exports in this directory. The API container auto-imports
them on startup and upserts to Postgres.

## Filename convention

| Pattern | What it is | Example |
|---|---|---|
| `<sysid>.csv` | Talkgroups for P25 system `<sysid>` | `262.csv` (MESA) |
| `<sysid>.sites.csv` | Sites + frequencies for the same system | `262.sites.csv` |

`<sysid>` is the P25 System ID in hex, upper- or lower-case. Anything else
(README, the example files below, etc.) is ignored with a single log line
at startup.

## Getting the files from RadioReference

**Classic per-system export** (smaller, simpler format):

> RadioReference → Database → *your system* → Export → Talkgroups CSV

**TRS full-system export** (richer; includes sites):

> RadioReference Premium → *your system page* → Data Downloads →
> `trs_tg_NNNN.csv` (talkgroups) and `trs_sites_NNNN.csv` (sites)

Rename each file to match the convention:

```bash
mv ~/Downloads/trs_tg_5737.csv    config/talkgroups/262.csv
mv ~/Downloads/trs_sites_5737.csv config/talkgroups/262.sites.csv
```

`5737` in RR's filenames is *their* internal system id — not the P25 sysid.
The P25 sysid (hex) is what goes in the filename and the `systems` table.

## Licensing

The repo's `.gitignore` excludes `*.csv` so your RR exports stay local.
RR premium data is licensed to subscribers for personal use; redistribution
via a public repo is typically not permitted. Keep real exports out of git.

`example.csv` and `example.sites.csv` are fabricated placeholder data —
safe to commit, useful for reading the expected column shapes. They do
NOT match `<sysid>.csv` and will be skipped at startup.

## CSV shapes

### Talkgroups — classic RR format

```
Decimal,Alpha Tag,Description,Tag,Group,Mode,Encrypted
1,DISP-LAW-1,Law Dispatch 1,Law Dispatch,LAW,D,0
```

### Talkgroups — TRS format

```
Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category
1001,3E9,"EX-LAW-DISP","D","Example dispatch","Law Dispatch","Example County"
```

Both are auto-detected by the import module. In TRS format, encryption is
inferred from `Mode`: `D` = clear, `De` or `DE` = encrypted.

### Sites — RR TRS format

```
RFSS,Site Dec,Site Hex,Site NAC,Description,County Name,Lat,Lon,Range,Frequencies
1,001,1,123,"Example Simulcast","Example",40.0,-86.0,25,851.000000c,852.000000,852.500000c
```

`Frequencies` is a variable-length tail. Values with a trailing `c` are
control channels; others are voice. They land in `sites.control_freqs[]`
and `sites.voice_freqs[]` respectively.
