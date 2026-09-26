import { useState } from 'react';
import { api, useData } from '../api.js';
import { Pill, toast, ago } from '../components/ui.jsx';
import { go } from '../App.jsx';

const KIND_LABEL = { email: 'Email', proposal: 'Proposal', whatsapp: 'WhatsApp', post: 'Post', call: 'Call', payment: 'Payment · needs you', contract: 'Contract', purchase: 'Purchase · needs you', deletion: 'Deletion', other: 'Action' };
const STATE = (a) => {
  if (a.status === 'review') return ['running', 'in review'];
  if (a.status === 'rejected') return ['failed', 'rejected'];
  if (a.status === 'pending') return ['pending', 'needs you'];
  if (a.delivery === 'sent') return ['done', 'sent'];
  if (a.delivery === 'queued') return ['running', 'sending'];
  if (a.delivery === 'failed') return ['failed', 'not sent'];
  if (a.delivery === 'blocked') return ['failed', 'blocked'];
  if (a.delivery === 'needs_connector') return ['pending', 'waiting for connector'];
  return ['done', 'approved'];
};

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
          <Pill status={STATE(a)[0]}>{STATE(a)[1]}</Pill>
          <span className="muted grow">
            {a.decided_by === 'leader' ? 'By the team leader. ' : a.decided_by === 'jarvis' ? 'Reviewed by Jarvis. ' : ''}
            {a.delivery_note ?? a.note}
          </span>
          {a.status === 'review' && (
            <button type="button" className="btn small" disabled={busy} onClick={() => decide('reject')}>
              Drop
            </button>
          )}
          {a.status === 'approved' && a.delivery === 'failed' && (
            <button type="button" className="btn small primary" disabled={busy} onClick={() => api('POST', `/api/approvals/${a.id}/send`).then(() => toast('Sending…')).catch((e) => toast(e.message, true))}>
              Send
            </button>
          )}
          {a.status === 'approved' && a.delivery !== 'sent' && (
            <button type="button" className="btn small" onClick={() => navigator.clipboard.writeText(textOf(a)).then(() => toast('Copied'))}>
              Copy
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Notices for connectors with messages waiting, each with a link straight to the card where the key goes.
export function ConnectorNotices({ items, compact = false }) {
  if (!items?.length) return null;
  return (
    <>
      {items.map((w) => (
        <div key={w.connector} className="panel warn col" style={{ gap: 6 }}>
          <div style={{ fontWeight: 600, lineHeight: 1.4 }}>
            {w.count} message{w.count === 1 ? '' : 's'} ready for {w.label}. Add the {w.label} key and they send by themselves.
          </div>
          {!compact && <div className="small muted">Jarvis reviewed them with their missions. Nothing else is needed from you.</div>}
          <button type="button" className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => go(`/settings/${w.connector}`)}>
            Add the {w.label} key ›
          </button>
        </div>
      ))}
    </>
  );
}

const TABS = [
  ['ready', 'Ready to send', { status: 'approved', delivery: 'needs_connector' }],
  ['sending', 'Sending & sent', { status: 'approved' }],
  ['review', 'In review', { status: 'review' }],
  ['money', 'Money (needs you)', { status: 'pending' }],
  ['rejected', 'Rejected', { status: 'rejected' }],
];

export default function Approvals({ ctx }) {
  const [tab, setTab] = useState('ready');
  const [scope, setScope] = useState('here');
  const orgQ = scope === 'here' && ctx.orgId ? `&org=${ctx.orgId}` : '';
  const spec = TABS.find(([k]) => k === tab)[2];
  const list = useData(`/api/approvals?status=${spec.status}${spec.delivery ? `&delivery=${spec.delivery}` : ''}${orgQ}`, [tab, orgQ]);
  const rows = (list.data ?? []).filter((a) => tab !== 'sending' || a.delivery !== 'needs_connector');
  const notices = ctx.overview?.connectorsNeeded ?? [];
  const empty = {
    ready: 'Nothing is waiting for a connector.',
    sending: 'Nothing has been sent yet.',
    review: 'No messages are waiting for Jarvis’s review.',
    money: 'No payments or purchases need you.',
    rejected: 'Nothing here.',
  }[tab];
  return (
    <div className="page-pad col" style={{ gap: 16, maxWidth: 980, margin: '0 auto' }}>
      <div className="row between">
        <div>
          <h1 style={{ fontSize: 28 }}>OUTBOX</h1>
          <div className="muted small">Jarvis reviews every message with its mission and sends it. Only money waits for you.</div>
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
      {tab === 'ready' && <ConnectorNotices items={notices} />}
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        {TABS.map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="col" style={{ gap: 12 }}>
        {rows.map((a) => (
          <ApprovalCard key={a.id} a={a} />
        ))}
        {list.data && !rows.length && <div className="empty panel">{empty}</div>}
      </div>
    </div>
  );
}
