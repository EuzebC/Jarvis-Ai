import { useState } from 'react';
import { api, useData } from '../api.js';
import { MiniCore } from '../components/Reactor.jsx';
import { Bar, Modal, toast, ago } from '../components/ui.jsx';
import { go } from '../App.jsx';

function Bot({ color, working }) {
  return (
    <svg width="20" height="28" viewBox="0 0 22 30" aria-hidden="true" style={{ animation: working ? 'walk 3s ease-in-out infinite' : 'none' }}>
      <circle cx="11" cy="7" r="6" fill={working ? color : '#3a4a44'} />
      <rect x="4" y="15" width="14" height="13" rx="3" fill={working ? color : '#3a4a44'} opacity="0.75" />
    </svg>
  );
}

function Room({ d }) {
  const bots = Array.from({ length: Math.max(d.total, 1) }, (_, i) => i < d.live);
  return (
    <a
      href={`#/dept/${d.id}`}
      className="col"
      style={{
        position: 'relative',
        padding: '12px 14px',
        minHeight: 196,
        gap: 8,
        border: `2px solid ${d.color}`,
        background: `radial-gradient(circle at 50% 40%, ${d.color}22, rgba(0,0,0,0.85) 75%)`,
        boxShadow: `0 0 22px ${d.color}33, inset 0 0 30px ${d.color}18`,
        color: 'var(--text)',
      }}
    >
      <span style={{ position: 'absolute', top: -26, left: '50%', width: 2, height: 24, background: d.color, opacity: 0.6 }} />
      <div className="row between">
        <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 17, letterSpacing: '0.16em', color: d.color }}>{d.name.toUpperCase()}</span>
        <span className="mono small" style={{ color: d.pending ? 'var(--warn)' : d.color }}>
          {d.pending ? `${d.pending} NEED YOU` : `${d.live}/${d.total} LIVE`}
        </span>
      </div>
      <div className="small muted">
        Head: {d.head ?? '—'} · {d.teams} team{d.teams === 1 ? '' : 's'}
      </div>
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'center', justifyContent: 'center', padding: '6px 0' }}>
        {bots.slice(0, 16).map((w, i) => (
          <Bot key={i} color={d.color} working={w} />
        ))}
      </div>
      {d.goal && (
        <div className="col" style={{ gap: 4 }}>
          <div className="row between mono small">
            <span className="muted ellipsis" style={{ maxWidth: '80%' }}>{d.goal.title}</span>
            <span>{d.goal.progress}%</span>
          </div>
          <Bar pct={d.goal.progress} color={d.color} />
        </div>
      )}
    </a>
  );
}

export default function OrgMap({ ctx }) {
  const org = useData(ctx.orgId ? `/api/orgs/${ctx.orgId}` : null, [ctx.orgId]);
  const cmap = useData(ctx.orgId ? `/api/orgs/${ctx.orgId}/company-map` : null, [ctx.orgId]);
  const [adding, setAdding] = useState(false);
  const [folderEdit, setFolderEdit] = useState(null);
  const o = org.data;
  if (!o) return null;
  const openFolder = () => api('POST', `/api/orgs/${o.id}/workspace/open`).catch((e) => toast(e.message, true));
  const saveFolder = async (e) => {
    e.preventDefault();
    try {
      const r = await api('PUT', `/api/orgs/${o.id}/workspace`, { path: folderEdit });
      toast(`Now working in ${r.folder}`);
      setFolderEdit(null);
      org.reload();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const cols = o.departments.length > 6 ? 4 : 3;

  const addDept = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('POST', `/api/orgs/${o.id}/departments`, { name: f.get('name'), description: f.get('description'), headName: f.get('headName'), headRole: f.get('headRole') });
    setAdding(false);
    toast('Department created');
  };

  return (
    <div style={{ display: 'flex', minHeight: '100%' }}>
      <section
        style={{
          flex: 1,
          padding: '22px 28px 40px',
          backgroundImage: 'linear-gradient(var(--line-soft) 1px, transparent 1px), linear-gradient(90deg, var(--line-soft) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      >
        <nav className="crumbs" aria-label="Breadcrumb" style={{ marginBottom: 18 }}>
          <a href="#/">HOME</a> › <span className="here">{o.name.toUpperCase()}</span>
        </nav>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div className="panel hot col" style={{ alignItems: 'center', width: 220, gap: 6 }}>
            <MiniCore size={64} />
            <span style={{ fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '0.18em' }}>COMMAND · JARVIS</span>
            <span className="mono small muted">CHIEF OF STAFF</span>
          </div>
        </div>
        {o.departments.length > 0 ? (
          <>
            <div style={{ width: 2, height: 30, background: 'var(--p)', margin: '0 auto', opacity: 0.6 }} />
            <div style={{ borderTop: '2px solid var(--line)', margin: `0 calc(100% / ${cols * 2})` }} />
            <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: '34px 22px', marginTop: 26 }}>
              {o.departments.map((d) => (
                <Room key={d.id} d={d} />
              ))}
            </div>
          </>
        ) : (
          <div className="col" style={{ alignItems: 'center', marginTop: 40, gap: 12 }}>
            <p className="muted">This organisation has no departments yet.</p>
            <button type="button" className="btn primary" onClick={() => go(`/setup/${o.id}`)}>
              Let Jarvis propose a structure
            </button>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              Build it myself
            </button>
          </div>
        )}
      </section>

      <aside className="col" style={{ width: 350, padding: 20, gap: 16, borderLeft: '1px solid var(--line)', background: 'rgba(0,0,0,0.3)' }}>
        <div>
          <span className="label dim">Organisation</span>
          <h1 style={{ fontSize: 28 }}>{o.name.toUpperCase()}</h1>
          <div className="small muted">{o.description}</div>
        </div>
        <div className="col" style={{ gap: 8 }}>
          <span className="label">▶ Company goals</span>
          {o.goals.map((g) => (
            <div key={g.id} className="col" style={{ gap: 4 }}>
              <div className="row between small">
                <span>
                  <span className="mono" style={{ color: 'var(--p)' }}>{g.period_label}</span> {g.title}
                </span>
                <span className="mono">{g.progress}%</span>
              </div>
              <Bar pct={g.progress} />
            </div>
          ))}
          {!o.goals.length && <span className="faint small">No company goals yet.</span>}
        </div>
        <div className="col" style={{ gap: 6 }}>
          <span className="label">▶ Folder on this PC</span>
          <div className="small muted">Everything the teams make is saved here. Jarvis has full rights inside this folder and nowhere else.</div>
          {folderEdit === null ? (
            <>
              <div className="mono small" style={{ wordBreak: 'break-all' }}>{o.folder}</div>
              <div className="row">
                <button type="button" className="btn small" onClick={openFolder}>
                  Open folder
                </button>
                <button type="button" className="btn small" onClick={() => setFolderEdit(o.folder)}>
                  Change…
                </button>
              </div>
            </>
          ) : (
            <form className="col" style={{ gap: 6 }} onSubmit={saveFolder}>
              <input className="input" value={folderEdit} onChange={(e) => setFolderEdit(e.target.value)} aria-label="Folder path" />
              <div className="row">
                <button className="btn small primary">Move here</button>
                <button type="button" className="btn small" onClick={() => setFolderEdit(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
        <div className="col" style={{ gap: 6 }}>
          <span className="label">▶ Department health</span>
          {o.departments.map((d) => (
            <a key={d.id} href={`#/dept/${d.id}`} className="row small" style={{ color: 'var(--text)' }}>
              <span style={{ width: 10, height: 10, background: d.color }} />
              <span className="grow">{d.name}</span>
              <span className="mono" style={{ color: d.color }}>{d.goal ? `${d.goal.progress}%` : '—'}</span>
            </a>
          ))}
        </div>
        <div className="row">
          <button type="button" className="btn grow" onClick={() => setAdding(true)}>
            + Department
          </button>
          <button type="button" className="btn grow" onClick={() => go(`/setup/${o.id}`)}>
            Jarvis: redesign
          </button>
          <button type="button" className="btn grow" onClick={() => go('/flow')}>
            Flow
          </button>
        </div>
        {cmap.data && (
          <div className="col" style={{ gap: 6 }}>
            <span className="label">▶ Company map · stage: {cmap.data.stage}</span>
            {!cmap.data.updated_at && <span className="faint small">Jarvis assesses it on its next run.</span>}
            {cmap.data.items.map((i) => (
              <div key={i.key} className="row small" title={`${i.why}${i.evidence ? `\n${i.evidence}` : ''}${i.next ? `\nNext: ${i.next}` : ''}`}>
                <span className="mono" style={{ width: 66, flexShrink: 0, color: i.status === 'ready' ? 'var(--ok)' : i.status === 'building' ? 'var(--p)' : i.status === 'missing' ? 'var(--warn)' : 'var(--faint)' }}>
                  {i.status === 'n/a' ? 'N/A' : i.status.toUpperCase()}
                </span>
                <span className="grow ellipsis">{i.name}</span>
                {i.department && <span className="faint mono ellipsis" style={{ maxWidth: 90 }}>{i.department}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="col grow" style={{ gap: 4, overflow: 'hidden' }}>
          <span className="label">▶ Live</span>
          {o.feed.map((ev) => (
            <div key={ev.id} className="mono small" style={{ lineHeight: 1.5, color: ev.level === 'error' ? 'var(--bad)' : ev.level === 'warn' ? 'var(--warn)' : 'var(--muted)' }}>
              <span className="faint">{ago(ev.ts)}</span> {ev.message}
            </div>
          ))}
        </div>
      </aside>

      {adding && (
        <Modal title="New department" onClose={() => setAdding(false)}>
          <form className="col" onSubmit={addDept} style={{ gap: 12 }}>
            <label className="field">
              <span>Department name</span>
              <input className="input" name="name" required autoFocus placeholder="e.g. Sales" />
            </label>
            <label className="field">
              <span>What does it do?</span>
              <input className="input" name="description" />
            </label>
            <div className="grid g2">
              <label className="field">
                <span>Head agent name</span>
                <input className="input" name="headName" placeholder="e.g. Nova" />
              </label>
              <label className="field">
                <span>Head's role</span>
                <input className="input" name="headRole" placeholder="Head of Sales" />
              </label>
            </div>
            <button className="btn primary">Create department</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
