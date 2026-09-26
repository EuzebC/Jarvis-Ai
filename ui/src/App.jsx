import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectLive, disconnectLive, useData, SignedOut } from './api.js';
import { THEMES, applyPalette } from './theme.js';
import { voice } from './voice.js';
import { live } from './live.js';
import Reactor, { MiniCore, Wave } from './components/Reactor.jsx';
import { Icon, Toasts, toast } from './components/ui.jsx';
import { OrgHome, PersonalHome } from './screens/Home.jsx';
import OrgMap from './screens/OrgMap.jsx';
import Department from './screens/Department.jsx';
import Team from './screens/Team.jsx';
import TaskView from './screens/Task.jsx';
import Approvals from './screens/Approvals.jsx';
import Mind from './screens/Mind.jsx';
import Settings from './screens/Settings.jsx';
import { NewOrg, StructureReview } from './screens/Setup.jsx';
import Project from './screens/Project.jsx';
import Flow from './screens/Flow.jsx';

const desktop = typeof window !== 'undefined' && window.jarvisDesktop;
export const go = (path) => {
  location.hash = `#${path}`;
};

function useRoute() {
  const read = () => {
    const [, view = '', idStr] = location.hash.replace(/^#/, '').split('/');
    return { view, id: idStr && /^\d+$/.test(idStr) ? Number(idStr) : null, param: idStr ?? null };
  };
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

// ---------- sign in ----------
function Login({ setupRequired, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      if (setupRequired) {
        if (pw !== pw2) throw new Error('The passwords do not match');
        await api('POST', '/api/setup', { password: pw });
      } else await api('POST', '/api/login', { password: pw });
      onDone();
    } catch (ex) {
      setErr(ex.message);
    }
  };
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
      <form onSubmit={submit} className="col" style={{ width: 360, alignItems: 'center', gap: 16 }}>
        <Reactor size={260} compass={false} />
        <div className="brand">
          <b>JARVIS</b>
          <small>JUST A RATHER VERY INTELLIGENT SYSTEM</small>
        </div>
        {setupRequired && <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>Welcome. Choose a password to protect Jarvis.</p>}
        <label className="field" style={{ width: '100%' }}>
          <span>{setupRequired ? 'New password' : 'Password'}</span>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus required minLength={setupRequired ? 8 : 1} />
        </label>
        {setupRequired && (
          <label className="field" style={{ width: '100%' }}>
            <span>Repeat password</span>
            <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
          </label>
        )}
        {err && <div className="toast bad" style={{ position: 'static', transform: 'none' }}>{err}</div>}
        <button className="btn primary" style={{ width: '100%' }}>
          {setupRequired ? 'Create password' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// ---------- workspace picker ----------
function OrgPicker({ orgs, orgId, onPick, open, setOpen }) {
  const [q, setQ] = useState('');
  const current = orgs.find((o) => o.id === orgId);
  const list = orgs.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="btn" onClick={() => setOpen(!open)} aria-expanded={open} style={{ textTransform: 'none', letterSpacing: 0 }}>
        <span className="dot" style={{ background: current?.color, boxShadow: `0 0 8px ${current?.color}` }} />
        {current?.name ?? 'Choose organisation'}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="panel hot" style={{ position: 'absolute', top: 44, left: 0, zIndex: 40, width: 320, padding: 0, background: 'var(--bg)' }}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
            <input className="input" placeholder="Switch to…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search organisations" />
          </div>
          <div className="label" style={{ padding: '10px 12px 4px' }}>
            Organisations
          </div>
          {list.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onPick(o.id)}
              className="row"
              style={{ width: '100%', padding: '10px 12px', background: o.id === orgId ? 'rgba(var(--p-rgb),0.1)' : 'none', border: 0, color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ width: 10, height: 10, background: o.color }} />
              <span className="grow">{o.name}</span>
              {o.pending > 0 && <span className="mono small" style={{ color: 'var(--warn)' }}>{o.pending} NEED YOU</span>}
              {o.working > 0 && <span className="mono small">{o.working} LIVE</span>}
            </button>
          ))}
          <div style={{ padding: 10 }}>
            <button type="button" className="btn" style={{ width: '100%' }} onClick={() => (setOpen(false), go('/new-org'))}>
              + New organisation
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Ask Jarvis (typed or spoken) ----------
export function useAsk(orgId) {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState(null);
  const ask = useCallback(
    async (text, speak = false) => {
      if (!text.trim()) return;
      setBusy(true);
      setReply(null);
      // Spoken requests get a short acknowledgement before the real answer, so there is never a silent wait.
      const ack = speak ? setTimeout(() => voice.speak('On it.'), 1800) : null;
      try {
        const r = await api('POST', '/api/ask', { text, org_id: orgId, spoken: speak });
        clearTimeout(ack);
        setReply(r);
        if (speak) voice.speak(r.reply);
      } catch (e) {
        clearTimeout(ack);
        if (!(e instanceof SignedOut)) toast(e.message, true);
      } finally {
        setBusy(false);
      }
    },
    [orgId],
  );
  return { busy, reply, ask, setReply };
}

function CommandOverlay({ orgId, onClose, voiceState, speak, liveMode = false, liveState = 'off', core = 'reactor' }) {
  const { busy, reply, ask } = useAsk(orgId);
  const [text, setText] = useState('');
  const [partial, setPartial] = useState('');
  const [lines, setLines] = useState([]);
  const [current, setCurrent] = useState({ you: '', jarvis: '' });
  const [tool, setTool] = useState(null);
  useEffect(() => {
    if (!liveMode) return undefined;
    const onLines = (e) => (setLines(e.detail), setCurrent({ you: '', jarvis: '' }));
    const onTranscript = (e) => setCurrent((c) => ({ ...c, [e.detail.who]: e.detail.text }));
    const onTool = (e) => setTool(e.detail.request ? `Asking Jarvis: ${e.detail.request}` : null);
    live.addEventListener('lines', onLines);
    live.addEventListener('transcript', onTranscript);
    live.addEventListener('tool', onTool);
    return () => {
      live.removeEventListener('lines', onLines);
      live.removeEventListener('transcript', onTranscript);
      live.removeEventListener('tool', onTool);
    };
  }, [liveMode]);
  const liveOn = liveMode && live.state !== 'off';
  useEffect(() => {
    const onPartial = (e) => setPartial(e.detail);
    const onCommand = (e) => {
      setPartial('');
      setText(e.detail);
      ask(e.detail, speak);
    };
    voice.addEventListener('partial', onPartial);
    voice.addEventListener('command', onCommand);
    return () => {
      voice.removeEventListener('partial', onPartial);
      voice.removeEventListener('command', onCommand);
    };
  }, [ask, speak]);
  const state = liveOn ? (liveState === 'thinking' || liveState === 'connecting' ? 'thinking' : liveState === 'speaking' ? 'speaking' : 'listening') : busy ? 'thinking' : voiceState === 'speaking' ? 'speaking' : 'listening';
  const label = liveOn ? { connecting: 'CONNECTING', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', error: 'VOICE ERROR' }[liveState] ?? 'READY' : busy ? 'THINKING' : voiceState === 'command' ? 'LISTENING' : voiceState === 'speaking' ? 'SPEAKING' : 'READY';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 640, alignItems: 'center' }} role="dialog" aria-label="Ask Jarvis">
        <Reactor size={240} compass={false} state={state} kind={core} />
        <div className="row mono" style={{ letterSpacing: '0.3em', color: liveState === 'error' ? 'var(--bad)' : 'var(--p)' }}>
          <span className="dot working" />
          {label}
        </div>
        <Wave active={liveOn ? liveState === 'speaking' || liveState === 'listening' : voiceState === 'command' || voiceState === 'speaking'} />
        {liveMode && liveState === 'error' && <div className="small" style={{ color: 'var(--bad)' }}>{live.message}</div>}
        {partial && <div className="muted mono">{partial}…</div>}
        {liveOn && (lines.length > 0 || current.you || current.jarvis || tool) && (
          <div className="col small" style={{ width: '100%', gap: 4, maxHeight: 180, overflow: 'auto' }}>
            {lines.map((l, i) => (
              <div key={i} className={l.who === 'you' ? 'muted' : ''}>
                <b>{l.who === 'you' ? 'You' : 'Jarvis'}:</b> {l.text}
              </div>
            ))}
            {current.you && (
              <div className="muted">
                <b>You:</b> {current.you}
              </div>
            )}
            {current.jarvis && (
              <div>
                <b>Jarvis:</b> {current.jarvis}
              </div>
            )}
            {tool && liveState === 'thinking' && <div className="faint mono">{tool}</div>}
          </div>
        )}
        <form
          className="row"
          style={{ width: '100%' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (liveOn && live.sendText(text)) setText('');
            else ask(text, speak && voice.state !== 'off');
          }}
        >
          <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask or tell Jarvis anything…" autoFocus aria-label="Command" />
          <button className="btn primary" disabled={busy}>
            Send
          </button>
        </form>
        {reply && (
          <div className="panel" style={{ width: '100%' }}>
            <div className="label">Jarvis</div>
            <p style={{ margin: '6px 0 0' }}>{reply.reply}</p>
            {reply.tasks?.length > 0 && <div className="small muted">Created {reply.tasks.length} task(s).</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- the app ----------
export default function App() {
  const [me, setMe] = useState(null);
  const route = useRoute();
  const [workspace, setWorkspace] = useState(() => localStorage.getItem('jarvis.workspace') || 'org');
  const [orgId, setOrgId] = useState(() => Number(localStorage.getItem('jarvis.org')) || null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [voiceState, setVoiceState] = useState('off');
  const [liveState, setLiveState] = useState('off');
  const activateRef = useRef(null);
  const [clock, setClock] = useState(() => new Date());
  const [retintColor, setRetintColor] = useState(null);

  const loadMe = useCallback(() => api('GET', '/api/me').then(setMe).catch(() => setMe({ authenticated: false })), []);
  useEffect(() => {
    loadMe();
    const out = () => setMe((m) => ({ ...m, authenticated: false }));
    window.addEventListener('jarvis:signed-out', out);
    return () => window.removeEventListener('jarvis:signed-out', out);
  }, [loadMe]);

  const authed = me?.authenticated;
  useEffect(() => {
    if (!authed) return undefined;
    connectLive();
    return disconnectLive;
  }, [authed]);

  const settings = useData(authed ? '/api/settings' : null);
  const orgs = useData(authed ? '/api/orgs' : null);
  const overview = useData(authed ? `/api/overview${workspace === 'org' && orgId ? `?org=${orgId}` : ''}` : null, [workspace, orgId]);

  // Keep a valid organisation selected.
  useEffect(() => {
    const list = orgs.data;
    if (!list) return;
    if (list.length && !list.some((o) => o.id === orgId)) setOrgId(list[0].id);
  }, [orgs.data, orgId]);
  useEffect(() => {
    localStorage.setItem('jarvis.workspace', workspace);
    if (orgId) localStorage.setItem('jarvis.org', String(orgId));
  }, [workspace, orgId]);

  // Theme, retinted to the department colour when inside a department or team.
  const theme = THEMES[settings.data?.theme] ?? THEMES.green;
  const retintOn = settings.data?.retint !== false;
  const inside = route.view === 'dept' || route.view === 'team';
  useEffect(() => {
    const primary = inside && retintOn && retintColor ? retintColor : theme.p;
    applyPalette(primary, inside && retintOn && retintColor ? '#ffd23f' : theme.s);
    desktop?.setThemeColor?.(primary);
  }, [inside, retintOn, retintColor, theme.p, theme.s]);
  useEffect(() => {
    if (!inside) setRetintColor(null);
  }, [inside]);

  // Voice: wake word + Ctrl+Space, and the Gemini Live session when that engine is chosen.
  useEffect(() => {
    const on = (e) => setVoiceState(e.detail.state);
    const onWake = () => activateRef.current?.();
    const onLive = (e) => {
      setLiveState(e.detail.state);
      if (e.detail.state === 'off' || e.detail.state === 'error') voice.resume();
      else voice.pause();
    };
    voice.addEventListener('state', on);
    voice.addEventListener('wake', onWake);
    live.addEventListener('state', onLive);
    return () => {
      voice.removeEventListener('state', on);
      voice.removeEventListener('wake', onWake);
      live.removeEventListener('state', onLive);
    };
  }, []);
  useEffect(() => {
    if (!commandOpen && live.active) live.stop();
  }, [commandOpen]);
  useEffect(() => {
    if (!authed || !settings.data) return;
    if (settings.data.voice_wake && voice.state === 'off') voice.start({ wake: true });
    if (!settings.data.voice_wake && voice.state !== 'off') voice.stop();
  }, [authed, settings.data]);
  const liveMode = settings.data?.voice_engine === 'gemini' && Boolean(settings.data?.geminiKeySet);
  const activate = useCallback(() => {
    setCommandOpen(true);
    if (liveMode) {
      if (!live.active) live.start({ orgId: workspace === 'org' ? orgId : null });
      return;
    }
    if (voice.state === 'off') voice.start({ wake: settings.data?.voice_wake ?? false }).then(() => voice.listenForCommand());
    else voice.listenForCommand();
  }, [settings.data, liveMode, workspace, orgId]);
  activateRef.current = activate;
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        activate();
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPickerOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    const off = desktop?.onVoiceActivate?.(activate);
    return () => {
      window.removeEventListener('keydown', onKey);
      off?.();
    };
  }, [activate]);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  const pickOrg = (id) => {
    setOrgId(id);
    setWorkspace('org');
    setPickerOpen(false);
    go('/');
  };

  const ctx = useMemo(
    () => ({ orgId: workspace === 'org' ? orgId : null, workspace, settings: settings.data, overview: overview.data, orgs: orgs.data ?? [], voiceState, activate, setRetintColor }),
    [workspace, orgId, settings.data, overview.data, orgs.data, voiceState, activate],
  );

  if (!me) return null;
  if (!authed) return <Login setupRequired={me.setupRequired} onDone={loadMe} />;

  const org = orgs.data?.find((o) => o.id === orgId);
  // The badge counts what needs you: money decisions and connectors with messages waiting.
  const pending = (overview.data?.pendingTotal ?? 0) + (overview.data?.connectorsNeeded?.length ?? 0);
  const v = route.view;
  const needsOrg = workspace === 'org' && orgs.data && !orgs.data.length && v !== 'new-org';

  let screen;
  if (needsOrg || v === 'new-org') screen = <NewOrg ctx={ctx} onCreated={pickOrg} />;
  else if (v === 'setup') screen = <StructureReview ctx={ctx} orgId={route.id} />;
  else if (v === 'map') screen = <OrgMap ctx={ctx} />;
  else if (v === 'dept') screen = <Department ctx={ctx} id={route.id} />;
  else if (v === 'team') screen = <Team ctx={ctx} id={route.id} />;
  else if (v === 'task') screen = <TaskView id={route.id} />;
  else if (v === 'project') screen = <Project ctx={ctx} id={route.id} />;
  else if (v === 'approvals') screen = <Approvals ctx={ctx} />;
  else if (v === 'flow') screen = <Flow ctx={ctx} deptId={route.id} />;
  else if (v === 'mind') screen = <Mind ctx={ctx} />;
  else if (v === 'settings') screen = <Settings ctx={ctx} reload={settings.reload} focus={route.param} />;
  else screen = workspace === 'personal' ? <PersonalHome ctx={ctx} /> : <OrgHome ctx={ctx} />;

  const nav = (name, path, label, extra) => (
    <button type="button" className={`iconbtn ${v === path.replace('/', '') ? 'on' : ''}`} onClick={() => go(path)} aria-label={label} title={label}>
      <Icon name={name} />
      {extra}
    </button>
  );

  return (
    <div className="app">
      <header className={`topbar ${desktop ? 'desktop' : ''}`}>
        <button type="button" className="iconbtn core" style={{ width: 46, height: 46 }} onClick={() => go('/')} aria-label="Home">
          <MiniCore size={40} />
        </button>
        <div className="seg" role="tablist" aria-label="Workspace">
          {['personal', 'org'].map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={workspace === w}
              className={workspace === w ? 'on' : ''}
              onClick={() => {
                setWorkspace(w);
                go('/');
              }}
            >
              {w === 'org' ? 'ORGANISATION' : 'PERSONAL'}
            </button>
          ))}
        </div>
        {workspace === 'org' && orgs.data?.length > 0 && <OrgPicker orgs={orgs.data} orgId={orgId} onPick={pickOrg} open={pickerOpen} setOpen={setPickerOpen} />}
        <div className="spacer" />
        <div className="brand" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', pointerEvents: 'none' }}>
          <b>JARVIS</b>
          <small>{workspace === 'personal' ? 'PERSONAL WORKSPACE' : org ? org.name.toUpperCase() : 'JUST A RATHER VERY INTELLIGENT SYSTEM'}</small>
        </div>
        <nav className="navicons" aria-label="Sections">
          {nav('home', '/', 'Home')}
          {workspace === 'org' && nav('map', '/map', 'Organisation map')}
          {workspace === 'org' && nav('flow', '/flow', 'Flow: how it works')}
          {nav('approvals', '/approvals', 'Outbox', pending > 0 && <span className="badge">{pending}</span>)}
          {nav('mind', '/mind', 'Mind: memories and files')}
          {nav('settings', '/settings', 'Settings')}
          <button type="button" className="iconbtn" onClick={activate} aria-label="Talk to Jarvis (Ctrl+Space)" title="Talk to Jarvis (Ctrl+Space)" style={{ color: voiceState === 'listening' || voiceState === 'command' ? 'var(--p)' : undefined }}>
            <Icon name="mic" />
          </button>
        </nav>
        <div className="clock" aria-label="Time">
          {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </header>
      <main className="page">{screen}</main>
      {commandOpen && (
        <CommandOverlay liveMode={liveMode} liveState={liveState} core={settings.data?.core ?? 'reactor'}
          orgId={ctx.orgId}
          voiceState={voiceState}
          speak={settings.data?.voice_speak !== false}
          onClose={() => {
            setCommandOpen(false);
            voice.cancelCommand();
          }}
        />
      )}
      <Toasts />
    </div>
  );
}
