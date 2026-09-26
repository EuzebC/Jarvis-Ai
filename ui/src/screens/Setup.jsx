import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import Reactor from '../components/Reactor.jsx';
import { Icon, toast } from '../components/ui.jsx';
import { go } from '../App.jsx';

export function NewOrg({ ctx, onCreated }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const suggestion = useData(`/api/orgs/folder-suggestion?name=${encodeURIComponent(name || 'New Organisation')}`, [name]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.target);
    try {
      const { id, folder } = await api('POST', '/api/orgs', { name: f.get('name'), description: f.get('description'), profile: f.get('profile'), folder: f.get('folder') });
      if (folder) toast(`Folder created: ${folder}`);
      onCreated(id);
      if (f.get('mode') === 'propose') {
        await api('POST', `/api/orgs/${id}/propose`);
        go(`/setup/${id}`);
      } else go('/map');
    } catch (err) {
      toast(err.message, true);
      setBusy(false);
    }
  };
  return (
    <div className="page-pad" style={{ maxWidth: 760, margin: '0 auto' }}>
      <form className="col" onSubmit={submit} style={{ gap: 14 }}>
        <div>
          <h1 style={{ fontSize: 28 }}>NEW ORGANISATION</h1>
          <div className="muted">{ctx.orgs.length ? 'Add another company or team for Jarvis to run.' : 'Tell Jarvis about your first organisation.'}</div>
        </div>
        <label className="field">
          <span>Name</span>
          <input className="input" name="name" required autoFocus maxLength={80} placeholder="e.g. WeCLearn" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Folder on this PC (Jarvis has full rights inside it)</span>
          <input className="input" name="folder" maxLength={400} placeholder={suggestion.data?.folder ?? 'D:\\JarvisCompanies\\<name>'} />
          <span className="small faint" style={{ textTransform: 'none', letterSpacing: 0 }}>Leave empty to use the suggested folder. Documents, programs, the CRM and journals all live there.</span>
        </label>
        <label className="field">
          <span>One-line description</span>
          <input className="input" name="description" maxLength={300} placeholder="What the organisation does" />
        </label>
        <label className="field">
          <span>Its mind: profile and standing instructions</span>
          <textarea className="input" name="profile" style={{ minHeight: 180 }} placeholder={'What you sell and to whom:\nPricing:\nWhere you operate:\nTone of voice:\nWhat agents must never do:'} />
        </label>
        <fieldset className="panel col" style={{ gap: 10, margin: 0 }}>
          <legend className="label" style={{ padding: '0 6px' }}>
            How should it be set up?
          </legend>
          <label className="row">
            <input type="radio" name="mode" value="propose" defaultChecked />
            <span>
              <b>Jarvis proposes, I edit</b> <span className="muted small">(recommended) departments, teams, leaders, agents, goals and KPIs</span>
            </span>
          </label>
          <label className="row">
            <input type="radio" name="mode" value="manual" />
            <span>
              <b>I'll build it myself</b>
            </span>
          </label>
        </fieldset>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create organisation'}
        </button>
      </form>
    </div>
  );
}

const Del = ({ onClick, label }) => (
  <button type="button" className="iconbtn" style={{ width: 28, height: 28 }} onClick={onClick} aria-label={label} title={label}>
    <Icon name="close" size={14} />
  </button>
);
const Edit = ({ value, onChange, label, style }) => <input className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} style={{ minHeight: 32, padding: '4px 8px', ...style }} />;

export function StructureReview({ ctx, orgId }) {
  const draft = useData(`/api/orgs/${orgId}/draft`, [orgId]);
  const [body, setBody] = useState(null);
  const d = draft.data;
  useEffect(() => {
    if (d?.status === 'ready') setBody(structuredClone(d.body));
  }, [d?.id, d?.status]);

  const propose = () => api('POST', `/api/orgs/${orgId}/propose`).then(() => toast('Jarvis is designing your organisation'));
  const apply = async () => {
    await api('POST', `/api/orgs/${orgId}/draft/apply`, { body });
    toast('Organisation structure created');
    go('/map');
  };
  const set = (fn) => setBody((b) => {
    const copy = structuredClone(b);
    fn(copy);
    return copy;
  });

  if (!d || d.status === 'failed' || d.status === 'applied') {
    return (
      <div className="col" style={{ alignItems: 'center', gap: 14, paddingTop: 60 }}>
        <Reactor size={260} compass={false} kind={ctx.settings?.core} />
        {d?.status === 'failed' && <div className="panel" style={{ borderColor: 'var(--bad)' }}>{d.error}</div>}
        <p className="muted">{d?.status === 'applied' ? 'The last proposal was applied. Want a fresh one?' : 'Jarvis can design departments, teams, leaders, agents, goals and KPIs for you.'}</p>
        <button type="button" className="btn primary" onClick={propose}>
          Let Jarvis propose a structure
        </button>
      </div>
    );
  }
  if (d.status === 'generating') {
    return (
      <div className="col" style={{ alignItems: 'center', gap: 14, paddingTop: 50 }}>
        <Reactor size={340} kind={ctx.settings?.core} state="thinking" />
        <div className="mono" style={{ letterSpacing: '0.3em', color: 'var(--p)' }}>DESIGNING YOUR ORGANISATION…</div>
        <div className="muted small">This takes about a minute. You can leave this page; it keeps working.</div>
      </div>
    );
  }
  if (!body) return null;
  const counts = body.departments.reduce((n, dep) => n + 1 + dep.teams.reduce((m, t) => m + 1 + t.agents.length, 0), 0);

  return (
    <div className="page-pad col" style={{ gap: 16 }}>
      <div className="row between">
        <div>
          <h1 style={{ fontSize: 26 }}>JARVIS PROPOSES</h1>
          <div className="muted small">
            {body.departments.length} departments · {counts} agents in total. Edit anything, remove what you don't want, then apply.
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={propose}>
            Propose again
          </button>
          <button type="button" className="btn primary" onClick={apply}>
            Apply structure
          </button>
        </div>
      </div>

      {body.org_goals.length > 0 && (
        <div className="panel col" style={{ gap: 6 }}>
          <span className="label">▶ Company goals</span>
          {body.org_goals.map((g, gi) => (
            <div key={gi} className="row">
              <span className="mono small" style={{ width: 70, color: 'var(--p)' }}>{g.period.toUpperCase()}</span>
              <Edit value={g.title} label="Goal" onChange={(v) => set((b) => (b.org_goals[gi].title = v))} style={{ flex: 1 }} />
              <Del label="Remove goal" onClick={() => set((b) => b.org_goals.splice(gi, 1))} />
            </div>
          ))}
        </div>
      )}

      <div className="grid g2" style={{ alignItems: 'start' }}>
        {body.departments.map((dep, di) => (
          <div key={di} className="panel hot col" style={{ gap: 10 }}>
            <div className="row">
              <Edit value={dep.name} label="Department name" onChange={(v) => set((b) => (b.departments[di].name = v))} style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700, flex: 1 }} />
              <Del label="Remove department" onClick={() => set((b) => b.departments.splice(di, 1))} />
            </div>
            <div className="row small">
              <span className="label" style={{ width: 60 }}>Head</span>
              <Edit value={dep.head.name} label="Head name" onChange={(v) => set((b) => (b.departments[di].head.name = v))} style={{ width: 120 }} />
              <Edit value={dep.head.role} label="Head role" onChange={(v) => set((b) => (b.departments[di].head.role = v))} style={{ flex: 1 }} />
            </div>
            {dep.goals.map((g, gi) => (
              <div key={gi} className="row small">
                <span className="mono" style={{ width: 60, color: 'var(--p)' }}>{g.period.toUpperCase()}</span>
                <Edit value={g.title} label="Goal" onChange={(v) => set((b) => (b.departments[di].goals[gi].title = v))} style={{ flex: 1 }} />
                <Del label="Remove goal" onClick={() => set((b) => b.departments[di].goals.splice(gi, 1))} />
              </div>
            ))}
            <div className="small muted">
              KPIs: {dep.kpis.map((k) => `${k.name} (${k.target ?? '—'}${k.unit})`).join(' · ') || 'none'}
            </div>
            {dep.teams.map((t, ti) => (
              <div key={ti} className="col" style={{ gap: 6, borderLeft: '2px solid var(--line)', paddingLeft: 12 }}>
                <div className="row">
                  <Edit value={t.name} label="Team name" onChange={(v) => set((b) => (b.departments[di].teams[ti].name = v))} style={{ fontWeight: 600, flex: 1 }} />
                  <Del label="Remove team" onClick={() => set((b) => b.departments[di].teams.splice(ti, 1))} />
                </div>
                <div className="row small">
                  <span className="label" style={{ width: 60 }}>Leader</span>
                  <Edit value={t.leader.name} label="Leader name" onChange={(v) => set((b) => (b.departments[di].teams[ti].leader.name = v))} style={{ width: 120 }} />
                  <span className="muted ellipsis grow">{t.leader.role}</span>
                </div>
                {t.agents.map((a, ai) => (
                  <div key={ai} className="row small">
                    <span className="dot" />
                    <Edit value={a.name} label="Agent name" onChange={(v) => set((b) => (b.departments[di].teams[ti].agents[ai].name = v))} style={{ width: 100 }} />
                    <Edit value={a.role} label="Agent role" onChange={(v) => set((b) => (b.departments[di].teams[ti].agents[ai].role = v))} style={{ flex: 1 }} />
                    <select className="input" value={a.grade} aria-label="Model" style={{ width: 96, minHeight: 32, padding: '4px' }} onChange={(e) => set((b) => (b.departments[di].teams[ti].agents[ai].grade = e.target.value))}>
                      <option value="auto">Smart</option>
                      <option value="strong">Opus</option>
                      <option value="worker">Sonnet</option>
                      <option value="bulk">Haiku</option>
                    </select>
                    <Del label="Remove agent" onClick={() => set((b) => b.departments[di].teams[ti].agents.splice(ai, 1))} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
