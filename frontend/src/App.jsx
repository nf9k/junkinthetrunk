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
const PAGES = ['Dashboard', 'Call Log', 'Talkgroups', 'Units'];

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
  }, [sysid, page]);

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
