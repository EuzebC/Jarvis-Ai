import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { Switch, toast } from '../components/ui.jsx';

const FEATURES = [
  ['reports', 'Reports & results', 'Every finished task becomes a note, filed by organisation, department and team, or by project.'],
  ['briefing', 'Daily briefing', 'Each morning (after 7:00): what was done, what waits for you, goal progress.'],
  ['minds', 'Mirror the minds', 'A note per organisation and project with its profile, structure, goals, KPIs and memories.'],
  ['knowledge', 'Read my notes', 'Notes you write in Knowledge/<organisation or project>/ are read by that workspace’s agents.'],
];

export default function ObsidianCard() {
  const o = useData('/api/connectors/obsidian');
  const [vault, setVault] = useState('');
  useEffect(() => {
    if (o.data) setVault((v) => v || o.data.vault || o.data.suggested);
  }, [o.data]);
  if (!o.data) return null;
  const d = o.data;
  const call = (method, url, body, msg) =>
    api(method, url, body)
      .then((r) => (toast(r?.message ?? msg), o.reload()))
      .catch((e) => toast(e.message, true));

  return (
    <div className="panel col" style={{ gap: 10 }}>
      <div className="row between">
        <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 18, letterSpacing: '0.08em' }}>OBSIDIAN</div>
        <span className="mono small" style={{ color: d.vault ? 'var(--ok)' : 'var(--faint)' }}>{d.vault ? '● CONNECTED' : '○ NOT CONNECTED'}</span>
      </div>
      <div className="small muted">Jarvis writes into your vault and reads your notes back. Jarvis never edits notes in your Knowledge folder.</div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          call('PUT', '/api/connectors/obsidian', { vault }, 'Vault connected');
        }}
      >
        <input className="input grow" value={vault} onChange={(e) => setVault(e.target.value)} aria-label="Vault folder" placeholder="C:\Users\you\Documents\Jarvis Vault" />
        <button className="btn primary">{d.vault ? 'Change' : 'Connect'}</button>
      </form>
      <div className="grid g2" style={{ gap: 10 }}>
        {FEATURES.map(([key, name, note]) => (
          <div key={key} className="row between" style={{ alignItems: 'flex-start' }}>
            <div>
              <div>{name}</div>
              <div className="small muted">{note}</div>
            </div>
            <Switch checked={d[key]} label={name} onChange={(v) => call('PUT', '/api/connectors/obsidian', { [key]: v }, 'Saved')} />
          </div>
        ))}
      </div>
      {d.vault && (
        <div className="row">
          <button type="button" className="btn" onClick={() => call('POST', '/api/connectors/obsidian/sync', undefined, 'Vault updated')}>
            Update vault now
          </button>
          <button type="button" className="btn" onClick={() => call('POST', '/api/connectors/obsidian/open', undefined, 'Opening Obsidian…')}>
            Open in Obsidian
          </button>
          <span className="grow" />
          <button type="button" className="linkbtn" style={{ color: 'var(--bad)' }} onClick={() => call('PUT', '/api/connectors/obsidian', { vault: '' }, 'Obsidian disconnected')}>
            DISCONNECT
          </button>
        </div>
      )}
      {d.lastBriefing && <div className="small faint">Last briefing: Daily/{d.lastBriefing}.md</div>}
    </div>
  );
}
