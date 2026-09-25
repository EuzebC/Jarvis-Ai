import { one, all, insert, run, tx, now } from './db.js';
import { log, notify } from './events.js';
import { extractJson } from './protocol.js';
import { engine } from './engine.js';
import { workDir } from './mind.js';
import { DEPARTMENT_COLORS, ensureOrgJarvis, periodLabels } from './agents.js';

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const GRADES = ['strong', 'worker', 'bulk', 'auto'];

function prompt(org) {
  const p = periodLabels();
  return `Design the AI team for this organisation.

ORGANISATION: ${org.name}
DESCRIPTION: ${org.description || '(none)'}
PROFILE: ${org.profile || '(none)'}

Propose a lean structure (3 to 6 departments). Each department has a head, 1 to 3 teams, and each team has a leader and
1 to 4 worker agents with specific jobs. Focus on work that brings in money and serves customers. Give goals for
${p.quarter} (quarter), ${p.month} (month) and ${p.week} (week) with measurable titles, and 2 to 4 KPIs per department and per team.
For each worker choose "grade": "bulk" for high-volume simple work (lead finding, data entry), "worker" for writing and
analysis, and "web": true if it needs internet research.

Reply with only one json block of this exact shape:
{"org_goals":[{"period":"quarter|month|week","title":""}],
 "departments":[{"name":"","description":"",
   "head":{"name":"","role":"","instructions":""},
   "goals":[{"period":"quarter|month|week","title":""}],
   "kpis":[{"name":"","target":0,"unit":""}],
   "teams":[{"name":"","description":"",
     "leader":{"name":"","role":"","instructions":""},
     "kpis":[{"name":"","target":0,"unit":""}],
     "agents":[{"name":"","role":"","instructions":"","grade":"worker","web":false}]}]}]}
Use short, memorable agent names (like Nova, Atlas, Echo).`;
}

// Keeps only well-formed parts of a proposal so a sloppy answer can't create broken records.
export function normaliseDraft(raw) {
  const agent = (a) => ({ name: str(a?.name, 40), role: str(a?.role, 80), instructions: str(a?.instructions, 1500), grade: GRADES.includes(a?.grade) ? a.grade : 'auto', web: Boolean(a?.web) });
  const kpi = (k) => ({ name: str(k?.name, 80), target: Number.isFinite(Number(k?.target)) ? Number(k.target) : null, unit: str(k?.unit, 12) });
  const goal = (g) => ({ period: ['quarter', 'month', 'week'].includes(g?.period) ? g.period : 'month', title: str(g?.title, 200) });
  return {
    org_goals: arr(raw?.org_goals).map(goal).filter((g) => g.title),
    departments: arr(raw?.departments)
      .slice(0, 8)
      .map((d) => ({
        name: str(d?.name, 60),
        description: str(d?.description),
        head: agent(d?.head),
        goals: arr(d?.goals).map(goal).filter((g) => g.title),
        kpis: arr(d?.kpis).map(kpi).filter((k) => k.name),
        teams: arr(d?.teams)
          .slice(0, 5)
          .map((t) => ({
            name: str(t?.name, 60),
            description: str(t?.description),
            leader: agent(t?.leader),
            kpis: arr(t?.kpis).map(kpi).filter((k) => k.name),
            agents: arr(t?.agents).slice(0, 6).map(agent).filter((a) => a.name && a.role),
          }))
          .filter((t) => t.name && t.leader.name),
      }))
      .filter((d) => d.name && d.head.name),
  };
}

export async function proposeStructure(orgId) {
  const org = one('SELECT * FROM orgs WHERE id = ?', orgId);
  const draftId = insert(`INSERT INTO drafts (org_id, status, created_at) VALUES (?, 'generating', ?)`, orgId, now());
  notify('drafts', { orgId });
  const jarvis = one('SELECT * FROM agents WHERE id = ?', ensureOrgJarvis(orgId));
  log('info', `Jarvis is designing the structure for ${org.name}`, orgId);
  const res = await engine.ask({ ...jarvis, web: 0 }, { prompt: prompt(org), system: 'You are an expert organisation designer for AI agent teams. Reply with JSON only.', cwd: workDir({ orgId }) });
  const parsed = res.ok ? normaliseDraft(extractJson(res.text)) : null;
  if (parsed?.departments.length) {
    run(`UPDATE drafts SET status = 'ready', body = ? WHERE id = ?`, JSON.stringify(parsed), draftId);
    log('info', `Structure proposal ready for ${org.name}: ${parsed.departments.length} departments`, orgId);
  } else {
    run(`UPDATE drafts SET status = 'failed', error = ? WHERE id = ?`, res.error || 'Jarvis did not return a usable structure. Try again.', draftId);
    log('error', `Structure proposal failed for ${org.name}: ${res.error || 'unusable answer'}`, orgId);
  }
  notify('drafts', { orgId });
  return draftId;
}

export function applyDraft(orgId, body) {
  const draft = normaliseDraft(body);
  const p = periodLabels();
  const labelOf = (period) => p[period];
  const t = now();
  tx(() => {
    const existing = one('SELECT COUNT(*) AS n FROM departments WHERE org_id = ?', orgId).n;
    for (const g of draft.org_goals) {
      insert('INSERT INTO goals (org_id, scope, scope_id, period, period_label, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', orgId, 'org', orgId, g.period, labelOf(g.period), g.title, t, t);
    }
    draft.departments.forEach((d, i) => {
      const deptId = insert(
        'INSERT INTO departments (org_id, name, description, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        orgId,
        d.name,
        d.description,
        DEPARTMENT_COLORS[(existing + i) % DEPARTMENT_COLORS.length],
        existing + i,
        t,
      );
      insert(`INSERT INTO agents (org_id, department_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, 'head', 'auto', 1, ?)`, orgId, deptId, d.head.name, d.head.role || `Head of ${d.name}`, d.head.instructions, t);
      for (const g of d.goals) insert('INSERT INTO goals (org_id, scope, scope_id, period, period_label, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', orgId, 'department', deptId, g.period, labelOf(g.period), g.title, t, t);
      for (const k of d.kpis) insert('INSERT INTO kpis (org_id, scope, scope_id, name, target, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', orgId, 'department', deptId, k.name, k.target, k.unit, t);
      d.teams.forEach((tm, j) => {
        const teamId = insert('INSERT INTO teams (department_id, name, description, position, created_at) VALUES (?, ?, ?, ?, ?)', deptId, tm.name, tm.description, j, t);
        insert(`INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, ?, 'leader', 'auto', 1, ?)`, orgId, deptId, teamId, tm.leader.name, tm.leader.role || `${tm.name} leader`, tm.leader.instructions, t);
        for (const a of tm.agents) {
          insert(`INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, ?, 'worker', ?, ?, ?)`, orgId, deptId, teamId, a.name, a.role, a.instructions, a.grade, a.web ? 1 : 0, t);
        }
        for (const k of tm.kpis) insert('INSERT INTO kpis (org_id, scope, scope_id, name, target, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', orgId, 'team', teamId, k.name, k.target, k.unit, t);
      });
    });
    run(`UPDATE drafts SET status = 'applied' WHERE org_id = ? AND status = 'ready'`, orgId);
  });
  log('info', `Applied structure: ${draft.departments.length} departments created`, orgId);
  notify('org', { orgId });
}

export const latestDraft = (orgId) => {
  const d = one('SELECT * FROM drafts WHERE org_id = ? ORDER BY id DESC LIMIT 1', orgId);
  return d ? { ...d, body: d.body ? JSON.parse(d.body) : null } : null;
};

export const departmentsOf = (orgId) => all('SELECT * FROM departments WHERE org_id = ? ORDER BY position, id', orgId);
