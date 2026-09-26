import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { THEMES, CORES } from '../theme.js';
import Reactor from '../components/Reactor.jsx';
import { Switch, toast } from '../components/ui.jsx';
import { voice } from '../voice.js';
import Connectors from './Connectors.jsx';
import RemoteCard from './RemoteCard.jsx';

const desktop = window.jarvisDesktop;

const LEVELS = [
  ['payments', 'Payments only', 'Jarvis sends first contacts, proposals and posts itself, and handles contracts and deletions on its own judgement. Only money waits for you.'],
  ['money', 'Money, contracts and deletions', 'Every message is sent automatically; contracts and deleting data wait for you.'],
  ['first_contact', 'Money, contracts, deletions and first contacts', 'The first message to a new contact waits for you (or the team leader when that switch is on).'],
];

export default function Settings({ ctx, reload, focus = null }) {
  const s = ctx.settings;
  const login = useData('/api/engines/login');
  const [apiKey, setApiKey] = useState('');
  const [gemKey, setGemKey] = useState('');
  const [cap, setCap] = useState('');
  const [autoStart, setAutoStart] = useState(null);
  useEffect(() => {
    desktop?.getAutoStart?.().then(setAutoStart);
  }, []);
  useEffect(() => {
    if (s) setCap(String(s.apiCap));
  }, [s]);
  if (!s) return null;
  const save = (patch, msg = 'Saved') => api('PUT', '/api/settings', patch).then(() => (reload(), toast(msg)));
  const signedIn = (probe) => probe?.ok && !/not (logged|signed)|log ?in required/i.test(probe.out);

  return (
    <div className="page-pad col" style={{ gap: 18, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 28 }}>SETTINGS</h1>

      <section className="col" style={{ gap: 10 }}>
        <span className="label">▶ Colour theme</span>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          {Object.entries(THEMES).map(([key, t]) => (
            <button
              key={key}
              type="button"
              onClick={() => save({ theme: key }, `${t.name} theme`)}
              className="panel col"
              style={{ '--p': t.p, '--s': t.s, '--core': '#ffffff', '--line': `${t.p}44`, alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text)', borderColor: s.theme === key ? t.p : undefined, boxShadow: s.theme === key ? `0 0 18px ${t.p}55` : undefined }}
            >
              <Reactor size={110} compass={false} />
              <span style={{ fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '0.14em', color: t.p }}>{t.name.toUpperCase()}</span>
              <span className="small muted">{t.note}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="col" style={{ gap: 10 }}>
        <span className="label">▶ Core animation</span>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          {Object.entries(CORES).map(([key, c]) => (
            <button key={key} type="button" onClick={() => save({ core: key }, `${c.name} core`)} className={`panel col ${s.core === key ? 'hot' : ''}`} style={{ alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text)' }}>
              <Reactor size={110} compass={false} kind={key} agents={6} />
              <span style={{ fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '0.12em' }}>{c.name.toUpperCase()}</span>
              <span className="small muted">{c.note}</span>
            </button>
          ))}
        </div>
        <div className="panel row between">
          <div>
            <div>Retint to the department's colour</div>
            <div className="small muted">Inside a department or team, the whole interface takes on its colour so you always know where you are.</div>
          </div>
          <Switch checked={s.retint} label="Retint to department colour" onChange={(v) => save({ retint: v })} />
        </div>
      </section>

      <div className="grid g2" style={{ alignItems: 'start' }}>
        <section className="panel col" style={{ gap: 12 }}>
          <span className="label">▶ Voice</span>
          <div className="row between">
            <div>
              <div>Wake word “Jarvis”</div>
              <div className="small muted">Listens on this computer only. The speech model (about 40 MB) downloads the first time.</div>
            </div>
            <Switch checked={s.voice_wake} label="Wake word" onChange={(v) => save({ voice_wake: v }, v ? 'Listening for “Jarvis”' : 'Wake word off')} />
          </div>
          <div className="row between">
            <div>
              <div>Speak replies</div>
              <div className="small muted">Jarvis answers out loud when you talk to it.</div>
            </div>
            <Switch checked={s.voice_speak} label="Speak replies" onChange={(v) => save({ voice_speak: v })} />
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={() => voice.speak('Jarvis online. All systems ready.')}>
              Test voice
            </button>
            <span className="mono small muted">STATUS: {ctx.voiceState.toUpperCase()}</span>
          </div>
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
            <div>Voice engine</div>
            <label className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="radio" name="voice_engine" checked={(s.voice_engine ?? 'browser') === 'browser'} onChange={() => save({ voice_engine: 'browser' }, 'Offline voice')} style={{ marginTop: 4 }} />
              <span>
                <b>Offline (built in)</b> <span className="muted small">Local speech recognition and Windows voices. Answers come from Jarvis’s brain.</span>
              </span>
            </label>
            <label className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="radio" name="voice_engine" checked={s.voice_engine === 'gemini'} onChange={() => save({ voice_engine: 'gemini' }, s.geminiKeySet ? 'Gemini Live voice' : 'Gemini Live voice: add a key below')} style={{ marginTop: 4 }} />
              <span>
                <b>Gemini Live (real-time conversation)</b> <span className="muted small">A natural voice you can interrupt; it asks Jarvis’s brain for everything about the organisation. Needs a Gemini API key.</span>
              </span>
            </label>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                save({ geminiApiKey: gemKey }, 'Gemini key saved');
                setGemKey('');
              }}
            >
              <input className="input grow" type="password" value={gemKey} onChange={(e) => setGemKey(e.target.value)} placeholder={s.geminiKeySet ? 'Replace Gemini key…' : 'Gemini API key'} aria-label="Gemini API key" autoComplete="off" />
              <button className="btn" disabled={!gemKey}>
                Save key
              </button>
            </form>
            <div className="grid g2" style={{ gap: 8 }}>
              <label className="field">
                <span>Voice</span>
                <select className="input" value={s.gemini_voice} onChange={(e) => save({ gemini_voice: e.target.value }, `Voice: ${e.target.value}`)}>
                  {(s.gemini_voices ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Live model</span>
                <input className="input" defaultValue={s.gemini_live_model} onBlur={(e) => e.target.value.trim() && e.target.value !== s.gemini_live_model && save({ gemini_live_model: e.target.value }, 'Model saved')} />
              </label>
            </div>
            <div className="small faint" style={{ lineHeight: 1.6 }}>
              Create a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: 'var(--p)' }}>aistudio.google.com/apikey</a> and paste it here, never in a chat. It stays on this PC. {s.geminiKeySet ? 'Key set: press Ctrl+Space or say “Jarvis” to talk.' : ''}
            </div>
          </div>
          <div className="small faint">Shortcut: Ctrl+Space from anywhere{desktop ? ' (even when Jarvis is in the background)' : ''}.</div>
        </section>

        <section className="panel col" style={{ gap: 12 }}>
          <span className="label">▶ Engines</span>
          {['claude', 'codex'].map((name) => (
            <div key={name} className="row between">
              <div>
                <div>{name === 'claude' ? 'Claude Code (Claude subscription)' : 'Codex (ChatGPT subscription)'}</div>
                <div className="small" style={{ color: login.data ? (signedIn(login.data[name]) ? 'var(--ok)' : 'var(--warn)') : 'var(--faint)' }}>
                  {!login.data ? 'Checking…' : signedIn(login.data[name]) ? 'Signed in' : `Not signed in: run "${name === 'claude' ? 'claude' : 'codex login'}" once in a terminal`}
                </div>
              </div>
              <Switch checked={s[`${name}_enabled`]} label={`Use ${name}`} onChange={(v) => save({ [`${name}_enabled`]: v })} />
            </div>
          ))}
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
            <div>Anthropic API backup {s.apiKeySet && <span className="mono small" style={{ color: 'var(--ok)' }}>· KEY SET</span>}</div>
            <div className="small muted">Used only when both subscriptions are out of quota. Spent this month: ${s.apiSpent.toFixed(2)} of ${s.apiCap}.</div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                save({ anthropicApiKey: apiKey }, 'API key saved');
                setApiKey('');
              }}
            >
              <input className="input grow" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.apiKeySet ? 'Replace key…' : 'sk-ant-…'} aria-label="Anthropic API key" autoComplete="off" />
              <button className="btn" disabled={!apiKey}>
                Save key
              </button>
            </form>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                save({ apiCap: Number(cap) }, 'Monthly cap saved');
              }}
            >
              <label className="field grow">
                <span>Monthly spending cap (USD)</span>
                <input className="input" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" />
              </label>
              <button className="btn" style={{ marginTop: 20 }}>
                Save cap
              </button>
            </form>
          </div>
        </section>
      </div>

      <section className="panel col" style={{ gap: 12 }}>
        <span className="label">▶ Autonomy</span>
        <div className="row between">
          <div>
            <div>Jarvis runs the organisations itself</div>
            <div className="small muted">Every morning after 7:00 it plans the day and creates missions, starts a new cycle every two hours while the teams are free, reviews in the evening, and wakes up whenever someone replies or a mission is delivered. It creates departments and teams when the goals need them.</div>
          </div>
          <Switch checked={s.autonomy !== false} label="Autonomy" onChange={(v) => save({ autonomy: v }, v ? 'Jarvis will run the organisations itself' : 'Autonomy off: Jarvis only does what you assign')} />
        </div>
        <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
          <div>What waits for your approval</div>
          {LEVELS.map(([key, title, note]) => (
            <label key={key} className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="radio" name="approval_level" checked={(s.approval_level ?? 'payments') === key} onChange={() => save({ approval_level: key }, title)} style={{ marginTop: 4 }} />
              <span>
                <b>{title}</b> <span className="muted small">{note}</span>
              </span>
            </label>
          ))}
          <div className="small faint">Payments and purchases always wait for you, whatever the level.</div>
        </div>
      </section>

      <Connectors orgId={ctx.orgId} focus={focus} />

      <RemoteCard />

      <section className="panel col" style={{ gap: 12 }}>
        <span className="label">▶ This computer</span>
        {desktop && autoStart !== null && (
          <div className="row between">
            <div>
              <div>Start Jarvis with Windows</div>
              <div className="small muted">Jarvis starts in the tray when you sign in, so agents keep working.</div>
            </div>
            <Switch checked={autoStart} label="Start with Windows" onChange={(v) => desktop.setAutoStart(v).then(() => (setAutoStart(v), toast(v ? 'Jarvis will start with Windows' : 'Auto-start off')))} />
          </div>
        )}
        <div className="row between">
          <div>
            <div>Password</div>
            <div className="small muted">To change it, run “npm run set-password” in the Jarvis folder. All devices will be signed out.</div>
          </div>
          <button type="button" className="btn bad" onClick={() => api('POST', '/api/logout').then(() => window.dispatchEvent(new Event('jarvis:signed-out')))}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
