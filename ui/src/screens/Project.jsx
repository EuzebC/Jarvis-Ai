import { useState } from 'react';
import { useData } from '../api.js';
import { Pill, ago } from '../components/ui.jsx';
import { GiveTask } from './Home.jsx';

export default function Project({ ctx, id }) {
  const project = useData(`/api/projects/${id}`, [id]);
  const [giving, setGiving] = useState(false);
  const p = project.data;
  if (!p) return null;
  return (
    <div className="page-pad col" style={{ gap: 16, maxWidth: 1000, margin: '0 auto' }}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href="#/">{ctx.workspace === 'personal' ? 'PERSONAL' : 'HOME'}</a> › <span className="here">{p.name.toUpperCase()}</span>
      </nav>
      <div className="row between">
        <div>
          <h1 style={{ fontSize: 28 }}>{p.name}</h1>
          {p.description && <div className="muted">{p.description}</div>}
        </div>
        <button type="button" className="btn primary" onClick={() => setGiving(true)}>
          + Task
        </button>
      </div>
      <div className="panel col" style={{ gap: 2 }}>
        {p.tasks.map((t) => (
          <a key={t.id} href={`#/task/${t.id}`} className="list-item" style={{ color: 'var(--text)', paddingLeft: t.depth * 18 }}>
            <div className="grow">
              <div className="t">{t.title}</div>
              <div className="small faint">
                {t.agent_name} · {ago(t.finished_at || t.created_at)}
                {t.summary ? ` · ${t.summary}` : ''}
              </div>
            </div>
            <Pill status={t.status} />
          </a>
        ))}
        {!p.tasks.length && <div className="empty">No tasks yet.</div>}
      </div>
      {giving && <GiveTask target={p.org_id ? { type: 'org', id: p.org_id } : { type: 'personal' }} projectId={p.id} title={`New task for ${p.name}`} onClose={() => setGiving(false)} />}
    </div>
  );
}
