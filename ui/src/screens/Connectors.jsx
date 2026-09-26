import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { Switch, toast } from '../components/ui.jsx';
import ObsidianCard from './ObsidianCard.jsx';
import DoNotContact from './DoNotContact.jsx';

// Settings → Connectors: HubSpot (CRM) and Gmail (sending + replies).
export default function Connectors({ orgId = null }) {
  const c = useData('/api/connectors');
  const [hsKey, setHsKey] = useState('');
  const [gm, setGm] = useState({ address: '', appPassword: '', senderName: '' });
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    if (!c.data) return;
    setGm((g) => ({ ...g, address: g.address || c.data.gmail.address, senderName: g.senderName || c.data.gmail.senderName }));
    setOpts((o) => o ?? { dailyLimit: c.data.gmail.dailyLimit, readReplies: c.data.gmail.readReplies, signature: c.data.signature, footer: c.data.footer });
  }, [c.data]);
  if (!c.data || !opts) return null;
  const d = c.data;

  const run = async (name, fn) => {
    setBusy(name);
    try {
      const r = await fn();
      toast(r?.message ?? 'Saved');
      c.reload();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="col" style={{ gap: 10 }}>
      <span className="label">▶ Connectors</span>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="panel col" style={{ gap: 10 }}>
          <div className="row between">
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 18, letterSpacing: '0.08em' }}>HUBSPOT CRM</div>
            <span className="mono small" style={{ color: d.hubspot.connected ? 'var(--ok)' : 'var(--faint)' }}>{d.hubspot.connected ? '● CONNECTED' : '○ NOT CONNECTED'}</span>
          </div>
          <div className="small muted" style={{ lineHeight: 1.55 }}>
            Leads become contacts and companies, every sent email and reply is logged, proposals become deals, and replies move deals forward.
          </div>
          <details className="small muted">
            <summary style={{ cursor: 'pointer', color: 'var(--p)' }}>How to get the key</summary>
            <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>In HubSpot open Settings → Integrations → Service Keys (or Development → Keys → Service Keys).</li>
              <li>Create a key named “Jarvis”.</li>
              <li>Add scopes: crm.objects.contacts.read / write, crm.objects.companies.read / write, crm.objects.deals.read / write.</li>
              <li>Create it, copy the key and paste it below.</li>
            </ol>
          </details>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              run('hs', () => api('PUT', '/api/connectors/hubspot', { token: hsKey })).then(() => setHsKey(''));
            }}
          >
            <input className="input grow" type="password" autoComplete="off" value={hsKey} onChange={(e) => setHsKey(e.target.value)} placeholder={d.hubspot.connected ? 'Replace key…' : 'Paste your HubSpot Service Key'} aria-label="HubSpot Service Key" />
            <button className="btn primary" disabled={!hsKey || busy === 'hs'}>
              {busy === 'hs' ? 'Testing…' : 'Connect'}
            </button>
          </form>
          {d.hubspot.connected && (
            <button type="button" className="linkbtn" style={{ alignSelf: 'flex-start', color: 'var(--bad)' }} onClick={() => run('hsx', () => api('DELETE', '/api/connectors/hubspot'))}>
              DISCONNECT
            </button>
          )}
        </div>

        <div className="panel col" style={{ gap: 10 }}>
          <div className="row between">
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 18, letterSpacing: '0.08em' }}>GMAIL</div>
            <span className="mono small" style={{ color: d.gmail.connected ? 'var(--ok)' : 'var(--faint)' }}>{d.gmail.connected ? `● ${d.gmail.address}` : '○ NOT CONNECTED'}</span>
          </div>
          <div className="small muted" style={{ lineHeight: 1.55 }}>
            Approved emails and proposals are sent from this address. Jarvis reads only replies from people it emailed.
            {d.gmail.connected && ` Sent in the last 24 h: ${d.gmail.sentToday} / ${d.gmail.dailyLimit}${d.gmail.queued ? ` · ${d.gmail.queued} waiting` : ''}.`}
          </div>
          <details className="small muted">
            <summary style={{ cursor: 'pointer', color: 'var(--p)' }}>How to get an App Password</summary>
            <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Go to myaccount.google.com → Security and turn on 2-Step Verification.</li>
              <li>Open myaccount.google.com/apppasswords, create one named “Jarvis”.</li>
              <li>Copy the 16-character password and paste it below. You can revoke it there any time.</li>
            </ol>
          </details>
          <form
            className="col"
            style={{ gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              run('gm', () => api('PUT', '/api/connectors/gmail', gm)).then(() => setGm((g) => ({ ...g, appPassword: '' })));
            }}
          >
            <div className="grid g2" style={{ gap: 8 }}>
              <input className="input" type="email" value={gm.address} onChange={(e) => setGm({ ...gm, address: e.target.value })} placeholder="you@gmail.com" aria-label="Gmail address" required />
              <input className="input" value={gm.senderName} onChange={(e) => setGm({ ...gm, senderName: e.target.value })} placeholder="Sender name (e.g. Acme Digital)" aria-label="Sender name" />
            </div>
            <div className="row">
              <input className="input grow" type="password" autoComplete="off" value={gm.appPassword} onChange={(e) => setGm({ ...gm, appPassword: e.target.value })} placeholder={d.gmail.connected ? 'New App Password to replace…' : '16-character App Password'} aria-label="Google App Password" required />
              <button className="btn primary" disabled={busy === 'gm'}>
                {busy === 'gm' ? 'Testing…' : 'Connect'}
              </button>
            </div>
          </form>
          {d.gmail.connected && (
            <button type="button" className="linkbtn" style={{ alignSelf: 'flex-start', color: 'var(--bad)' }} onClick={() => run('gmx', () => api('DELETE', '/api/connectors/gmail'))}>
              DISCONNECT
            </button>
          )}
        </div>
      </div>

      <ObsidianCard />

      <DoNotContact orgId={orgId} />

      <div className="panel col" style={{ gap: 12 }}>
        <span className="label">▶ Sending rules</span>
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <div className="col" style={{ gap: 12 }}>
            <label className="field">
              <span>Maximum emails per day</span>
              <input className="input" inputMode="numeric" value={opts.dailyLimit} onChange={(e) => setOpts({ ...opts, dailyLimit: e.target.value })} />
            </label>
            <div className="row between">
              <div>
                <div>Read replies</div>
                <div className="small muted">Log them in HubSpot and ask the team for a follow-up (which you approve).</div>
              </div>
              <Switch checked={opts.readReplies} label="Read replies" onChange={(v) => setOpts({ ...opts, readReplies: v })} />
            </div>
          </div>
          <div className="col" style={{ gap: 12 }}>
            <label className="field">
              <span>Signature (added to every email)</span>
              <textarea className="input" style={{ minHeight: 80 }} value={opts.signature} onChange={(e) => setOpts({ ...opts, signature: e.target.value })} placeholder={'Your name\nYour company · phone · website'} />
            </label>
            <label className="field">
              <span>Opt-out line (added to every email)</span>
              <input className="input" value={opts.footer} onChange={(e) => setOpts({ ...opts, footer: e.target.value })} />
            </label>
          </div>
        </div>
        <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => run('opts', () => api('PUT', '/api/connectors/gmail/options', { ...opts, dailyLimit: Number(opts.dailyLimit) }))}>
          Save sending rules
        </button>
      </div>
    </section>
  );
}
