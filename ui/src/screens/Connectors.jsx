import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { Switch, toast } from '../components/ui.jsx';
import ObsidianCard from './ObsidianCard.jsx';
import DoNotContact from './DoNotContact.jsx';

const copy = (value, what) => navigator.clipboard?.writeText(value).then(() => toast(`${what} copied`)).catch(() => toast('Could not copy', true));
const Open = ({ href, children }) => (
  <a href={href} target="_blank" rel="noreferrer" className="mono small" style={{ color: 'var(--p)', whiteSpace: 'nowrap' }}>
    {children ?? 'OPEN ↗'}
  </a>
);
// An App Password is 16 letters (Google shows them in groups of four). Anything else is the account password.
const looksLikeAppPassword = (v) => /^[a-z]{16}$/i.test(String(v).replace(/\s+/g, ''));
const LINKS = {
  appPasswords: 'https://myaccount.google.com/apppasswords',
  twoStep: 'https://myaccount.google.com/signinoptions/two-step-verification',
  hubspotKeys: 'https://app.hubspot.com/l/private-apps',
  metaApps: 'https://developers.facebook.com/apps/',
  systemUsers: 'https://business.facebook.com/settings/system-users',
  templates: 'https://business.facebook.com/wa/manage/message-templates/',
  cloudflared: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
};

// Settings → Connectors: HubSpot (CRM), Gmail (sending + replies) and WhatsApp Business.
export default function Connectors({ orgId = null, focus = null }) {
  const c = useData('/api/connectors');
  // Arriving from "add the key" links: scroll to the card and light it up.
  useEffect(() => {
    if (!focus || !c.data) return;
    const el = document.getElementById(`connector-${focus}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('hot');
    const t = setTimeout(() => el.classList.remove('hot'), 4000);
    return () => clearTimeout(t);
  }, [focus, c.data]);
  const [hsKey, setHsKey] = useState('');
  const [gm, setGm] = useState({ address: '', appPassword: '', senderName: '' });
  const [wa, setWa] = useState({ phoneId: '', token: '', appSecret: '' });
  const [waOpts, setWaOpts] = useState(null);
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    if (!c.data) return;
    setGm((g) => ({ ...g, address: g.address || c.data.gmail.address, senderName: g.senderName || c.data.gmail.senderName }));
    setOpts((o) => o ?? { dailyLimit: c.data.gmail.dailyLimit, readReplies: c.data.gmail.readReplies, signature: c.data.signature, footer: c.data.footer });
    setWa((w) => ({ ...w, phoneId: w.phoneId || c.data.whatsapp.phoneId }));
    setWaOpts((o) => o ?? { template: c.data.whatsapp.template, templateLang: c.data.whatsapp.templateLang, templateParams: c.data.whatsapp.templateParams, dailyLimit: c.data.whatsapp.dailyLimit, publicUrl: c.data.whatsapp.publicUrl });
  }, [c.data]);
  if (!c.data || !opts || !waOpts) return null;
  const d = c.data;
  const callbackUrl = `${d.whatsapp.publicUrl || 'https://<your-public-url>'}${d.whatsapp.webhookPath}`;

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
        <div className="panel col" style={{ gap: 10 }} id="connector-hubspot">
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
              <li>
                In HubSpot open Settings → Integrations → Service Keys (or Development → Keys → Service Keys). <Open href={LINKS.hubspotKeys} />
              </li>
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

        <div className="panel col" style={{ gap: 10 }} id="connector-gmail">
          <div className="row between">
            <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 18, letterSpacing: '0.08em' }}>GMAIL</div>
            <span className="mono small" style={{ color: d.gmail.connected ? 'var(--ok)' : 'var(--faint)' }}>{d.gmail.connected ? `● ${d.gmail.address}` : '○ NOT CONNECTED'}</span>
          </div>
          <div className="small muted" style={{ lineHeight: 1.55 }}>
            Approved emails and proposals are sent from this address. Jarvis reads only replies from people it emailed.
            {d.gmail.connected && ` Sent in the last 24 h: ${d.gmail.sentToday} / ${d.gmail.dailyLimit}${d.gmail.queued ? ` · ${d.gmail.queued} waiting` : ''}.`}
          </div>
          <details className="small muted">
            <summary style={{ cursor: 'pointer', color: 'var(--p)' }}>How to get an App Password (your normal Gmail password does not work here)</summary>
            <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>
                Sign in to the Gmail account you want Jarvis to send from, then turn on 2-Step Verification. <Open href={LINKS.twoStep} />
              </li>
              <li>
                Open the App Passwords page, type “Jarvis” as the name and press Create. <Open href={LINKS.appPasswords} />
              </li>
              <li>Google shows 16 letters in four groups (like “abcd efgh ijkl mnop”). Copy them into the field below and press Connect. You can revoke it on the same page at any time.</li>
              <li>If the page says the setting is not available: 2-Step Verification is not fully on yet, or the account is a Google Workspace account whose admin has disabled App Passwords.</li>
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
              <input className="input grow" type="password" autoComplete="off" value={gm.appPassword} onChange={(e) => setGm({ ...gm, appPassword: e.target.value })} placeholder={d.gmail.connected ? 'New App Password to replace…' : '16-letter App Password (abcd efgh ijkl mnop)'} aria-label="Google App Password" required />
              <button className="btn primary" disabled={busy === 'gm' || (gm.appPassword && !looksLikeAppPassword(gm.appPassword))}>
                {busy === 'gm' ? 'Testing…' : 'Connect'}
              </button>
            </div>
            {gm.appPassword && !looksLikeAppPassword(gm.appPassword) && (
              <div className="small" style={{ color: 'var(--warn)', lineHeight: 1.6 }}>
                This looks like your Gmail account password. Google refuses it for apps like Jarvis. Create a 16-letter App Password and paste that instead. <Open href={LINKS.appPasswords}>OPEN APP PASSWORDS ↗</Open>
              </div>
            )}
          </form>
          {d.gmail.connected && (
            <button type="button" className="linkbtn" style={{ alignSelf: 'flex-start', color: 'var(--bad)' }} onClick={() => run('gmx', () => api('DELETE', '/api/connectors/gmail'))}>
              DISCONNECT
            </button>
          )}
        </div>
      </div>

      <div className="panel col" style={{ gap: 10 }} id="connector-whatsapp">
        <div className="row between">
          <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 18, letterSpacing: '0.08em' }}>WHATSAPP BUSINESS</div>
          <span className="mono small" style={{ color: d.whatsapp.connected ? 'var(--ok)' : 'var(--faint)' }}>{d.whatsapp.connected ? `● ${d.whatsapp.number || 'CONNECTED'}` : '○ NOT CONNECTED'}</span>
        </div>
        <div className="small muted" style={{ lineHeight: 1.55 }}>
          Agents message prospects from your WhatsApp Business number. First contacts go out as your approved template; once someone replies, the conversation continues in free text. Replies arrive through the webhook below.
          {d.whatsapp.connected && ` Sent in the last 24 h: ${d.whatsapp.sentToday} / ${d.whatsapp.dailyLimit} · replies received: ${d.whatsapp.inbound}.`}
        </div>
        <details className="small muted">
          <summary style={{ cursor: 'pointer', color: 'var(--p)' }}>How to get the Phone number ID and a permanent token</summary>
          <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>
              Go to developers.facebook.com → My Apps → Create app → type “Business”, then add the WhatsApp product. <Open href={LINKS.metaApps} />
            </li>
            <li>WhatsApp → API Setup: add your business phone number (a number that is not on the WhatsApp app) and verify it by SMS. Copy the <b>Phone number ID</b> shown under the number (not the WhatsApp Business Account ID).</li>
            <li>
              Permanent token: business.facebook.com → Settings → Users → System users → Add (role Admin) → Assign assets: your app (full control) and your WhatsApp account → Generate new token → permissions <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>, expiry “Never”. Copy it. <Open href={LINKS.systemUsers} />
            </li>
            <li>Optional but recommended: App settings → Basic → App secret, paste it below so only Meta can post to the webhook.</li>
            <li>
              Template for first contacts: WhatsApp Manager → Message templates → Create → category Marketing → write the body with variables, e.g. “Bonjour {'{{1}}'}, je suis Jarvis de Lumora Digital. {'{{3}}'} Puis-je vous envoyer les détails ?” → submit for approval. Enter its name, language code and number of variables below. <Open href={LINKS.templates} />
            </li>
            <li>
              Replies: the PC needs a public HTTPS address. Install cloudflared <Open href={LINKS.cloudflared} />, run <code>cloudflared tunnel --url http://127.0.0.1:7777</code> (or <code>ngrok http 7777 --url=your-name.ngrok-free.app</code>), paste the https address in “Public URL” below, then in your Meta app → WhatsApp → Configuration → Webhook: Callback URL and Verify token as shown here, and subscribe to the <b>messages</b> field.
            </li>
          </ol>
        </details>
        <form
          className="col"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            run('wa', () => api('PUT', '/api/connectors/whatsapp', wa)).then(() => setWa((w) => ({ ...w, token: '', appSecret: '' })));
          }}
        >
          <div className="grid g2" style={{ gap: 8 }}>
            <input className="input" value={wa.phoneId} onChange={(e) => setWa({ ...wa, phoneId: e.target.value })} placeholder="Phone number ID (digits)" aria-label="WhatsApp phone number ID" required />
            <input className="input" type="password" autoComplete="off" value={wa.appSecret} onChange={(e) => setWa({ ...wa, appSecret: e.target.value })} placeholder={d.whatsapp.appSecretSet ? 'App secret (set)' : 'App secret (optional)'} aria-label="Meta app secret" />
          </div>
          <div className="row">
            <input className="input grow" type="password" autoComplete="off" value={wa.token} onChange={(e) => setWa({ ...wa, token: e.target.value })} placeholder={d.whatsapp.connected ? 'New permanent token to replace…' : 'Permanent System User access token'} aria-label="WhatsApp access token" required />
            <button className="btn primary" disabled={busy === 'wa'}>
              {busy === 'wa' ? 'Testing…' : 'Connect'}
            </button>
          </div>
        </form>
        <div className="grid g2" style={{ gap: 8, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
          <label className="field">
            <span>First-contact template name</span>
            <input className="input" value={waOpts.template} onChange={(e) => setWaOpts({ ...waOpts, template: e.target.value })} placeholder="e.g. lumora_intro" />
          </label>
          <div className="grid g2" style={{ gap: 8 }}>
            <label className="field">
              <span>Language</span>
              <input className="input" value={waOpts.templateLang} onChange={(e) => setWaOpts({ ...waOpts, templateLang: e.target.value })} placeholder="fr, en, en_US" />
            </label>
            <label className="field">
              <span>Variables (0–3)</span>
              <input className="input" inputMode="numeric" value={waOpts.templateParams} onChange={(e) => setWaOpts({ ...waOpts, templateParams: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Public URL for the webhook</span>
            <input className="input" value={waOpts.publicUrl} onChange={(e) => setWaOpts({ ...waOpts, publicUrl: e.target.value })} placeholder="https://xxxx.trycloudflare.com" />
          </label>
          <label className="field">
            <span>Maximum WhatsApp messages per day</span>
            <input className="input" inputMode="numeric" value={waOpts.dailyLimit} onChange={(e) => setWaOpts({ ...waOpts, dailyLimit: e.target.value })} />
          </label>
        </div>
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          Variables are filled in this order: 1 = contact name, 2 = their company, 3 = the agent's one-line hook.
          <br />
          Callback URL: <span className="mono">{callbackUrl}</span>{' '}
          <button type="button" className="linkbtn" onClick={() => copy(callbackUrl, 'Callback URL')}>
            COPY
          </button>
          <br />
          Verify token: <span className="mono">{d.whatsapp.verifyToken}</span>{' '}
          <button type="button" className="linkbtn" onClick={() => copy(d.whatsapp.verifyToken, 'Verify token')}>
            COPY
          </button>
          {d.whatsapp.lastInbound ? ` · last reply received ${new Date(d.whatsapp.lastInbound).toLocaleString()}` : ' · no replies received yet (the webhook is not reached until the tunnel and Meta configuration are done)'}
        </div>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => run('waopts', () => api('PUT', '/api/connectors/whatsapp/options', { ...waOpts, templateParams: Number(waOpts.templateParams), dailyLimit: Number(waOpts.dailyLimit) }))}>
            Save WhatsApp settings
          </button>
          {d.whatsapp.connected && (
            <button type="button" className="linkbtn" style={{ color: 'var(--bad)' }} onClick={() => run('wax', () => api('DELETE', '/api/connectors/whatsapp'))}>
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
                <div className="small muted">Log them in HubSpot and give the team a follow-up mission; answers to people who replied send automatically.</div>
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
