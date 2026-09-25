import { useEffect, useState } from 'react';
import { api, useData } from '../api.js';
import { Gauge, Modal, Switch, Spark, Pill, toast, withUnit } from '../components/ui.jsx';
import { GiveTask } from './Home.jsx';
import { ApprovalCard } from './Approvals.jsx';

export function GoalEditor({ goal, scope, onClose }) {
  const [title, setTitle] = useState(goal?.title ?? '');
  const [progress, setProgress] = useState(goal?.progress ?? 0);
  const [period, setPeriod] = useState(goal?.period ?? 'month');
  const save = async (e) => {
    e.preventDefault();
    if (goal) await api('PUT', `/api/goals/${goal.id}`, { title, progress });
    else await api('POST', '/api/goals', { ...scope, period, title });
    toast('Goal saved');
    onClose();
  };
  return (
    <Modal title={goal ? 'Edit goal' : 'New goal'} onClose={onClose}>
      <form className="col" onSubmit={save} style={{ gap: 12 }}>
        {!goal && (
          <label className="field">
            <span>Period</span>
            <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="quarter">Quarter</option>
              <option value="month">Month</option>
              <option value="week">Week</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Goal</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder="e.g. Close 10 new clients" />
        </label>
        {goal && (
          <label className="field">
            <span>Progress: {progress}%</span>
            <input type="range" min="0" max="100" value={progress} onChange={(e) => setProgress(Number(e.target.value))} />
          </label>
        )}
        <div className="row">
          {goal && (
            <button type="button" className="btn bad" onClick={() => api('DELETE', `/api/goals/${goal.id}`).then(onClose)}>
              Delete
            </button>
          )}
          <button className="btn primary grow">Save</button>
        </div>
      </form>
    </Modal>
  );
}

export function KpiEditor({ kpi, scopes, orgId, onClose }) {
  const [f, setF] = useState({ name: kpi?.name ?? '', target: kpi?.target ?? '', actual: kpi?.actual ?? 0, unit: kpi?.unit ?? '', scope: scopes?.[0]?.value ?? '' });
  const save = async (e) => {
    e.preventDefault();
    if (kpi) await api('PUT', `/api/kpis/${kpi.id}`, f);
    else {
      const [scope, scopeId] = f.scope.split(':');
      await api('POST', '/api/kpis', { org_id: orgId, scope, scope_id: Number(scopeId), name: f.name, target: f.target, unit: f.unit });
    }
    toast('KPI saved');
    onClose();
  };
  return (
    <Modal title={kpi ? 'Edit KPI' : 'New KPI'} onClose={onClose}>
      <form className="col" onSubmit={save} style={{ gap: 12 }}>
        {!kpi && (
          <label className="field">
            <span>For</span>
            <select className="input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
              {scopes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>KPI</span>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="e.g. Proposals sent per week" />
        </label>
        <div className="grid g3">
          <label className="field">
            <span>Target</span>
            <input className="input" value={f.target ?? ''} onChange={(e) => setF({ ...f, target: e.target.value })} inputMode="decimal" />
          </label>
          {kpi && (
            <label className="field">
              <span>Actual</span>
              <input className="input" value={f.actual} onChange={(e) => setF({ ...f, actual: e.target.value })} inputMode="decimal" />
            </label>
          )}
          <label className="field">
            <span>Unit</span>
            <input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="%, $, calls" />
          </label>
        </div>
        <div className="row">
          {kpi && (
            <button type="button" className="btn bad" onClick={() => api('DELETE', `/api/kpis/${kpi.id}`).then(onClose)}>
              Delete
            </button>
          )}
          <button className="btn primary grow">Save</button>
        </div>
      </form>
    </Modal>
  );
}

export function KpiRows({ rows, onEdit, showOwner }) {
  return rows.map((k) => {
    const good = k.target == null ? true : k.higher_is_better ? k.actual >= k.target : k.actual <= k.target;
    return (
      <button
        key={k.id}
        type="button"
        onClick={() => onEdit(k)}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 120px 110px 130px', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line-soft)', background: 'none', border: 0, borderBottomStyle: 'solid', color: 'var(--text)', textAlign: 'left', cursor: 'pointer', width: '100%' }}
      >
        <span className="ellipsis">
          {showOwner && k.owner && <span className="mono small" style={{ color: 'var(--p)' }}>{k.owner} · </span>}
          {k.name}
        </span>
        <span className="mono small muted">TGT {withUnit(k.target, k.unit)}</span>
        <span className="mono" style={{ color: good ? 'var(--ok)' : 'var(--bad)' }}>{withUnit(k.actual, k.unit)}</span>
        <Spark history={JSON.parse(k.history || '[]')} color={good ? 'var(--ok)' : 'var(--bad)'} />
      </button>
    );
  });
}

export default function Department({ ctx, id }) {
  const dept = useData(`/api/departments/${id}`, [id]);
  const d = dept.data;
  const [tab, setTab] = useState('department');
  const [modal, setModal] = useState(null);
  useEffect(() => {
    if (d?.color) ctx.setRetintColor(d.color);
  }, [d?.color, ctx]);
  if (!d) return null;

  const periods = ['quarter', 'month', 'week'];
  const goals = periods.map((p) => d.goals.find((g) => g.period === p));
  const kpiRows =
    tab === 'department'
      ? d.kpis
      : tab === 'teams'
        ? d.teams.flatMap((t) => t.kpis.map((k) => ({ ...k, owner: t.name })))
        : d.agentKpis.map((k) => ({ ...k, owner: k.agent_name }));
  const kpiScopes = [{ value: `department:${d.id}`, label: `${d.name} (department)` }, ...d.teams.map((t) => ({ value: `team:${t.id}`, label: `${t.name} (team)` }))];
  const close = () => setModal(null);

  const addTeam = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('POST', `/api/departments/${d.id}/teams`, { name: f.get('name'), description: f.get('description'), leaderName: f.get('leaderName'), leaderRole: f.get('leaderRole') });
    toast('Team created');
    close();
  };

  return (
    <div className="page-pad col" style={{ gap: 16 }}>
      <div className="row between">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="#/">HOME</a> › <a href="#/map">{d.org.name.toUpperCase()}</a> › <span className="here">{d.name.toUpperCase()}</span>
        </nav>
        <div className="row">
          <button type="button" className="btn" onClick={() => setModal('team')}>
            + Team
          </button>
          <button type="button" className="btn primary" onClick={() => setModal('task')}>
            Give {d.name} a task
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        <section className="col" style={{ width: 310, gap: 12, flexShrink: 0 }}>
          {d.head && (
            <div className="panel hot row" style={{ gap: 12 }}>
              <div style={{ width: 50, height: 50, borderRadius: '50%', border: '2px solid var(--p)', display: 'grid', placeItems: 'center', fontFamily: 'var(--display)', fontWeight: 700, fontSize: 22 }}>{d.head.name[0]}</div>
              <div className="grow">
                <span className="label">Head of department</span>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{d.head.name}</div>
                <div className="small muted">{d.head.role}</div>
              </div>
            </div>
          )}
          <span className="label">▶ Teams</span>
          {d.teams.map((t) => (
            <a key={t.id} href={`#/team/${t.id}`} className="panel col" style={{ color: 'var(--text)', gap: 6 }}>
              <div className="row between">
                <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 17, letterSpacing: '0.08em' }}>{t.name.toUpperCase()}</span>
                <span className="mono small" style={{ color: t.pending ? 'var(--warn)' : t.open ? 'var(--p)' : 'var(--faint)' }}>
                  {t.pending ? `${t.pending} NEED YOU` : t.open ? `${t.open} OPEN` : 'IDLE'}
                </span>
              </div>
              <div className="small muted">
                Leader {t.leader?.name ?? '—'} · {t.agents.length} agent{t.agents.length === 1 ? '' : 's'}
              </div>
              <div className="row" style={{ gap: 4 }}>
                {[t.leader, ...t.agents].filter(Boolean).map((a) => (
                  <span key={a.id} title={`${a.name}: ${a.status}`} style={{ width: 16, height: 6, background: a.status === 'working' ? 'var(--p)' : 'var(--line)' }} />
                ))}
              </div>
            </a>
          ))}
          <button type="button" className="btn" onClick={() => setModal('team')}>
            + Create a team
          </button>
        </section>

        <section className="col grow" style={{ gap: 14, minWidth: 0 }}>
          <div className="grid g3">
            {goals.map((g, i) => (
              <button key={periods[i]} type="button" className="panel col" onClick={() => setModal(g ? { goal: g } : { newGoal: periods[i] })} style={{ alignItems: 'center', gap: 6, color: 'var(--text)', cursor: 'pointer' }}>
                <span className="label">{g ? g.period_label : periods[i]}</span>
                <Gauge pct={g?.progress ?? 0} label={g?.title} />
                <span style={{ textAlign: 'center', lineHeight: 1.35, fontSize: 14 }}>{g?.title ?? `+ Add a ${periods[i]} goal`}</span>
              </button>
            ))}
          </div>
          <div className="panel col" style={{ gap: 6 }}>
            <div className="row">
              <span className="label">▶ KPIs</span>
              <div className="seg">
                {['department', 'teams', 'agents'].map((t) => (
                  <button key={t} type="button" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="grow" />
              <button type="button" className="linkbtn" onClick={() => setModal('kpi')}>
                + ADD KPI
              </button>
            </div>
            <KpiRows rows={kpiRows} showOwner={tab !== 'department'} onEdit={(k) => setModal({ kpi: k })} />
            {!kpiRows.length && <div className="empty">No KPIs here yet.</div>}
          </div>
        </section>

        <section className="col" style={{ width: 320, gap: 12, flexShrink: 0 }}>
          <div className="panel col" style={{ gap: 12 }}>
            <span className="label">▶ Who approves outgoing work</span>
            {d.teams.map((t) => (
              <div key={t.id} className="row between">
                <div>
                  <div style={{ fontSize: 13 }}>{t.name} leader can approve</div>
                  <div className="small faint">{t.leader_can_approve ? `${t.leader?.name ?? 'Leader'} reviews and sends` : 'Off: waits for you'}</div>
                </div>
                <Switch
                  checked={Boolean(t.leader_can_approve)}
                  label={`Let the ${t.name} leader approve outgoing work`}
                  onChange={(v) => api('PUT', `/api/teams/${t.id}`, { leader_can_approve: v }).then(() => toast(v ? `${t.leader?.name ?? 'The leader'} can now approve for ${t.name}` : 'Back to your approval'))}
                />
              </div>
            ))}
            <div className="row between" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
              <span style={{ fontSize: 13 }}>Payments</span>
              <span className="mono small" style={{ color: 'var(--s)' }}>ALWAYS YOU · LOCKED</span>
            </div>
          </div>
          {d.needsYou.length > 0 && (
            <div className="panel warn col" style={{ gap: 8 }}>
              <span className="label warn">▶ Needs you · {d.needsYou.length}</span>
              {d.needsYou.slice(0, 3).map((a) => (
                <ApprovalCard key={a.id} a={a} compact />
              ))}
            </div>
          )}
          <div className="panel col" style={{ gap: 2 }}>
            <span className="label">▶ Recent work</span>
            {d.tasks.map((t) => (
              <a key={t.id} href={`#/task/${t.id}`} className="list-item" style={{ color: 'var(--text)' }}>
                <span className="t grow ellipsis small">{t.title}</span>
                <Pill status={t.status} />
              </a>
            ))}
            {!d.tasks.length && <div className="empty">No work yet.</div>}
          </div>
        </section>
      </div>

      {modal === 'task' && <GiveTask target={{ type: 'department', id: d.id }} title={`Give ${d.name} a task`} onClose={close} />}
      {modal === 'kpi' && <KpiEditor scopes={kpiScopes} orgId={d.org_id} onClose={close} />}
      {modal?.kpi && <KpiEditor kpi={modal.kpi} onClose={close} />}
      {modal?.goal && <GoalEditor goal={modal.goal} onClose={close} />}
      {modal?.newGoal && <GoalEditorNew period={modal.newGoal} scope={{ org_id: d.org_id, scope: 'department', scope_id: d.id }} onClose={close} />}
      {modal === 'team' && (
        <Modal title={`New team in ${d.name}`} onClose={close}>
          <form className="col" onSubmit={addTeam} style={{ gap: 12 }}>
            <label className="field">
              <span>Team name</span>
              <input className="input" name="name" required autoFocus placeholder="e.g. Outreach" />
            </label>
            <label className="field">
              <span>What does it handle?</span>
              <input className="input" name="description" />
            </label>
            <div className="grid g2">
              <label className="field">
                <span>Team leader name</span>
                <input className="input" name="leaderName" placeholder="e.g. Atlas" />
              </label>
              <label className="field">
                <span>Leader's role</span>
                <input className="input" name="leaderRole" placeholder="Outreach leader" />
              </label>
            </div>
            <button className="btn primary">Create team</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function GoalEditorNew({ period, scope, onClose }) {
  const [title, setTitle] = useState('');
  const save = async (e) => {
    e.preventDefault();
    await api('POST', '/api/goals', { ...scope, period, title });
    toast('Goal added');
    onClose();
  };
  return (
    <Modal title={`New ${period} goal`} onClose={onClose}>
      <form className="col" onSubmit={save} style={{ gap: 12 }}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder="A measurable goal" aria-label="Goal" />
        <button className="btn primary">Add goal</button>
      </form>
    </Modal>
  );
}
