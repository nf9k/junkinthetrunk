import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const API    = import.meta.env.VITE_API_URL || '';
const socket = io(API, { transports: ['websocket', 'polling'] });

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmtFreq = (hz) => hz ? `${(hz / 1e6).toFixed(4)}` : '—';
const fmtDur  = (s)  => s != null ? `${parseFloat(s).toFixed(1)}s` : '—';
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtAge  = (ts) => {
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h`;
};

const GROUP_COLOR = (tag) => {
  if (!tag) return 'var(--amber)';
  const t = tag.toLowerCase();
  if (t.includes('fire'))                         return '#ff5c35';
  if (t.includes('ems') || t.includes('medic'))   return '#ff9900';
  if (t.includes('law') || t.includes('police') || t.includes('sheriff')) return '#4a9eff';
  if (t.includes('works') || t.includes('util'))  return '#7ed957';
  if (t.includes('admin') || t.includes('ops'))   return '#c084fc';
  return 'var(--amber)';
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
function CallCard({ call }) {
  const color = call.emergency ? 'var(--red)' : call.encrypted ? '#c084fc' : GROUP_COLOR(call.group_tag);

  return (
    <div className={`call-card${call.emergency ? ' call-card--emrg' : ''}`}
      style={{ '--card-color': color }}>
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
      </div>
    </div>
  );
}

// ── Call Log Row ──────────────────────────────────────────────────────────────
function CallRow({ call, onAudio }) {
  const color = call.emergency ? 'var(--red)' : call.encrypted ? '#c084fc' : GROUP_COLOR(call.group_tag);
  return (
    <tr className="tbl-row">
      <td className="mono dim xs">{fmtTime(call.start_time)}</td>
      <td>
        <span style={{ color, fontFamily: 'var(--font-display)', fontSize: 15, letterSpacing: '0.05em' }}>
          {call.alpha_tag || `TG ${call.tgid}`}
        </span>
        <span className="mono dim xs" style={{ marginLeft: 8 }}>{call.tgid}</span>
      </td>
      <td className="mono dim xs">{call.group_tag || '—'}</td>
      <td className="mono dim xs">{fmtFreq(call.freq)} <span className="dim" style={{fontSize:10}}>MHz</span></td>
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
function TGRow({ tg }) {
  const color = GROUP_COLOR(tg.group_tag);
  return (
    <tr className="tbl-row">
      <td>
        <span style={{ color, fontFamily: 'var(--font-display)', fontSize: 15, letterSpacing: '0.05em' }}>
          {tg.alpha_tag || `TG ${tg.tgid}`}
        </span>
      </td>
      <td className="mono dim xs">{tg.tgid}</td>
      <td className="mono dim xs">{tg.group_tag || '—'}</td>
      <td className="mono dim xs">{tg.description || '—'}</td>
      <td className="mono xs" style={{ color: 'var(--amber)' }}>{tg.call_count || 0}</td>
      <td className="mono dim xs">{tg.last_active ? fmtTime(tg.last_active) : '—'}</td>
      <td>{tg.encrypted && <span className="badge badge--enc">ENC</span>}</td>
    </tr>
  );
}

// ── Unit Row ──────────────────────────────────────────────────────────────────
function UnitRow({ unit }) {
  return (
    <tr className="tbl-row">
      <td className="mono" style={{ color: 'var(--amber)', fontSize: 13 }}>{unit.unit_id}</td>
      <td className="mono dim xs">{unit.last_tg_name || unit.last_tgid || '—'}</td>
      <td className="mono dim xs">{unit.group_tag || '—'}</td>
      <td className="mono dim xs">{fmtFreq(unit.last_freq)} {unit.last_freq ? <span style={{fontSize:10}}>MHz</span> : ''}</td>
      <td className="mono xs" style={{ color: 'var(--amber)' }}>{unit.call_count || 0}</td>
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

// ── Nav ───────────────────────────────────────────────────────────────────────
const PAGES = ['Dashboard', 'Call Log', 'Talkgroups', 'Units', 'Site Info'];

function Nav({ page, setPage, connected, activeCount, emergencyCount, theme, toggleTheme }) {
  return (
    <nav className="nav">
      <div className="nav__brand">
        <div className={`nav__dot${connected ? ' nav__dot--live' : ''}`} />
        <span className="nav__title">JUNK IN THE TRUNK</span>
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
      <span className="mono dim" style={{ fontSize: 10, marginRight: 10 }}>SYSTEM</span>
      {systems.map(s => (
        <button key={s.sysid}
          className={`sys-btn${sysid === s.sysid ? ' sys-btn--active' : ''}`}
          onClick={() => setSysid(s.sysid)}>
          {s.short_name || s.name || s.sysid}
          <span className="mono" style={{ marginLeft: 6, fontSize: 9, opacity: 0.5 }}>{s.sysid}</span>
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

function SiteCard({ site, isCurrent }) {
  const ctrl = site.control_freqs || [];
  const voice = site.voice_freqs || [];
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
        <div className="site-card__channels-label mono dim xs">
          CONTROL · {ctrl.length}
        </div>
        <div className="freq-chips">
          {ctrl.map((hz, i) => (
            <span key={hz} className={`freq-chip freq-chip--ctrl${i === 0 ? ' freq-chip--primary' : ''}`}>
              {fmtFreq(hz)}
            </span>
          ))}
        </div>

        <div className="site-card__channels-label mono dim xs" style={{ marginTop: 8 }}>
          VOICE · {voice.length}
        </div>
        <div className="freq-chips">
          {voice.map(hz => (
            <span key={hz} className="freq-chip">{fmtFreq(hz)}</span>
          ))}
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
                isCurrent={currentSite === site.site_id} />
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
  const [audioCallId, setAudioCallId] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('jitr-theme') || 'night');
  const sysidRef = useRef(sysid);
  useEffect(() => { sysidRef.current = sysid; }, [sysid]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('jitr-theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme(t => t === 'day' ? 'night' : 'day');

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

    socket.on('call:end', ({ sysid: sid, tgid }) => {
      setActive(prev => prev.filter(c => !(c.sysid === sid && c.tgid === tgid)));
      // Silently refresh call log if we're on that page
      if (sysidRef.current) fetchCalls(sysidRef.current);
    });

    return () => {
      socket.off('connect'); socket.off('disconnect');
      socket.off('active:snapshot'); socket.off('call:start'); socket.off('call:end');
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

  // Load data when system or page changes
  useEffect(() => {
    if (!sysid) return;
    fetchSpark(sysid);
    if (page === 'Dashboard')  fetchCalls(sysid);
    if (page === 'Call Log')   fetchCalls(sysid);
    if (page === 'Talkgroups') fetchTalkgroups(sysid);
    if (page === 'Units')      fetchUnits(sysid);
    if (page === 'Site Info')  fetchSysDetail(sysid);
  }, [sysid, page]);

  // Site Info realtime fields (current CC, decode rate, recorders) — poll every 3s.
  useEffect(() => {
    if (page !== 'Site Info' || !sysid) return;
    const t = setInterval(() => fetchSysDetail(sysid), 3000);
    return () => clearInterval(t);
  }, [page, sysid, fetchSysDetail]);

  const sys          = systems.find(s => s.sysid === sysid);
  const emergency    = active.filter(c => c.emergency);
  const sortedActive = [...active].sort((a, b) => (b.emergency ? 1 : 0) - (a.emergency ? 1 : 0));

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
            {active.length > 0 && <span className="section-count">{active.length}</span>}
          </div>
          {active.length === 0 ? (
            <div className="scanning mono dim">— SCANNING —</div>
          ) : (
            <div className="card-grid">
              {sortedActive.map(c => <CallCard key={`${c.sysid}-${c.tgid}`} call={c} />)}
            </div>
          )}

          {/* Recent calls */}
          <div className="section-label mono" style={{ marginTop: 32 }}>RECENT CALLS</div>
          <Tbl cols={['Time', 'Talkgroup', 'Group', 'Freq', 'Dur', 'Flags', '']}
            empty={calls.length === 0 ? 'no calls recorded' : null}>
            {calls.slice(0, 50).map(c =>
              <CallRow key={c.id} call={c} onAudio={setAudioCallId} />
            )}
          </Tbl>
        </div>
      );

      case 'Call Log': return (
        <div className="page">
          <div className="section-label mono">CALL LOG
            <span className="section-count">{calls.length}</span>
          </div>
          <Tbl cols={['Time', 'Talkgroup', 'Group', 'Freq', 'Dur', 'Flags', '']}
            empty={calls.length === 0 ? 'no calls recorded' : null}>
            {calls.map(c => <CallRow key={c.id} call={c} onAudio={setAudioCallId} />)}
          </Tbl>
        </div>
      );

      case 'Talkgroups': return (
        <div className="page">
          <div className="section-label mono">TALKGROUPS
            <span className="section-count">{talkgroups.length}</span>
          </div>
          <Tbl cols={['Name', 'TGID', 'Group', 'Description', 'Calls', 'Last Active', '']}
            empty={talkgroups.length === 0 ? 'no talkgroups — import a CSV via API' : null}>
            {talkgroups.map(t => <TGRow key={t.id} tg={t} />)}
          </Tbl>
        </div>
      );

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
        theme={theme} toggleTheme={toggleTheme} />
      <SysBar systems={systems} sysid={sysid} setSysid={setSysid} />
      {renderPage()}
      {audioCallId && <AudioBar callId={audioCallId} onClose={() => setAudioCallId(null)} />}
    </div>
  );
}
