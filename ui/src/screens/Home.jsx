import { useState } from 'react';
import { api, useData } from '../api.js';
import Reactor from '../components/Reactor.jsx';
import { Bar, Icon, Pill, Modal, toast, ago } from '../components/ui.jsx';
import { go, useAsk } from '../App.jsx';
import { ApprovalCard, ConnectorNotices } from './Approvals.jsx';

const ENGINE_NAMES = { claude: 'Claude Code', codex: 'Codex', api: 'API backup' };

function EngineStat({ e, api: apiInfo }) {
  const pct = e.name === 'api' ? (apiInfo.cap ? (apiInfo.spent / apiInfo.cap) * 100 : 0) : 100 - (e.runsLastHour / e.maxPerHour) * 100;
  const value = e.cooldownUntil
    ? `BACK ${new Date(e.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : e.name === 'api'
      ? apiInfo.keySet
        ? `$${apiInfo.spent.toFixed(2)} / $${apiInfo.cap}`
        : 'NO KEY'
      : !e.enabled
        ? 'OFF'
        : `${e.running}/${e.maxConcurrent} RUNNING`;
  const color = e.cooldownUntil ? 'var(--warn)' : e.enabled ? 'var(--p)' : 'var(--faint)';
  return (
    <div className="panel" style={{ borderLeft: `3px solid ${color}`, padding: '10px 12px' }}>
      <div className="row between mono small" style={{ letterSpacing: '0.1em' }}>
        <span className="muted">{ENGINE_NAMES[e.name].toUpperCase()}</span>
        <span style={{ color }}>{value}</span>
      </div>
      <div style={{ marginTop: 6 }}>
        <Bar pct={pct} color={color} />
      </div>
    </div>
  );
}

function CommandBox({ orgId, placeholder = 'Type a command or question…' }) {
  const { busy, reply, ask } = useAsk(orgId);
  const [text, setText] = useState('');
  return (
    <div className="col">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
          setText('');
        }}
      >
        <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="Command" />
        <button className="btn primary" disabled={busy || !text.trim()}>
          {busy ? '…' : 'Send'}
        </button>
      </form>
      {reply && (
        <div className="small" style={{ lineHeight: 1.55 }}>
          <span className="label">Jarvis ›</span> {reply.reply}
        </div>
      )}
    </div>
  );
}

export function OrgHome({ ctx }) {
  const o = ctx.overview;
  const [giving, setGiving] = useState(false);
  if (!o) return null;
  const hasDepts = o.departments?.length > 0;
  const state = ctx.voiceState === 'speaking' ? 'speaking' : o.running > 0 ? 'thinking' : 'listening';
  const headline = o.paused ? 'PAUSED' : ctx.voiceState === 'command' ? 'LISTENING' : ctx.voiceState === 'speaking' ? 'SPEAKING' : o.running ? `${o.running} WORKING` : 'LISTENING';

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 640 }}>
      <aside className="col" style={{ width: 250, padding: '18px 16px', gap: 12 }}>
        {o.engines.map((e) => (
          <EngineStat key={e.name} e={e} api={o.api} />
        ))}
        <div className="panel" style={{ padding: '10px 12px', borderLeft: '3px solid var(--p)' }}>
          <div className="row between mono small">
            <span className="muted">AGENTS LIVE</span>
            <span>
              {o.agentsWorking} / {o.agentsTotal}
            </span>
          </div>
          <div style={{ marginTop: 6 }}>
            <Bar pct={o.agentsTotal ? (o.agentsWorking / o.agentsTotal) * 100 : 0} />
          </div>
        </div>
        <div className="panel" style={{ padding: '10px 12px', borderLeft: '3px solid var(--s)' }}>
          <div className="row between mono small">
            <span className="muted">TODAY</span>
            <span>
              {o.today.ok ?? 0} DONE · {o.queued} QUEUED
            </span>
          </div>
        </div>
        <div className="grow" />
        <button type="button" className={`btn ${o.paused ? 'ok' : 'bad'}`} onClick={() => api('POST', o.paused ? '/api/resume' : '/api/pause').then(() => toast(o.paused ? 'Agents resumed' : 'All agents stopped'))}>
          <Icon name={o.paused ? 'play' : 'stop'} size={14} /> {o.paused ? 'Resume agents' : 'Stop all agents'}
        </button>
      </aside>

      <section style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
        <button type="button" onClick={ctx.activate} aria-label="Talk to Jarvis" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', marginTop: 4 }}>
          <Reactor size={Math.min(560, window.innerHeight - 260)} kind={ctx.settings?.core} state={state} agents={o.agentsWorking * 2 + 3} />
        </button>
        <div className="row mono" style={{ fontSize: 17, letterSpacing: '0.3em', color: o.paused ? 'var(--warn)' : 'var(--p)', marginTop: -4 }}>
          <span className="dot working" style={o.paused ? { background: 'var(--warn)' } : undefined} />
          {headline}
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>
          Say “Jarvis” or press Ctrl+Space
        </div>
        <nav aria-label="Departments" className="row" style={{ position: 'absolute', bottom: 16, left: 16, right: 16, justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
          {hasDepts ? (
            o.departments.map((d) => (
              <a key={d.id} href={`#/dept/${d.id}`} className="row" style={{ padding: '9px 13px', border: `1px solid ${d.color}`, background: 'rgba(0,0,0,0.4)', color: 'var(--text)' }}>
                <span className={`dot ${d.live ? 'working' : ''}`} style={{ background: d.color, boxShadow: `0 0 8px ${d.color}` }} />
                <span style={{ fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '0.12em' }}>{d.name.toUpperCase()}</span>
                <span className="mono small muted">{d.pending ? `${d.pending} NEED YOU` : d.live ? `${d.live} LIVE` : 'IDLE'}</span>
              </a>
            ))
          ) : (
            <button type="button" className="btn primary" onClick={() => go(`/setup/${ctx.orgId}`)}>
              Let Jarvis design this organisation
            </button>
          )}
        </nav>
      </section>

      <aside className="col" style={{ width: 360, padding: '18px 18px', gap: 12, overflow: 'auto' }}>
        <div className={`panel col ${o.needsYou.length || o.connectorsNeeded?.length ? 'warn' : ''}`} style={{ gap: 8 }}>
          <div className="row between">
            <span className={`label ${o.needsYou.length || o.connectorsNeeded?.length ? 'warn' : ''}`}>▶ Needs you</span>
            <span className="mono" style={{ color: 'var(--warn)' }}>{o.needsYou.length + (o.connectorsNeeded?.length ?? 0) || ''}</span>
          </div>
          <ConnectorNotices items={o.connectorsNeeded} compact />
          {o.needsYou.slice(0, 3).map((a) => (
            <ApprovalCard key={a.id} a={a} compact />
          ))}
          {!o.needsYou.length && !o.connectorsNeeded?.length && (
            <div className="faint small">
              Nothing is waiting for you.{o.inReview ? ` ${o.inReview} message(s) are in Jarvis’s review.` : ''}{o.sentToday ? ` ${o.sentToday} sent today.` : ''}
            </div>
          )}
          {o.needsYou.length > 3 && (
            <a href="#/approvals" className="mono small" style={{ color: 'var(--warn)' }}>
              SEE ALL ›
            </a>
          )}
        </div>
        <div className="panel col" style={{ gap: 10 }}>
          <span className="label">▶ Quick commands</span>
          <div className="grid g2" style={{ gap: 8 }}>
            <button type="button" className="btn small" onClick={() => setGiving(true)}>
              New goal / task
            </button>
            <button type="button" className="btn small" onClick={() => api('POST', `/api/orgs/${ctx.orgId}/operator/run`, { mode: 'midday', reason: 'requested by the owner' }).then(() => toast('Jarvis is reviewing the organisation'))}>
              Run Jarvis now
            </button>
            <button type="button" className="btn small" onClick={() => go('/map')}>
              Organisation map
            </button>
            <button type="button" className="btn small" onClick={() => go('/approvals')}>
              Outbox
            </button>
            <button type="button" className="btn small" onClick={ctx.activate}>
              Talk to Jarvis
            </button>
          </div>
        </div>
        <div className="panel col" style={{ gap: 6 }}>
          <span className="label">▶ Jarvis’s plan {o.plan ? <span className="faint">· {ago(o.plan.at)}</span> : null}</span>
          {o.plan ? (
            <div className="small" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{o.plan.text}</div>
          ) : (
            <span className="faint small">{o.autonomy ? 'Jarvis plans every morning after 7:00, starts a new cycle whenever the teams are free, and wakes when replies arrive. Or press “Run Jarvis now”.' : 'Autonomy is off (Settings).'}</span>
          )}
        </div>
        <div className="panel col" style={{ gap: 4 }}>
          <span className="label">▶ Live</span>
          {(o.activity ?? []).slice(0, 12).map((a) => (
            <div key={a.id} className="small" style={{ display: 'flex', gap: 8, lineHeight: 1.45 }}>
              <span className="faint mono" style={{ flexShrink: 0 }}>{ago(a.ts)}</span>
              <span className={a.kind === 'progress' || a.kind === 'lead' || a.kind === 'action' ? '' : 'muted'}>
                <b>{a.agent}</b> {a.text}
              </span>
            </div>
          ))}
          {!(o.activity ?? []).length && <span className="faint small">Nothing happening yet.</span>}
        </div>
        <div className="panel col" style={{ gap: 8 }}>
          <span className="label">▶ Command</span>
          <CommandBox orgId={ctx.orgId} />
        </div>
      </aside>
      {giving && <GiveTask target={{ type: 'org', id: ctx.orgId }} title="Give Jarvis a goal or task" onClose={() => setGiving(false)} />}
    </div>
  );
}

// Used everywhere work is handed out: org, department, team, agent or personal.
export function GiveTask({ target, title, projectId = null, onClose }) {
  const [form, setForm] = useState({ title: '', instructions: '', dod: '', priority: 50 });
  const submit = async (e) => {
    e.preventDefault();
    try {
      const { id } = await api('POST', '/api/tasks', { target, title: form.title, instructions: form.instructions, dod: form.dod, priority: Number(form.priority), project_id: projectId });
      toast('Task handed over');
      onClose(id);
    } catch (err) {
      toast(err.message, true);
    }
  };
  return (
    <Modal title={title} onClose={() => onClose()}>
      <form className="col" onSubmit={submit} style={{ gap: 12 }}>
        <label className="field">
          <span>What should be done?</span>
          <input className="input" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus placeholder="e.g. Find 20 dental clinics that need a new website" />
        </label>
        <label className="field">
          <span>Details (optional)</span>
          <textarea className="input" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Who, what, tone, deadline…" />
        </label>
        <label className="field">
          <span>Definition of done (what must exist when finished)</span>
          <textarea className="input" style={{ minHeight: 70 }} value={form.dod} onChange={(e) => setForm({ ...form, dod: e.target.value })} placeholder="e.g. crm/leads.csv has 20 verified rows with source URLs; 10 intro emails proposed" />
        </label>
        <label className="field">
          <span>Priority: {form.priority}</span>
          <input type="range" min="1" max="100" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
        </label>
        <button className="btn primary">Hand it over</button>
      </form>
    </Modal>
  );
}

export function PersonalHome({ ctx }) {
  const projects = useData('/api/projects');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [giving, setGiving] = useState(false);
  const list = projects.data ?? [];
  const current = list.find((p) => p.id === selected) ?? list[0];
  const tasks = useData(current ? `/api/projects/${current.id}` : null, [current?.id]);
  const o = ctx.overview;
  const state = ctx.voiceState === 'speaking' ? 'speaking' : o?.running ? 'thinking' : 'listening';

  const create = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { id } = await api('POST', '/api/projects', { name: f.get('name'), description: f.get('description') });
    setSelected(id);
    setCreating(false);
    toast('Project created');
  };

  return (
    <div style={{ display: 'flex', gap: 20, padding: '18px 22px', height: '100%', minHeight: 620 }}>
      <section className="col" style={{ width: 320, alignItems: 'center', gap: 12 }}>
        <button type="button" onClick={ctx.activate} aria-label="Talk to Jarvis" style={{ background: 'none', border: 0, cursor: 'pointer' }}>
          <Reactor size={270} compass={false} kind={ctx.settings?.core} state={state} />
        </button>
        <div className="row mono" style={{ letterSpacing: '0.3em', color: 'var(--p)' }}>
          <span className="dot working" />
          {ctx.voiceState === 'speaking' ? 'SPEAKING' : 'LISTENING'}
        </div>
        <div className="panel col" style={{ width: '100%', gap: 6 }}>
          <span className="label">▶ Latest</span>
          <span className="small muted" style={{ lineHeight: 1.55 }}>
            {o?.lastOutput?.summary || 'Create a project, then give Jarvis a task or just ask.'}
          </span>
        </div>
        <div className="panel" style={{ width: '100%' }}>
          <CommandBox orgId={null} placeholder="Ask Jarvis anything…" />
        </div>
      </section>

      <section className="col grow" style={{ gap: 14 }}>
        <div className="row between">
          <h1 style={{ fontSize: 26 }}>PROJECTS</h1>
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            + New project
          </button>
        </div>
        <div className="grid g2">
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p.id)}
              className={`panel col ${current?.id === p.id ? 'hot' : ''}`}
              style={{ textAlign: 'left', color: 'var(--text)', borderLeft: `4px solid ${p.color}`, cursor: 'pointer', gap: 8 }}
            >
              <div className="row between">
                <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 19 }}>{p.name}</span>
                <span className="mono small" style={{ color: p.color }}>
                  {p.done ?? 0} / {p.total}
                </span>
              </div>
              <Bar pct={p.total ? ((p.done ?? 0) / p.total) * 100 : 0} color={p.color} />
              <span className="small muted ellipsis">{p.next ? `Next: ${p.next}` : p.description || 'No open tasks'}</span>
            </button>
          ))}
          {!list.length && <div className="empty panel">No projects yet. Create your first one.</div>}
        </div>
      </section>

      {current && (
        <section className="panel col" style={{ width: 380, gap: 10, overflow: 'auto' }}>
          <div className="row between">
            <div>
              <span className="label warn">Project</span>
              <h2 style={{ fontSize: 22 }}>{current.name}</h2>
            </div>
            <button type="button" className="btn small primary" onClick={() => setGiving(true)}>
              + Task
            </button>
          </div>
          {(tasks.data?.tasks ?? []).map((t) => (
            <a key={t.id} href={`#/task/${t.id}`} className="list-item" style={{ color: 'var(--text)', paddingLeft: t.depth * 14 }}>
              <div className="grow">
                <div className="t ellipsis">{t.title}</div>
                <div className="small faint">
                  {t.agent_name} · {ago(t.finished_at || t.created_at)}
                </div>
              </div>
              <Pill status={t.status} />
            </a>
          ))}
          {tasks.data && !tasks.data.tasks.length && <div className="empty">No tasks yet.</div>}
          <a href={`#/project/${current.id}`} className="mono small">
            OPEN PROJECT ›
          </a>
        </section>
      )}

      {creating && (
        <Modal title="New personal project" onClose={() => setCreating(false)}>
          <form className="col" onSubmit={create} style={{ gap: 12 }}>
            <label className="field">
              <span>Name</span>
              <input className="input" name="name" required autoFocus placeholder="e.g. Book launch, Fitness plan, House move" />
            </label>
            <label className="field">
              <span>What is it about? (its mind)</span>
              <textarea className="input" name="description" placeholder="Goal, what success looks like, preferences…" />
            </label>
            <button className="btn primary">Create project</button>
          </form>
        </Modal>
      )}
      {giving && current && <GiveTask target={{ type: 'personal' }} projectId={current.id} title={`New task for ${current.name}`} onClose={() => setGiving(false)} />}
    </div>
  );
}
