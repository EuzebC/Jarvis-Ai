import { useState } from 'react';
import { api, useData } from '../api.js';
import { Pill, toast, ago } from '../components/ui.jsx';

const KIND_LABEL = { email: 'Email', proposal: 'Proposal', post: 'Post', call: 'Call', payment: 'Payment · always you', contract: 'Contract', purchase: 'Purchase', other: 'Action' };

const textOf = (a) => {
  const d = a.payload || {};
  return [d.to && `To: ${d.to}`, d.subject && `Subject: ${d.subject}`, d.body].filter(Boolean).join('\n') || a.summary;
};

export function ApprovalCard({ a, compact = false }) {
  const [busy, setBusy] = useState(false);
  const d = a.payload || {};
  const decide = async (verb) => {
    setBusy(true);
    try {
      const r = await api('POST', `/api/approvals/${a.id}/${verb}`);
      toast(r.note);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel col" style={{ gap: 8, borderColor: a.kind === 'payment' ? 'var(--warn)' : undefined }}>
      <div className="row between small">
        <span className="mono" style={{ color: 'var(--warn)', letterSpacing: '0.1em' }}>
          {(KIND_LABEL[a.kind] ?? a.kind).toUpperCase()}
          {a.team_name ? ` · ${a.team_name.toUpperCase()}` : ''}
        </span>
        <span className="faint">{ago(a.created_at)}</span>
      </div>
      <div style={{ fontWeight: 600, lineHeight: 1.4 }}>{a.summary}</div>
      {!compact && a.task_id && (
        <div className="small muted">
          Prepared by {a.agent_name ?? 'an agent'} in <a href={`#/task/${a.task_id}`}>{a.task_title ?? `task #${a.task_id}`}</a>
          {a.org_name ? ` · ${a.org_name}` : ''}
        </div>
      )}
      {!compact && (d.to || d.subject || d.body) && (
        <div className="email">
          {d.to && (
            <div className="muted">
              <b>To:</b> {d.to}
            </div>
          )}
          {d.subject && (
            <div className="muted">
              <b>Subject:</b> {d.subject}
            </div>
          )}
          {d.body && <div className="body">{d.body}</div>}
        </div>
      )}
      {!compact && !d.body && Object.keys(d).length > 0 && <pre className="email mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(d, null, 2)}</pre>}
      {a.status === 'pending' ? (
        <div className="row">
          <button type="button" className="btn bad small grow" disabled={busy} onClick={() => decide('reject')}>
            Reject
          </button>
          <button type="button" className="btn primary small grow" disabled={busy} onClick={() => decide('approve')}>
            Approve
          </button>
        </div>
      ) : (
        <div className="row small">
          <Pill status={a.status} />
          <span className="muted grow">{a.decided_by === 'leader' ? `By the team leader: ${a.note}` : a.note}</span>
          {a.status === 'approved' && (
            <button type="button" className="btn small" onClick={() => navigator.clipboard.writeText(textOf(a)).then(() => toast('Copied, ready to send'))}>
              Copy
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Approvals({ ctx }) {
  const [tab, setTab] = useState('pending');
  const [scope, setScope] = useState('here');
  const orgQ = scope === 'here' && ctx.orgId ? `&org=${ctx.orgId}` : '';
  const list = useData(`/api/approvals?status=${tab}${orgQ}`, [tab, orgQ]);
  const tabs = [
    ['pending', 'Waiting for you'],
    ['approved', 'Outbox (approved)'],
    ['rejected', 'Rejected'],
  ];
  return (
    <div className="page-pad col" style={{ gap: 16, maxWidth: 980, margin: '0 auto' }}>
      <div className="row between">
        <div>
          <h1 style={{ fontSize: 28 }}>APPROVALS</h1>
          <div className="muted small">Nothing leaves the company without approval. Payments always come to you.</div>
        </div>
        {ctx.orgId && (
          <div className="seg">
            <button type="button" className={scope === 'here' ? 'on' : ''} onClick={() => setScope('here')}>
              THIS ORG
            </button>
            <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
              EVERYTHING
            </button>
          </div>
        )}
      </div>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        {tabs.map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="col" style={{ gap: 12 }}>
        {(list.data ?? []).map((a) => (
          <ApprovalCard key={a.id} a={a} />
        ))}
        {list.data && !list.data.length && <div className="empty panel">{tab === 'pending' ? 'All clear. Nothing is waiting for you.' : 'Nothing here yet.'}</div>}
      </div>
      {tab === 'approved' && (
        <p className="small faint">Approved items are ready to send. Automatic sending (email, CRM, calendar) arrives with the connectors; until then, copy and send them yourself.</p>
      )}
    </div>
  );
}
