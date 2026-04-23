import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const API    = import.meta.env.VITE_API_URL || '';
const socket = io(API, { transports: ['websocket', 'polling'] });

// ── Band plan metadata ────────────────────────────────────────────────────────

const BAND_PLAN_META = {
  rebanded800:    { label: 'APCO 800 MHz Rebanded', spacing: 25000, fdma: 12500, tdma: 6250, duplex:  45000000, base: 851012500 },
  '800_standard': { label: 'APCO 800 MHz Standard', spacing: 25000, fdma: 12500, tdma: 6250, duplex:  45000000, base: 851012500 },
  '900_standard': { label: '900 MHz Standard',       spacing: 12500, fdma: 12500, tdma: null,  duplex: -39000000, base: 935012500 },
  uhf:            { label: 'UHF',                    spacing: 12500, fdma: 12500, tdma: null,  duplex: null,      base: null      },
  vhf:            { label: 'VHF',                    spacing: 12500, fdma: 12500, tdma: null,  duplex: null,      base: null      },
};

const freqToChannel = (hz, bp) =>
  bp?.base != null ? Math.round((Number(hz) - bp.base) / bp.spacing) : null;

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmtFreq = (hz) => hz ? `${(hz / 1e6).toFixed(4)}` : '—';
const fmtDur  = (s)  => s != null ? `${parseFloat(s).toFixed(1)}s` : '—';

const freqToTrunk = (hz, sources) => {
  if (!hz || !sources?.length) return null;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (Math.abs(hz - src.center) <= (src.rate || 0) / 2)
      return src.device ? src.device.split('=').pop() : `SDR${i}`;
  }
  return null;
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtAge  = (ts) => {
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h`;
};

const GROUP_COLOR = (tag) => {
  if (!tag) return 'var(--cyan)';
  const t = tag.toLowerCase();
  if (t.includes('fire'))                         return '#ff5c35';
  if (t.includes('ems') || t.includes('medic'))   return '#ff9900';
  if (t.includes('law') || t.includes('police') || t.includes('sheriff')) return '#4a9eff';
  if (t.includes('works') || t.includes('util'))  return '#7ed957';
  if (t.includes('admin') || t.includes('ops'))   return '#c084fc';
  return 'var(--cyan)';
};

const api = async (path) => {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

// ── Elapsed timer — re-renders every second ───────────────────────────────────
function Elapsed({ since }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{fmtAge(since)}</span>;
}

// ── Active Call Card ──────────────────────────────────────────────────────────
function CallCard({ call, sources, onLock, isLocked }) {
  const color = call.emergency ? 'var(--red)' : call.encrypted ? '#c084fc' : GROUP_COLOR(call.group_tag);
  const trunk = freqToTrunk(call.freq, sources);

  return (
    <div className={`call-card${call.emergency ? ' call-card--emrg' : ''}${isLocked ? ' call-card--locked' : ''}`}
      style={{ '--card-color': color }}
      onClick={() => onLock && onLock(call)}
      title={isLocked ? 'Streaming — click to unlock' : 'Click to lock & stream audio'}>
      <div className="call-card__header">
        <div className="call-card__tags">
          {call.emergency && <span className="badge badge--emrg">EMRG</span>}
          {call.encrypted && <span className="badge badge--enc">ENC</span>}
          <span className="badge badge--phase">P{call.phase || 1}</span>
        </div>
        <span className="call-card__elapsed mono dim"><Elapsed since={call.start_time} /></span>
      </div>

      <div className="call-card__tg" style={{ color }}>
        {call.alpha_tag || `TG ${call.tgid}`}
      </div>

      <div className="call-card__meta mono dim">
        <span>TG {call.tgid}</span>
        {call.unit && <span>· UID {call.unit}</span>}
        {call.group_tag && <span>· {call.group_tag}</span>}
      </div>

      <div className="call-card__freq mono">
        {fmtFreq(call.freq)} <span className="dim">MHz</span>
        {trunk && <span className="trunk-badge">{trunk}</span>}
      </div>
    </div>
  );
}

// ── Call Log Row ──────────────────────────────────────────────────────────────
function CallRow({ call, onAudio, sources }) {
  const color = call.emergency ? 'var(--red)' : call.encrypted ? '#c084fc' : GROUP_COLOR(call.group_tag);
  const trunk = freqToTrunk(call.freq, sources);
  return (
    <tr className="tbl-row">
      <td className="mono dim xs">{fmtTime(call.start_time)}</td>
      <td>
        <span style={{ color, fontFamily: 'var(--font-display)', fontSize: '1.154rem', letterSpacing: '0.05em' }}>
          {call.alpha_tag || `TG ${call.tgid}`}
        </span>
        <span className="mono dim xs" style={{ marginLeft: 8 }}>{call.tgid}</span>
      </td>
      <td className="mono dim xs">{call.group_tag || '—'}</td>
      <td className="mono dim xs">
        {fmtFreq(call.freq)} <span className="dim" style={{fontSize: '0.769rem'}}>MHz</span>
        {trunk && <span className="trunk-badge">{trunk}</span>}
      </td>
      <td className="mono dim xs">{fmtDur(call.duration)}</td>
      <td>
        {call.emergency && <span className="badge badge--emrg">EMRG</span>}
        {call.encrypted && <span className="badge badge--enc" style={{marginLeft:2}}>ENC</span>}
      </td>
      <td>
        {call.audio_file && (
          <button className="btn-audio" onClick={() => onAudio(call.id)} title="Play audio">▶</button>
        )}
      </td>
    </tr>
  );
}

// ── Talkgroup Row ─────────────────────────────────────────────────────────────
function TGRow({ tg, inScan, onToggle, scanActive }) {
  const color  = GROUP_COLOR(tg.group_tag);
  const muted  = scanActive && !inScan;
  const rowCls = `tbl-row tbl-row--clickable${inScan ? ' tbl-row--scanned' : ''}${muted ? ' tbl-row--muted' : ''}`;
  return (
    <tr className={rowCls} onClick={() => onToggle(String(tg.tgid))}>
      <td>
        <span style={{ color: muted ? 'var(--text-dim)' : color, fontFamily: 'var(--font-display)', fontSize: '1.154rem', letterSpacing: '0.05em' }}>
          {tg.alpha_tag || `TG ${tg.tgid}`}
        </span>
      </td>
      <td className="mono dim xs">{tg.tgid}</td>
      <td className="mono dim xs">{tg.group_tag || '—'}</td>
      <td className="mono dim xs">{tg.description || '—'}</td>
      <td className="mono xs" style={{ color: muted ? 'var(--text-dim)' : 'var(--cyan)' }}>{tg.call_count || 0}</td>
      <td className="mono dim xs">{tg.last_active ? fmtTime(tg.last_active) : '—'}</td>
      <td>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          {tg.encrypted && <span className="badge badge--enc">ENC</span>}
          {inScan && <span style={{ color: 'var(--green)', fontSize: '0.769rem' }}>●</span>}
        </span>
      </td>
    </tr>
  );
}

// ── Unit Row ──────────────────────────────────────────────────────────────────
function UnitRow({ unit }) {
  return (
    <tr className="tbl-row">
      <td className="mono" style={{ color: 'var(--cyan)', fontSize: '1rem' }}>{unit.unit_id}</td>
      <td className="mono dim xs">{unit.last_tg_name || unit.last_tgid || '—'}</td>
      <td className="mono dim xs">{unit.group_tag || '—'}</td>
      <td className="mono dim xs">{fmtFreq(unit.last_freq)} {unit.last_freq ? <span style={{fontSize: '0.769rem'}}>MHz</span> : ''}</td>
      <td className="mono xs" style={{ color: 'var(--cyan)' }}>{unit.call_count || 0}</td>
      <td className="mono dim xs">{fmtTime(unit.last_seen)}</td>
    </tr>
  );
}

// ── Sparkline (call rate bars) ────────────────────────────────────────────────
function Sparkline({ data }) {
  if (!data?.length) return <div className="sparkline sparkline--empty">no data</div>;
  const max = Math.max(...data.map(d => d.call_count), 1);
  return (
    <div className="sparkline">
      {data.map((d, i) => (
        <div key={i} className="sparkline__bar"
          style={{ height: `${Math.max(2, (d.call_count / max) * 100)}%` }}
          title={`${new Date(d.hour).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} · ${d.call_count} calls`}
        />
      ))}
    </div>
  );
}

// ── Audio player bar ──────────────────────────────────────────────────────────
function AudioBar({ callId, onClose }) {
  const src = `${API}/api/calls/${callId}/audio`;
  return (
    <div className="audio-bar">
      <span className="mono dim xs">CALL #{callId}</span>
      <audio controls autoPlay src={src} style={{ flex: 1, height: 28 }} />
      <button className="audio-bar__close" onClick={onClose}>✕</button>
    </div>
  );
}

// ── Stat box ──────────────────────────────────────────────────────────────────
function Stat({ label, value, alert }) {
  return (
    <div className={`stat-box${alert ? ' stat-box--alert' : ''}`}>
      <div className="stat-box__label mono dim">{label}</div>
      <div className="stat-box__value">{value ?? '—'}</div>
    </div>
  );
}

// ── TG Lock bar ───────────────────────────────────────────────────────────────
function TgLockBar({ lockedTg, queueLen, isPlaying, onStop }) {
  return (
    <div className="lock-bar">
      <div className={`lock-bar__dot${isPlaying ? ' lock-bar__dot--playing' : ''}`} />
      <span className="lock-bar__label">{lockedTg.label}</span>
      <span className="mono dim xs">· TG {lockedTg.tgid}</span>
      <span className="lock-bar__status mono xs">
        {isPlaying ? '▶ PLAYING' : '● LOCKED'}
        {queueLen > 0 && ` · ${queueLen} queued`}
      </span>
      <button className="lock-bar__stop" onClick={onStop}>✕ UNLOCK</button>
    </div>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────
const PAGES = ['Dashboard', 'Call Log', 'Talkgroups', 'Units', 'Site Info'];

const FONT_SIZE_LABELS = { small: 'S', normal: 'M', large: 'L', xlarge: 'XL' };

function Nav({ page, setPage, connected, activeCount, emergencyCount,
              theme, toggleTheme, fontSize, cycleFontSize }) {
  return (
    <nav className="nav">
      <div className="nav__brand">
        <div className={`nav__dot${connected ? ' nav__dot--live' : ''}`} />
        <img src="/logo.png" alt="Junk in the Trunk" className="nav__logo" />
      </div>

      <div className="nav__links">
        {PAGES.map(p => (
          <button key={p} className={`nav__link${page === p ? ' nav__link--active' : ''}`}
            onClick={() => setPage(p)}>
            {p.toUpperCase()}
            {p === 'Dashboard' && activeCount > 0 && (
              <span className={`nav__badge${emergencyCount > 0 ? ' nav__badge--emrg' : ''}`}>
                {activeCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="nav__status mono">
        <button className="theme-toggle mono" onClick={cycleFontSize} title="Cycle font size (S / M / L / XL)">
          A {FONT_SIZE_LABELS[fontSize] || 'M'}
        </button>
        <button className="theme-toggle mono" onClick={toggleTheme} title="Toggle day / night view">
          {theme === 'day' ? '☀ DAY' : '☾ NIGHT'}
        </button>
        <span className={connected ? 'green' : 'dim'}>{connected ? 'LIVE' : 'OFFLINE'}</span>
      </div>
    </nav>
  );
}

// ── System selector ───────────────────────────────────────────────────────────
function SysBar({ systems, sysid, setSysid }) {
  if (!systems.length) return null;
  return (
    <div className="sys-bar">
      <span className="mono dim" style={{ fontSize: '0.769rem', marginRight: 10 }}>SYSTEM</span>
      {systems.map(s => (
        <button key={s.sysid}
          className={`sys-btn${sysid === s.sysid ? ' sys-btn--active' : ''}`}
          onClick={() => setSysid(s.sysid)}>
          {s.short_name || s.name || s.sysid}
          <span className="mono" style={{ marginLeft: 6, fontSize: '0.692rem', opacity: 0.5 }}>{s.sysid}</span>
        </button>
      ))}
    </div>
  );
}

// ── Table wrapper ─────────────────────────────────────────────────────────────
function Tbl({ cols, children, empty }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {cols.map(c => <th key={c} className="tbl-th">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {children}
          {empty && (
            <tr><td colSpan={cols.length} className="tbl-empty mono dim">{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Site Info page ────────────────────────────────────────────────────────────

function SiteCard({ site, isCurrent, bp }) {
  const ctrl  = site.control_freqs || [];
  const voice = site.voice_freqs   || [];

  const FreqChip = ({ hz, isCtrl, primary }) => {
    const ch = freqToChannel(hz, bp);
    return (
      <span className={`freq-chip${isCtrl ? ' freq-chip--ctrl' : ''}${primary ? ' freq-chip--primary' : ''}`}>
        <span>{fmtFreq(hz)}</span>
        {ch != null && <span className="chip-ch">ch {ch}</span>}
      </span>
    );
  };

  return (
    <div className={`site-card${isCurrent ? ' site-card--current' : ''}`}>
      <div className="site-card__header">
        <div>
          <div className="site-card__title">
            {site.description || `Site ${site.site_id}`}
            {isCurrent && <span className="badge badge--live">DECODING</span>}
          </div>
          <div className="mono dim xs" style={{ marginTop: 2 }}>
            RFSS {site.rfss_id} · Site {site.site_id} (0x{site.site_id?.toString(16).toUpperCase()}) · NAC {site.nac || '—'}
          </div>
        </div>
        <div className="site-card__geo mono dim xs">
          {site.county && <div>{site.county} Co.</div>}
          {site.range_mi && <div>{site.range_mi} mi</div>}
          {(site.lat && site.lon) && (
            <a className="site-card__maplink" target="_blank" rel="noreferrer"
              href={`https://www.openstreetmap.org/?mlat=${site.lat}&mlon=${site.lon}&zoom=12`}>
              {Number(site.lat).toFixed(3)},{Number(site.lon).toFixed(3)}
            </a>
          )}
        </div>
      </div>

      <div className="site-card__channels">
        <div className="site-card__channels-label mono dim xs">CONTROL · {ctrl.length}</div>
        <div className="freq-chips">
          {ctrl.map((hz, i) => <FreqChip key={hz} hz={hz} isCtrl primary={i === 0} />)}
        </div>
        <div className="site-card__channels-label mono dim xs" style={{ marginTop: 8 }}>
          VOICE · {voice.length}
        </div>
        <div className="freq-chips">
          {voice.map(hz => <FreqChip key={hz} hz={hz} />)}
        </div>
      </div>
    </div>
  );
}

function SiteInfoPage({ detail }) {
  if (!detail) {
    return <div className="page"><div className="scanning mono dim">— LOADING —</div></div>;
  }

  const sources   = detail.sdr_sources_json || [];
  const recorders = detail.recorders_json   || [];
  const activeRec = recorders.filter(r => r.rec_state_type && r.rec_state_type !== 'IDLE' && r.rec_state_type !== 'AVAILABLE');
  const currentSite = detail.current_site_id;
  const bp = BAND_PLAN_META[detail.bandplan] || null;

  // Group sites by RFSS for display
  const byRfss = {};
  for (const s of detail.sites || []) {
    (byRfss[s.rfss_id] ??= []).push(s);
  }

  return (
    <div className="page">
      {/* System-level real-time panel */}
      <div className="section-label mono">SYSTEM
        <span className="section-count">{detail.sysid}</span>
      </div>
      <div className="stat-row">
        <Stat label="SHORTNAME"    value={detail.short_name || '—'} />
        <Stat label="WACN"         value={detail.wacn || '—'} />
        <Stat label="NAC"          value={detail.nac != null ? detail.nac.toString(16).toUpperCase() : '—'} />
        <Stat label="RFSS"         value={detail.rfss || '—'} />
        <Stat label="CURRENT SITE" value={currentSite ? `${currentSite} (0x${currentSite.toString(16).toUpperCase()})` : '—'} />
        <Stat label="CURRENT CC"   value={detail.current_control_freq ? `${fmtFreq(detail.current_control_freq)}` : '—'} />
        <Stat label="DECODE RATE"  value={detail.current_decode_rate != null ? `${Number(detail.current_decode_rate).toFixed(1)}/s` : '—'} />
        <Stat label="SQUELCH"      value={detail.squelch_db != null ? `${detail.squelch_db} dB` : '—'} />
      </div>

      {/* Band Plan */}
      {detail.bandplan && (
        <>
          <div className="section-label mono" style={{ marginTop: 24 }}>BAND PLAN</div>
          <div className="bandplan-card mono">
            <div className="bandplan-title">{bp?.label || detail.bandplan}</div>
            <div className="bandplan-params">
              <div><span className="dim xs">CHANNEL SPACING</span><span>{bp ? `${bp.spacing / 1000} kHz` : '—'}</span></div>
              <div><span className="dim xs">FDMA WIDTH</span><span>{bp ? `${bp.fdma / 1000} kHz` : '—'}</span></div>
              {bp?.tdma && <div><span className="dim xs">TDMA SLOT (PHASE 2)</span><span>{bp.tdma / 1000} kHz · 2 slots/ch</span></div>}
              {bp?.duplex != null && <div><span className="dim xs">DUPLEX OFFSET</span><span>{bp.duplex > 0 ? '+' : ''}{bp.duplex / 1e6} MHz</span></div>}
              {bp?.base && <div><span className="dim xs">BASE (MOBILE TX)</span><span>{(bp.base / 1e6).toFixed(4)} MHz</span></div>}
            </div>
          </div>
        </>
      )}

      {/* SDR sources */}
      <div className="section-label mono" style={{ marginTop: 24 }}>
        SDR SOURCES
        <span className="section-count">{sources.length}</span>
      </div>
      {sources.length === 0 ? (
        <div className="tbl-empty mono dim" style={{ padding: '12px 0' }}>— no config received yet —</div>
      ) : (
        <div className="sdr-grid">
          {sources.map((src, i) => (
            <div key={i} className="sdr-card">
              <div className="sdr-card__title mono">
                SDR #{src.source_num ?? i} <span className="dim">· {src.device || '—'}</span>
              </div>
              <div className="sdr-card__stats">
                <div><span className="mono dim xs">CENTER</span> {src.center ? fmtFreq(src.center) : '—'} MHz</div>
                <div><span className="mono dim xs">RATE</span>   {src.rate ? (src.rate / 1e6).toFixed(2) : '—'} MS/s</div>
                <div><span className="mono dim xs">WINDOW</span> {src.min_hz ? fmtFreq(src.min_hz) : '—'} – {src.max_hz ? fmtFreq(src.max_hz) : '—'} MHz</div>
                <div><span className="mono dim xs">GAIN</span>   {src.gain != null ? `${src.gain} dB` : '—'}</div>
              </div>
              {src.antenna && <div className="sdr-card__antenna mono dim xs">{src.antenna}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Active recorders */}
      <div className="section-label mono" style={{ marginTop: 24 }}>
        RECORDERS
        <span className="section-count">{activeRec.length}/{recorders.length}</span>
      </div>
      {recorders.length === 0 ? (
        <div className="tbl-empty mono dim" style={{ padding: '12px 0' }}>— no recorders reporting yet —</div>
      ) : (
        <Tbl cols={['#', 'State', 'TG', 'Freq', 'Duration']} empty={null}>
          {recorders.map((r, i) => (
            <tr key={i} className="tbl-row">
              <td className="mono xs">{r.rec_num ?? i}</td>
              <td className="mono xs">
                <span style={{ color: r.rec_state_type === 'RECORDING' ? 'var(--green)' : 'var(--text-muted)' }}>
                  {r.rec_state_type || '—'}
                </span>
              </td>
              <td className="mono xs">{r.current_tgid || '—'}</td>
              <td className="mono xs">{r.current_freq ? fmtFreq(r.current_freq) : '—'}</td>
              <td className="mono xs">{r.current_length != null ? fmtDur(r.current_length) : '—'}</td>
            </tr>
          ))}
        </Tbl>
      )}

      {/* Sites — grouped by RFSS */}
      <div className="section-label mono" style={{ marginTop: 24 }}>
        SITES
        <span className="section-count">{detail.sites?.length || 0}</span>
      </div>
      {(!detail.sites || detail.sites.length === 0) ? (
        <div className="tbl-empty mono dim" style={{ padding: '12px 0' }}>
          — no sites — drop a &lt;sysid&gt;.sites.csv in config/talkgroups/ —
        </div>
      ) : Object.keys(byRfss).sort().map(rfssId => (
        <div key={rfssId} style={{ marginBottom: 18 }}>
          <div className="mono dim xs" style={{ margin: '10px 0 8px', letterSpacing: '0.1em' }}>
            ── RFSS {rfssId} · {byRfss[rfssId].length} SITE{byRfss[rfssId].length !== 1 ? 'S' : ''} ──
          </div>
          <div className="site-grid">
            {byRfss[rfssId].map(site => (
              <SiteCard key={site.id} site={site}
                isCurrent={currentSite === site.site_id} bp={bp} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [page,       setPage]       = useState('Dashboard');
  const [connected,  setConnected]  = useState(false);
  const [systems,    setSystems]    = useState([]);
  const [sysid,      setSysid]      = useState(null);
  const [active,     setActive]     = useState([]);
  const [calls,      setCalls]      = useState([]);
  const [talkgroups, setTalkgroups] = useState([]);
  const [units,      setUnits]      = useState([]);
  const [spark,      setSpark]      = useState([]);
  const [sysDetail,  setSysDetail]  = useState(null);
  const [audioCallId,   setAudioCallId]   = useState(null);
  const [lockedTg,      setLockedTg]      = useState(null);
  const [audioQueue,    setAudioQueue]    = useState([]);
  const [playingLockId, setPlayingLockId] = useState(null);
  const lockAudioRef    = useRef(null);
  const audioUnlocked   = useRef(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('jitr-theme') || 'night');
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('jitr-font-size') || 'normal');
  const [scanList, setScanList] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('jitr-scan-list') || '[]')); }
    catch { return new Set(); }
  });
  const [tgSearch,      setTgSearch]      = useState('');
  const [tgGroupFilter, setTgGroupFilter] = useState('');
  const [tgActiveOnly,  setTgActiveOnly]  = useState(true);
  const [rrSync,        setRrSync]        = useState(null); // null | 'syncing' | {total} | {error}
  const sysidRef    = useRef(sysid);
  const lockedTgRef = useRef(null);
  useEffect(() => { sysidRef.current = sysid; }, [sysid]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('jitr-theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme(t => t === 'day' ? 'night' : 'day');

  useEffect(() => {
    localStorage.setItem('jitr-scan-list', JSON.stringify([...scanList]));
  }, [scanList]);
  const toggleScan = useCallback((tgid) => {
    setScanList(prev => { const n = new Set(prev); n.has(tgid) ? n.delete(tgid) : n.add(tgid); return n; });
  }, []);
  const clearScan = useCallback(() => setScanList(new Set()), []);

  const syncRR = useCallback(async () => {
    setRrSync('syncing');
    try {
      const r = await fetch(`${API}/api/admin/sync-rr`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setRrSync({ total: data.total });
      if (sysidRef.current) fetchTalkgroups(sysidRef.current);
      setTimeout(() => setRrSync(null), 5000);
    } catch (err) {
      setRrSync({ error: err.message });
      setTimeout(() => setRrSync(null), 8000);
    }
  }, [fetchTalkgroups]);

  const lockTg = useCallback((call) => {
    // Unlock browser audio on this user gesture so later .play() calls work
    if (!audioUnlocked.current) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume().then(() => ctx.close());
        audioUnlocked.current = true;
      } catch (_) {}
    }
    const lt = { sysid: call.sysid, tgid: call.tgid, label: call.alpha_tag || `TG ${call.tgid}` };
    lockedTgRef.current = lt;
    setLockedTg(lt);
    setAudioQueue([]);
    setPlayingLockId(null);
  }, []);

  const unlockTg = useCallback(() => {
    lockedTgRef.current = null;
    setLockedTg(null);
    setAudioQueue([]);
    setPlayingLockId(null);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
    localStorage.setItem('jitr-font-size', fontSize);
  }, [fontSize]);
  const FONT_SIZE_CYCLE = ['small', 'normal', 'large', 'xlarge'];
  const cycleFontSize = () => setFontSize(f => {
    const i = FONT_SIZE_CYCLE.indexOf(f);
    return FONT_SIZE_CYCLE[(i + 1) % FONT_SIZE_CYCLE.length];
  });

  // ── Socket events ────────────────────────────────────────────────────────
  useEffect(() => {
    socket.on('connect',          () => setConnected(true));
    socket.on('disconnect',       () => setConnected(false));

    socket.on('active:snapshot',  (rows) => setActive(rows));

    socket.on('call:start', (call) => {
      setActive(prev => {
        const filtered = prev.filter(c => !(c.sysid === call.sysid && c.tgid === call.tgid));
        return [call, ...filtered];
      });
    });

    socket.on('call:end', ({ sysid: sid, tgid, call_id, has_audio }) => {
      setActive(prev => prev.filter(c => !(c.sysid === sid && c.tgid === tgid)));
      if (sysidRef.current) fetchCalls(sysidRef.current);
      const lt = lockedTgRef.current;
      if (lt && lt.sysid === sid && lt.tgid === tgid && has_audio && call_id) {
        setAudioQueue(q => [...q, call_id]);
      }
    });

    socket.on('calls:updated', () => {
      if (sysidRef.current) fetchCalls(sysidRef.current);
    });

    // Fired by syncAudioFiles() when a file is backfilled — more reliable than
    // call:end has_audio, since tr-plugin-mqtt often omits call_filename.
    socket.on('call:audio', ({ sysid: sid, tgid, call_id }) => {
      const lt = lockedTgRef.current;
      if (lt && lt.sysid === sid && lt.tgid === tgid && call_id) {
        setAudioQueue(q => [...q, call_id]);
      }
    });

    return () => {
      socket.off('connect'); socket.off('disconnect');
      socket.off('active:snapshot'); socket.off('call:start'); socket.off('call:end');
      socket.off('calls:updated'); socket.off('call:audio');
    };
  }, []);

  // ── Fetchers ─────────────────────────────────────────────────────────────
  const fetchSystems = useCallback(async () => {
    try {
      const data = await api('/api/systems');
      setSystems(data);
      if (data.length && !sysidRef.current) setSysid(data[0].sysid);
    } catch { /* retry on next poll */ }
  }, []);

  const fetchCalls = useCallback(async (sid) => {
    try { setCalls(await api(`/api/calls?sysid=${sid}&limit=200`)); } catch { }
  }, []);

  const fetchTalkgroups = useCallback(async (sid) => {
    try { setTalkgroups(await api(`/api/talkgroups?sysid=${sid}&limit=500`)); } catch { }
  }, []);

  const fetchUnits = useCallback(async (sid) => {
    try { setUnits(await api(`/api/units?sysid=${sid}&limit=200`)); } catch { }
  }, []);

  const fetchSpark = useCallback(async (sid) => {
    try { setSpark(await api(`/api/systems/${sid}/stats?hours=24`)); } catch { }
  }, []);

  const fetchSysDetail = useCallback(async (sid) => {
    try { setSysDetail(await api(`/api/systems/${sid}`)); } catch { }
  }, []);

  // Initial load + polling
  useEffect(() => {
    fetchSystems();
    const t = setInterval(fetchSystems, 30_000);
    return () => clearInterval(t);
  }, [fetchSystems]);

  // Clear TG filters when system changes
  const prevSysidRef = useRef(null);
  useEffect(() => {
    if (sysid && sysid !== prevSysidRef.current) {
      setTgSearch(''); setTgGroupFilter('');
      prevSysidRef.current = sysid;
    }
  }, [sysid]);

  // Load data when system or page changes
  useEffect(() => {
    if (!sysid) return;
    fetchSpark(sysid);
    fetchSysDetail(sysid);
    if (page === 'Dashboard')  fetchCalls(sysid);
    if (page === 'Call Log')   fetchCalls(sysid);
    if (page === 'Talkgroups') fetchTalkgroups(sysid);
    if (page === 'Units')      fetchUnits(sysid);
  }, [sysid, page]);

  // Site Info realtime fields (current CC, decode rate, recorders) — poll every 3s.
  useEffect(() => {
    if (page !== 'Site Info' || !sysid) return;
    const t = setInterval(() => fetchSysDetail(sysid), 3000);
    return () => clearInterval(t);
  }, [page, sysid, fetchSysDetail]);

  // Drain the audio queue: start the next call as soon as the current one finishes.
  useEffect(() => {
    if (playingLockId === null && audioQueue.length > 0) {
      setPlayingLockId(audioQueue[0]);
      setAudioQueue(q => q.slice(1));
    }
  }, [playingLockId, audioQueue]);

  // Imperatively play when playingLockId is set — more reliable than autoPlay.
  useEffect(() => {
    if (!playingLockId || !lockAudioRef.current) return;
    const el = lockAudioRef.current;
    el.src = `${API}/api/calls/${playingLockId}/audio`;
    el.load();
    el.play().catch(() => setPlayingLockId(null));
  }, [playingLockId]);

  const sys          = systems.find(s => s.sysid === sysid);
  const emergency    = active.filter(c => c.emergency);
  const visibleActive = scanList.size > 0 ? active.filter(c => scanList.has(String(c.tgid))) : active;
  const visibleCalls  = scanList.size > 0 ? calls.filter(c => scanList.has(String(c.tgid)))  : calls;
  const sortedActive  = [...visibleActive].sort((a, b) => (b.emergency ? 1 : 0) - (a.emergency ? 1 : 0));

  // ── Render pages ──────────────────────────────────────────────────────────
  const renderPage = () => {
    switch (page) {

      case 'Dashboard': return (
        <div className="page">
          <div className="stat-row">
            <Stat label="ACTIVE CALLS" value={active.length} />
            <Stat label="EMERGENCIES"  value={emergency.length} alert={emergency.length > 0} />
            <Stat label="CALLS / 24H"  value={sys?.calls_today ?? '—'} />
            <Stat label="CALLS / HOUR" value={sys?.calls_hour  ?? '—'} />
            <div className="stat-spark">
              <div className="stat-box__label mono dim">24H CALL RATE</div>
              <Sparkline data={spark} />
            </div>
          </div>

          {/* Active calls */}
          <div className="section-label mono">ACTIVE CALLS
            {visibleActive.length > 0 && <span className="section-count">{visibleActive.length}</span>}
            {scanList.size > 0 && <span className="section-count" style={{ background: 'var(--green-dim)', color: 'var(--green)' }}>SCAN {scanList.size}</span>}
          </div>
          {sortedActive.length === 0 ? (
            <div className="scanning mono dim">— SCANNING —</div>
          ) : (
            <div className="card-grid">
              {sortedActive.map(c => {
                const isLocked = lockedTg?.sysid === c.sysid && lockedTg?.tgid === c.tgid;
                return (
                  <CallCard key={`${c.sysid}-${c.tgid}`} call={c} sources={sysDetail?.sdr_sources_json}
                    onLock={isLocked ? unlockTg : lockTg} isLocked={isLocked} />
                );
              })}
            </div>
          )}

          {/* Recent calls */}
          <div className="section-label mono" style={{ marginTop: 32 }}>RECENT CALLS</div>
          <Tbl cols={['Time', 'Talkgroup', 'Group', 'Freq', 'Dur', 'Flags', '']}
            empty={visibleCalls.length === 0 ? 'no calls recorded' : null}>
            {visibleCalls.slice(0, 50).map(c =>
              <CallRow key={c.id} call={c} onAudio={setAudioCallId} sources={sysDetail?.sdr_sources_json} />
            )}
          </Tbl>
        </div>
      );

      case 'Call Log': return (
        <div className="page">
          <div className="section-label mono">CALL LOG
            <span className="section-count">{visibleCalls.length}</span>
            {scanList.size > 0 && <span className="section-count" style={{ background: 'var(--green-dim)', color: 'var(--green)' }}>SCAN {scanList.size}</span>}
          </div>
          <Tbl cols={['Time', 'Talkgroup', 'Group', 'Freq', 'Dur', 'Flags', '']}
            empty={visibleCalls.length === 0 ? 'no calls recorded' : null}>
            {visibleCalls.map(c => <CallRow key={c.id} call={c} onAudio={setAudioCallId} sources={sysDetail?.sdr_sources_json} />)}
          </Tbl>
        </div>
      );

      case 'Talkgroups': {
        const activeTGs = tgActiveOnly ? talkgroups.filter(t => t.call_count > 0) : talkgroups;
        const groups    = [...new Set(activeTGs.map(t => t.group_tag).filter(Boolean))].sort();
        const srch      = tgSearch.toLowerCase();
        const visibleTGs = activeTGs.filter(t => {
          if (tgGroupFilter && t.group_tag !== tgGroupFilter) return false;
          if (srch && !(
            (t.alpha_tag   || '').toLowerCase().includes(srch) ||
            (t.description || '').toLowerCase().includes(srch) ||
            String(t.tgid).includes(srch)
          )) return false;
          return true;
        });
        return (
          <div className="page">
            <div className="section-label mono" style={{ marginBottom: 8 }}>TALKGROUPS
              <span className="section-count">{visibleTGs.length}/{talkgroups.length}</span>
              {scanList.size > 0 && (
                <>
                  <span className="section-count" style={{ background: 'var(--green-dim)', color: 'var(--green)' }}>
                    {scanList.size} scanning
                  </span>
                  <button className="btn btn-ghost" style={{ marginLeft: 8, padding: '1px 8px', fontSize: '0.692rem' }}
                    onClick={clearScan}>CLEAR SCAN</button>
                </>
              )}
            </div>
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <input className="input-field" placeholder="Search name / TGID…"
                value={tgSearch} onChange={e => setTgSearch(e.target.value)}
                style={{ minWidth: 180 }} />
              <select className="input-field" value={tgGroupFilter}
                onChange={e => setTgGroupFilter(e.target.value)}>
                <option value="">All groups</option>
                {groups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
              <button className={`btn ${tgActiveOnly ? 'btn-active' : 'btn-ghost'}`}
                onClick={() => { setTgActiveOnly(v => !v); setTgGroupFilter(''); }}>
                ACTIVE ONLY
              </button>
              {(tgSearch || tgGroupFilter) && (
                <button className="btn btn-ghost" onClick={() => { setTgSearch(''); setTgGroupFilter(''); }}>
                  CLEAR
                </button>
              )}
              <button className={`btn ${rrSync === 'syncing' ? 'btn-ghost' : 'btn-ghost'}`}
                style={{ marginLeft: 'auto' }}
                onClick={syncRR} disabled={rrSync === 'syncing'}>
                {rrSync === 'syncing' ? '⟳ SYNCING…' : '↓ SYNC RR'}
              </button>
              {rrSync && rrSync !== 'syncing' && (
                <span className="mono xs" style={{ color: rrSync.error ? 'var(--red)' : 'var(--green)' }}>
                  {rrSync.error ? `✗ ${rrSync.error}` : `✓ ${rrSync.total} talkgroups`}
                </span>
              )}
            </div>
            {scanList.size === 0 && (
              <div className="mono dim xs" style={{ marginBottom: 8 }}>Click a row to add it to your scan list — unselected talkgroups will be muted everywhere.</div>
            )}
            <Tbl cols={['Name', 'TGID', 'Group', 'Description', 'Calls', 'Last Active', '']}
              empty={talkgroups.length === 0 ? 'no talkgroups — use ↓ SYNC RR to import' : visibleTGs.length === 0 ? 'no matches' : null}>
              {visibleTGs.map(t => (
                <TGRow key={t.id} tg={t}
                  inScan={scanList.has(String(t.tgid))}
                  onToggle={toggleScan}
                  scanActive={scanList.size > 0} />
              ))}
            </Tbl>
          </div>
        );
      }

      case 'Units': return (
        <div className="page">
          <div className="section-label mono">UNIT ACTIVITY
            <span className="section-count">{units.length}</span>
          </div>
          <Tbl cols={['Unit ID', 'Last TG', 'Group', 'Freq', 'Calls', 'Last Seen']}
            empty={units.length === 0 ? 'no units observed yet' : null}>
            {units.map(u => <UnitRow key={u.id} unit={u} />)}
          </Tbl>
        </div>
      );

      case 'Site Info': return <SiteInfoPage detail={sysDetail} />;

      default: return null;
    }
  };

  return (
    <div className="app">
      <Nav page={page} setPage={setPage} connected={connected}
        activeCount={active.length} emergencyCount={emergency.length}
        theme={theme} toggleTheme={toggleTheme}
        fontSize={fontSize} cycleFontSize={cycleFontSize} />
      <SysBar systems={systems} sysid={sysid} setSysid={setSysid} />
      {lockedTg && (
        <TgLockBar lockedTg={lockedTg} queueLen={audioQueue.length}
          isPlaying={!!playingLockId} onStop={unlockTg} />
      )}
      {renderPage()}
      {lockedTg && (
        <audio ref={lockAudioRef} style={{ display: 'none' }}
          onEnded={() => setPlayingLockId(null)}
          onError={() => setPlayingLockId(null)} />
      )}
      {audioCallId && <AudioBar callId={audioCallId} onClose={() => setAudioCallId(null)} />}
    </div>
  );
}
