import { useState } from 'react';
import { api, useData } from '../api.js';
import { Icon, toast, ago } from '../components/ui.jsx';

// Settings → Connectors: the do-not-contact list Jarvis maintains for the current organisation.
export default function DoNotContact({ orgId }) {
  const q = orgId ? `?org=${orgId}` : '';
  const list = useData(`/api/do-not-contact${q}`, [q]);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const rows = list.data ?? [];

  const add = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/do-not-contact', { org_id: orgId, email, reason });
      setEmail('');
      setReason('');
      toast('Added to the do-not-contact list');
    } catch (err) {
      toast(err.message, true);
    }
  };

  return (
    <div className="panel col" style={{ gap: 10 }}>
      <div className="row between">
        <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 18, letterSpacing: '0.08em' }}>DO NOT CONTACT</div>
        <span className="mono small muted">{rows.length} ADDRESS{rows.length === 1 ? '' : 'ES'}</span>
      </div>
      <div className="small muted" style={{ lineHeight: 1.55 }}>
        Jarvis keeps this list itself: anyone who replies “stop” or “unsubscribe” is added automatically, every email is checked before sending, and agents skip these people when finding leads.
      </div>
      <form className="row" onSubmit={add}>
        <input className="input grow" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@company.com" aria-label="Email to block" required />
        <input className="input" style={{ width: 200 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason" />
        <button className="btn">Add</button>
      </form>
      {rows.length > 0 && (
        <div className="col" style={{ gap: 0, maxHeight: 240, overflow: 'auto' }}>
          {rows.map((r) => (
            <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
              <div className="grow">
                <div className="mono small">{r.email}</div>
                <div className="small faint">
                  {r.reason || (r.source === 'reply' ? 'Replied asking not to be contacted' : 'Added by you')} · {ago(r.created_at)}
                  {r.org_id === null ? ' · all organisations' : ''}
                </div>
              </div>
              <button type="button" className="btn small" aria-label={`Remove ${r.email}`} onClick={() => api('DELETE', `/api/do-not-contact/${r.id}`).then(() => toast('Removed'))}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
