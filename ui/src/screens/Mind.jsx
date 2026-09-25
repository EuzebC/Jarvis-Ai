import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { Icon, toast, ago } from '../components/ui.jsx';

// The mind of the current workspace: profile, memories and files.
export default function Mind({ ctx }) {
  const orgId = ctx.orgId;
  const q = orgId ? `org=${orgId}` : '';
  const org = useData(orgId ? `/api/orgs/${orgId}` : null, [orgId]);
  const memories = useData(`/api/memories?${q}`, [q]);
  const files = useData(`/api/files?${q}`, [q]);
  const [profile, setProfile] = useState('');
  const [memory, setMemory] = useState('');
  useEffect(() => {
    if (orgId) setProfile(org.data?.profile ?? '');
    else setProfile(ctx.settings?.ownerProfile ?? '');
  }, [orgId, org.data?.profile, ctx.settings?.ownerProfile]);

  const saveProfile = async () => {
    if (orgId) await api('PUT', `/api/orgs/${orgId}`, { profile });
    else await api('PUT', '/api/settings', { ownerProfile: profile });
    toast('Saved');
  };
  const addMemory = async (e) => {
    e.preventDefault();
    await api('POST', '/api/memories', { org_id: orgId, content: memory });
    setMemory('');
  };
  const upload = async (e) => {
    for (const file of e.target.files) {
      toast(`Uploading ${file.name}…`);
      await api('POST', `/api/files?${q}`, file, { 'X-Filename': encodeURIComponent(file.name) });
    }
    toast('Added to knowledge');
    e.target.value = '';
  };
  const list = files.data ?? [];
  const knowledge = list.filter((f) => f.rel_path.startsWith('knowledge/'));
  const outputs = list.filter((f) => !f.rel_path.startsWith('knowledge/'));

  return (
    <div className="page-pad" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 18 }}>
      <div className="col" style={{ gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28 }}>MIND</h1>
          <div className="muted small">
            What Jarvis knows about {orgId ? org.data?.name ?? 'this organisation' : 'you'}. Nothing here is shared with other workspaces.
          </div>
        </div>
        <div className="panel col" style={{ gap: 10 }}>
          <span className="label">▶ {orgId ? 'Profile and standing instructions' : 'About you'}</span>
          <textarea
            className="input"
            style={{ minHeight: 220 }}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder={orgId ? 'What you sell, ideal customers, pricing, tone of voice, what agents must never do…' : 'Your name, role, time zone, how you like work done…'}
          />
          <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={saveProfile}>
            Save
          </button>
        </div>
        <div className="panel col" style={{ gap: 8 }}>
          <span className="label">▶ Memories · {memories.data?.length ?? 0}</span>
          <form className="row" onSubmit={addMemory}>
            <input className="input grow" value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="Something Jarvis should always remember" required aria-label="New memory" />
            <button className="btn">Add</button>
          </form>
          {(memories.data ?? []).map((m) => (
            <div key={m.id} className="list-item" style={{ cursor: 'default' }}>
              <div className="grow">
                <div>{m.content}</div>
                <div className="small faint">
                  {m.source === 'agent' ? 'Learned by an agent' : 'Added by you'} · {ago(m.created_at)}
                </div>
              </div>
              <button type="button" className={`btn small ${m.pinned ? 'ok' : ''}`} onClick={() => api('PUT', `/api/memories/${m.id}`, { pinned: !m.pinned })}>
                {m.pinned ? 'Pinned' : 'Pin'}
              </button>
              <button type="button" className="btn small bad" aria-label="Forget" onClick={() => api('DELETE', `/api/memories/${m.id}`)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="col" style={{ gap: 16 }}>
        <div className="panel col" style={{ gap: 8 }}>
          <span className="label">▶ Knowledge files</span>
          <label className="btn" style={{ alignSelf: 'flex-start' }}>
            <Icon name="plus" size={14} /> Upload files
            <input type="file" multiple hidden onChange={upload} />
          </label>
          <span className="small faint">Price lists, brand guides, PDFs… Agents read them when relevant.</span>
          {knowledge.map((f) => (
            <FileRow key={f.id} f={f} />
          ))}
        </div>
        <div className="panel col" style={{ gap: 8 }}>
          <span className="label">▶ Results produced by agents</span>
          {outputs.map((f) => (
            <FileRow key={f.id} f={f} />
          ))}
          {!outputs.length && <div className="empty">No files yet.</div>}
        </div>
      </div>
    </div>
  );
}

function FileRow({ f }) {
  return (
    <div className="list-item" style={{ cursor: 'default' }}>
      <div className="grow">
        <div className="mono small">{f.rel_path.replace(/^(outputs|knowledge)\//, '')}</div>
        <div className="small faint">
          {(f.size / 1024).toFixed(1)} KB · {ago(f.created_at)}
          {f.task_id ? (
            <>
              {' '}
              · <a href={`#/task/${f.task_id}`}>task #{f.task_id}</a>
            </>
          ) : null}
        </div>
      </div>
      <a className="btn small" href={`/api/files/${f.id}/download`} download aria-label={`Download ${f.rel_path}`}>
        <Icon name="download" size={14} />
      </a>
    </div>
  );
}
