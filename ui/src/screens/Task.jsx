import { api, useData } from '../api.js';
import { Md, Pill, Icon, toast, ago } from '../components/ui.jsx';
import { ApprovalCard } from './Approvals.jsx';

export default function TaskView({ id }) {
  const task = useData(`/api/tasks/${id}`, [id]);
  const t = task.data;
  if (!t) return null;
  const act = (verb) => api('POST', `/api/tasks/${t.id}/${verb}`).then(() => toast(verb === 'retry' ? 'Queued again' : 'Cancelled'));
  return (
    <div className="page-pad col" style={{ gap: 16, maxWidth: 1000, margin: '0 auto' }}>
      <button type="button" className="linkbtn" style={{ alignSelf: 'flex-start' }} onClick={() => history.back()}>
        ‹ BACK
      </button>
      <div className="row between">
        <h1 style={{ fontSize: 26, letterSpacing: '0.04em' }}>{t.title}</h1>
        <div className="row">
          {['queued', 'running'].includes(t.status) && (
            <button type="button" className="btn bad small" onClick={() => act('cancel')}>
              Cancel
            </button>
          )}
          {['failed', 'cancelled'].includes(t.status) && (
            <button type="button" className="btn small" onClick={() => act('retry')}>
              Retry
            </button>
          )}
        </div>
      </div>
      <div className="row small muted" style={{ flexWrap: 'wrap' }}>
        <Pill status={t.status} />
        {t.agent && (
          <span>
            {t.agent.name} · {t.agent.role}
          </span>
        )}
        {t.provider && (
          <span className="mono">
            {t.provider.toUpperCase()}
            {t.model ? ` · ${t.model}` : ''}
          </span>
        )}
        <span>created {ago(t.created_at)} by {t.created_by.startsWith('review:') ? 'an approval review' : t.created_by}</span>
        {t.cost_usd > 0 && <span className="mono">API ${t.cost_usd.toFixed(3)}</span>}
      </div>
      {(t.dod || t.verify_status || t.live_status) && (
        <div className="panel col" style={{ gap: 6 }}>
          {t.dod && (
            <>
              <span className="label">▶ Definition of done</span>
              <div className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{t.dod}</div>
            </>
          )}
          {t.live_status && t.status === 'running' && <div className="small mono" style={{ color: 'var(--p)' }}>NOW: {t.live_status}</div>}
          {t.verify_status && (
            <div className="small" style={{ color: t.verify_status === 'passed' ? 'var(--ok)' : t.verify_status === 'failed' ? 'var(--bad)' : 'var(--muted)' }}>
              Verification {t.verify_status}
              {t.round > 1 ? ` (round ${t.round})` : ''}
              {t.verify_note ? `: ${t.verify_note}` : ''}
            </div>
          )}
        </div>
      )}
      {t.error && t.status !== 'done' && (
        <div className="panel" style={{ borderColor: 'var(--bad)', color: '#ffd0d0', whiteSpace: 'pre-wrap' }}>
          {t.error}
        </div>
      )}
      {t.result ? (
        <div className="panel">
          <span className="label">▶ Report</span>
          <Md text={t.result} />
        </div>
      ) : t.status === 'running' ? (
        <div className="panel empty">WORKING ON IT…</div>
      ) : null}
      {t.files.length > 0 && (
        <div className="panel col" style={{ gap: 4 }}>
          <span className="label">▶ Files produced</span>
          {t.files.map((f) => (
            <div key={f.id} className="list-item" style={{ cursor: 'default' }}>
              <span className="grow mono small">{f.rel_path.replace(/^outputs\//, '')}</span>
              <a className="btn small" href={`/api/files/${f.id}/download`} download>
                <Icon name="download" size={14} /> Download
              </a>
            </div>
          ))}
        </div>
      )}
      {t.approvals.length > 0 && (
        <div className="col" style={{ gap: 10 }}>
          <span className="label warn">▶ Proposed actions</span>
          {t.approvals.map((a) => (
            <ApprovalCard key={a.id} a={a} />
          ))}
        </div>
      )}
      {t.children.length > 0 && (
        <div className="panel col" style={{ gap: 2 }}>
          <span className="label">▶ Delegated</span>
          {t.children.map((c) => (
            <a key={c.id} href={`#/task/${c.id}`} className="list-item" style={{ color: 'var(--text)' }}>
              <span className="t grow">{c.title}</span>
              <span className="small muted">{c.agent_name}</span>
              <Pill status={c.status} />
            </a>
          ))}
        </div>
      )}
      <details className="panel">
        <summary className="muted small" style={{ cursor: 'pointer' }}>
          Instructions given to the agent
        </summary>
        <Md text={t.instructions} />
      </details>
    </div>
  );
}
