import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { Modal, Switch, Bar, toast, withUnit } from '../components/ui.jsx';
import { GiveTask } from './Home.jsx';
import { KpiEditor, KpiRows, GoalEditor } from './Department.jsx';

const GRADE_LABEL = { auto: 'Smart', strong: 'Opus', worker: 'Sonnet', bulk: 'Haiku', codex: 'Codex' };

function AgentEditor({ agent, teamId, onClose }) {
  const [f, setF] = useState({ name: agent?.name ?? '', role: agent?.role ?? '', instructions: agent?.instructions ?? '', model: agent?.model ?? 'auto', web: Boolean(agent?.web) });
  const save = async (e) => {
    e.preventDefault();
    if (agent) await api('PUT', `/api/agents/${agent.id}`, f);
    else await api('POST', '/api/agents', { ...f, team_id: teamId, tier: 'worker' });
    toast(agent ? 'Agent updated' : 'Agent added to the team');
    onClose();
  };
  return (
    <Modal title={agent ? `Edit ${agent.name}` : 'New agent'} onClose={onClose}>
      <form className="col" onSubmit={save} style={{ gap: 12 }}>
        <div className="grid g2">
          <label className="field">
            <span>Name</span>
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />
          </label>
          <label className="field">
            <span>Role</span>
            <input className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} required placeholder="e.g. Proposal writer" />
          </label>
        </div>
        <label className="field">
          <span>Instructions</span>
          <textarea className="input" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} placeholder="How this agent should work" />
        </label>
        <div className="grid g2">
          <label className="field">
            <span>Model</span>
            <select className="input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
              <option value="auto">Smart routing</option>
              <option value="strong">Strongest (Opus)</option>
              <option value="worker">Balanced (Sonnet)</option>
              <option value="bulk">Fast and cheap (Haiku)</option>
              <option value="codex">Codex (coding)</option>
            </select>
          </label>
          <label className="row" style={{ marginTop: 22 }}>
            <input type="checkbox" checked={f.web} onChange={(e) => setF({ ...f, web: e.target.checked })} />
            <span className="small">Can search the web</span>
          </label>
        </div>
        <div className="row">
          {agent && agent.tier === 'worker' && (
            <button type="button" className="btn bad" onClick={() => api('DELETE', `/api/agents/${agent.id}`).then(onClose)}>
              Remove
            </button>
          )}
          <button className="btn primary grow">Save</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Team({ ctx, id }) {
  const team = useData(`/api/teams/${id}`, [id]);
  const t = team.data;
  const [modal, setModal] = useState(null);
  useEffect(() => {
    if (t?.department?.color) ctx.setRetintColor(t.department.color);
  }, [t?.department?.color, ctx]);
  if (!t) return null;
  const close = () => setModal(null);

  const review = (x) => x.created_by.startsWith('review:');
  const columns = [
    ['QUEUED', (x) => x.status === 'queued' && !review(x), 'var(--muted)'],
    ['WORKING', (x) => x.status === 'running' && !review(x), 'var(--p)'],
    ['LEADER REVIEW', (x) => review(x) && ['queued', 'running'].includes(x.status), 'var(--s)'],
    ['DONE', (x) => x.status === 'done', 'var(--ok)'],
  ];
  const goal = t.deptGoals.find((g) => g.period === 'week') ?? t.goals[0];

  return (
    <div className="page-pad col" style={{ gap: 16 }}>
      <div className="row between">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="#/">HOME</a> › <a href="#/map">{t.org.name.toUpperCase()}</a> › <a href={`#/dept/${t.department.id}`}>{t.department.name.toUpperCase()}</a> ›{' '}
          <span className="here">{t.name.toUpperCase()} TEAM</span>
        </nav>
        <div className="row">
          {goal && (
            <span className="mono small muted">
              {goal.period_label.toUpperCase()} · {goal.title} · <span style={{ color: 'var(--p)' }}>{goal.progress}%</span>
            </span>
          )}
          <button type="button" className="btn" onClick={() => setModal('agent')}>
            + Agent
          </button>
          <button type="button" className="btn primary" onClick={() => setModal('task')}>
            Give team a task
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        <section className="col" style={{ width: 330, gap: 12, flexShrink: 0 }}>
          {t.leader && (
            <div className="panel hot col" style={{ gap: 10 }}>
              <div className="row">
                <div style={{ width: 50, height: 50, borderRadius: '50%', border: '2px solid var(--p)', display: 'grid', placeItems: 'center', fontFamily: 'var(--display)', fontWeight: 700, fontSize: 22 }}>{t.leader.name[0]}</div>
                <div className="grow">
                  <span className="label">Team leader</span>
                  <div style={{ fontSize: 17, fontWeight: 600 }}>{t.leader.name}</div>
                  <div className="small muted">
                    {t.leader.role} · {GRADE_LABEL[t.leader.model]}
                  </div>
                </div>
                <button type="button" className="linkbtn" onClick={() => setModal({ agent: t.leader })}>
                  EDIT
                </button>
              </div>
              <div className="small" style={{ lineHeight: 1.5, color: 'var(--muted)' }}>
                {t.leader.instructions || 'Turns tasks into assignments for the team, checks quality and reports to the department head.'}
              </div>
              <div className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                <div>
                  <div style={{ fontSize: 13 }}>Can approve outgoing work</div>
                  <div className="small faint">{t.leader_can_approve ? 'On: reviews emails and proposals before they go out' : 'Off until you trust this team'}</div>
                </div>
                <Switch checked={Boolean(t.leader_can_approve)} label="Let the team leader approve outgoing work" onChange={(v) => api('PUT', `/api/teams/${t.id}`, { leader_can_approve: v }).then(() => toast(v ? 'Leader approval on' : 'Back to your approval'))} />
              </div>
            </div>
          )}
          {t.agents.map((a) => (
            <button key={a.id} type="button" className="panel col" onClick={() => setModal({ agent: a })} style={{ gap: 6, textAlign: 'left', color: 'var(--text)', cursor: 'pointer' }}>
              <div className="row">
                <span className={`dot ${a.status === 'working' ? 'working' : 'idle'}`} />
                <span style={{ fontWeight: 600 }}>{a.name}</span>
                <span className="small muted grow ellipsis">{a.role}</span>
                <span className="mono small faint">{GRADE_LABEL[a.model]}{a.web ? ' · WEB' : ''}</span>
              </div>
              <div className="small" style={{ color: a.current ? 'var(--text)' : 'var(--faint)' }}>{a.current ? a.current.title : 'Idle'}</div>
              {a.kpis.map((k) => (
                <div key={k.id} className="col" style={{ gap: 3 }}>
                  <div className="row between mono small">
                    <span className="muted">{k.name}</span>
                    <span>
                      {withUnit(k.actual, k.unit)} / {withUnit(k.target, k.unit)}
                    </span>
                  </div>
                  <Bar pct={k.target ? (k.actual / k.target) * 100 : 0} />
                </div>
              ))}
            </button>
          ))}
          {!t.agents.length && <div className="empty panel">No agents yet. Add one.</div>}
        </section>

        <section className="col grow" style={{ gap: 14, minWidth: 0 }}>
          <div className="grid g4">
            {columns.map(([name, test, color]) => {
              const cards = t.tasks.filter(test);
              return (
                <div key={name} className="panel col" style={{ gap: 8, minHeight: 260 }}>
                  <div className="row between mono small" style={{ letterSpacing: '0.12em' }}>
                    <span style={{ color }}>▶ {name}</span>
                    <span className="faint">{cards.length}</span>
                  </div>
                  {cards.slice(0, 12).map((x) => (
                    <a key={x.id} href={`#/task/${x.id}`} className="col" style={{ padding: '9px 11px', borderTop: `2px solid ${color}`, background: 'rgba(0,0,0,0.45)', color: 'var(--text)', gap: 4 }}>
                      <span style={{ fontSize: 13, lineHeight: 1.35 }}>{x.title}</span>
                      <span className="small faint">{x.agent_name}</span>
                    </a>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="grid g2">
            <div className="panel col" style={{ gap: 6 }}>
              <div className="row between">
                <span className="label">▶ Team KPIs</span>
                <button type="button" className="linkbtn" onClick={() => setModal('kpi')}>
                  + ADD KPI
                </button>
              </div>
              <KpiRows rows={t.kpis} onEdit={(k) => setModal({ kpi: k })} />
              {!t.kpis.length && <div className="empty">No KPIs yet.</div>}
            </div>
            <div className="panel col" style={{ gap: 8 }}>
              <div className="row between">
                <span className="label">▶ Team goals</span>
                <button type="button" className="linkbtn" onClick={() => setModal('goal')}>
                  + ADD GOAL
                </button>
              </div>
              {t.goals.map((g) => (
                <button key={g.id} type="button" onClick={() => setModal({ goal: g })} className="col" style={{ gap: 4, background: 'none', border: 0, color: 'var(--text)', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
                  <div className="row between small">
                    <span>
                      <span className="mono" style={{ color: 'var(--p)' }}>{g.period_label}</span> {g.title}
                    </span>
                    <span className="mono">{g.progress}%</span>
                  </div>
                  <Bar pct={g.progress} />
                </button>
              ))}
              {!t.goals.length && <div className="empty">No team goals yet.</div>}
            </div>
          </div>
        </section>
      </div>

      {modal === 'task' && <GiveTask target={{ type: 'team', id: t.id }} title={`Give ${t.name} a task`} onClose={close} />}
      {modal === 'agent' && <AgentEditor teamId={t.id} onClose={close} />}
      {modal?.agent && <AgentEditor agent={modal.agent} teamId={t.id} onClose={close} />}
      {modal === 'kpi' && (
        <KpiEditor
          scopes={[{ value: `team:${t.id}`, label: `${t.name} (team)` }, ...t.agents.map((a) => ({ value: `agent:${a.id}`, label: `${a.name} (agent)` }))]}
          orgId={t.org.id}
          onClose={close}
        />
      )}
      {modal?.kpi && <KpiEditor kpi={modal.kpi} onClose={close} />}
      {modal === 'goal' && <GoalEditor scope={{ org_id: t.org.id, scope: 'team', scope_id: t.id }} onClose={close} />}
      {modal?.goal && <GoalEditor goal={modal.goal} onClose={close} />}
    </div>
  );
}
