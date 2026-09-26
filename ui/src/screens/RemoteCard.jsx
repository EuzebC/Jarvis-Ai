import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { Switch, toast } from '../components/ui.jsx';

// Settings → Remote access: a tunnel Jarvis keeps alive, a public link and a QR code for the phone.
export default function RemoteCard() {
  const r = useData('/api/remote');
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    if (r.data) setCmd((c) => c || r.data.command);
  }, [r.data]);
  useEffect(() => {
    if (!r.data?.enabled || r.data.publicUrl) return undefined;
    const t = setInterval(() => r.reload(), 4000); // waiting for the tunnel to print its address
    return () => clearInterval(t);
  }, [r.data?.enabled, r.data?.publicUrl]);
  if (!r.data) return null;
  const d = r.data;
  const call = (name, fn) => {
    setBusy(name);
    return fn()
      .then((x) => (x?.message && toast(x.message, x.ok === false), r.reload()))
      .catch((e) => toast(e.message, true))
      .finally(() => setBusy(null));
  };
  return (
    <section className="panel col" style={{ gap: 12 }} id="connector-remote">
      <div className="row between">
        <div>
          <span className="label">▶ Remote access from your phone</span>
          <div className="small muted" style={{ marginTop: 4 }}>
            Jarvis runs a tunnel and keeps it alive. Scan the code on your phone, sign in with your Jarvis password, and you have the full HUD anywhere. The same address serves the WhatsApp webhook.
          </div>
        </div>
        <Switch checked={d.enabled} label="Remote access" onChange={(v) => call('on', () => api('PUT', '/api/remote', { enabled: v, command: cmd }))} />
      </div>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="col" style={{ gap: 8 }}>
          <label className="field">
            <span>Tunnel command</span>
            <input className="input" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={d.defaultCommand} />
          </label>
          <div className="row">
            <button type="button" className="btn small" disabled={busy === 'save'} onClick={() => call('save', () => api('PUT', '/api/remote', { command: cmd }))}>
              Save command
            </button>
            <button type="button" className="btn small" disabled={busy === 'install'} onClick={() => call('install', () => api('POST', '/api/remote/install'))}>
              {busy === 'install' ? 'Installing…' : 'Install cloudflared'}
            </button>
          </div>
          <div className="small faint" style={{ lineHeight: 1.6 }}>
            cloudflared is free and needs no account: the address changes each time the tunnel restarts, so re-scan the code then. For a fixed address use ngrok with a free static domain: <span className="mono">ngrok http 7777 --url=your-name.ngrok-free.app</span> (after <span className="mono">ngrok config add-authtoken …</span>).
          </div>
          <div className="mono small" style={{ color: d.running ? 'var(--ok)' : d.enabled ? 'var(--warn)' : 'var(--faint)' }}>
            {d.running ? '● TUNNEL RUNNING' : d.enabled ? '○ STARTING…' : '○ OFF'}
          </div>
          {d.lastError && <div className="small" style={{ color: 'var(--bad)' }}>{d.lastError}</div>}
          {!d.running && d.output?.length > 0 && <pre className="mono small faint" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{d.output.join('\n')}</pre>}
        </div>
        <div className="col" style={{ gap: 8, alignItems: 'center' }}>
          {d.qr ? (
            <>
              <img src={d.qr} alt="QR code with the public address of Jarvis" width={220} height={220} style={{ imageRendering: 'pixelated' }} />
              <a href={d.publicUrl} target="_blank" rel="noreferrer" className="mono small" style={{ color: 'var(--p)', wordBreak: 'break-all', textAlign: 'center' }}>
                {d.publicUrl}
              </a>
              <button type="button" className="linkbtn" onClick={() => navigator.clipboard?.writeText(d.publicUrl).then(() => toast('Link copied'))}>
                COPY LINK
              </button>
            </>
          ) : (
            <div className="small faint" style={{ textAlign: 'center', padding: 20 }}>
              {d.enabled ? 'Waiting for the tunnel to announce its address…' : 'Switch remote access on to get a link and a QR code.'}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
