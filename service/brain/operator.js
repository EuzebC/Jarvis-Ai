// The Operator: Jarvis running an organisation on its own. It wakes up every morning, again during
// the day, and on events (a reply, a finished mission), looks at the real state, decides what the
// organisation should do next, creates missions for departments and teams, and writes the day's plan.
// It never asks the owner what to do; the owner sees the plan and the approvals.
import fs from 'node:fs';
import path from 'node:path';
import { one, all, run, insert, now, getSetting, setSetting } from '../db.js';
import { log, notify } from '../events.js';
import { runSession } from './runtime.js';
import { jarvisTools, recordActivity } from './tools.js';
import { writeClaudeMd, readMemory, scopeDir } from './workspace.js';
import { createMission, scheduler } from './missions.js';
import { syncKnowledge } from '../connectors/obsidian.js';
import { readLeads } from './tools.js';

const runningFor = new Set();
const today = () => new Date().toISOString().slice(0, 10);
const MODES = {
  morning: { model: 'opus', maxTurns: 40, budget: 4 },
  midday: { model: 'sonnet', maxTurns: 30, budget: 2 },
  event: { model: 'sonnet', maxTurns: 25, budget: 1.5 },
  review: { model: 'sonnet', maxTurns: 25, budget: 1.5 },
};

export function situation(orgId) {
  const lines = [];
  const org = one('SELECT * FROM orgs WHERE id = ?', orgId);
  lines.push(`ORGANISATION: ${org.name}`);
  for (const g of all(`SELECT * FROM goals WHERE scope = 'org' AND scope_id = ?`, orgId)) lines.push(`- company goal (${g.period_label}): ${g.title} — ${g.progress}%`);
  for (const d of all('SELECT * FROM departments WHERE org_id = ? ORDER BY position', orgId)) {
    lines.push(`DEPARTMENT ${d.name}:`);
    for (const g of all(`SELECT * FROM goals WHERE scope = 'department' AND scope_id = ?`, d.id)) lines.push(`  goal (${g.period_label}) ${g.title}: ${g.progress}%`);
    for (const k of all(`SELECT * FROM kpis WHERE scope = 'department' AND scope_id = ?`, d.id)) lines.push(`  kpi ${k.name}: ${k.actual}${k.unit} / target ${k.target ?? '—'}${k.unit}`);
    for (const t of all('SELECT * FROM teams WHERE department_id = ?', d.id)) {
      const open = all(`SELECT id, title, status, live_status FROM tasks WHERE team_id = ? AND status IN ('queued','running') AND kind = 'mission'`, t.id);
      lines.push(`  team ${t.name}: ${open.length ? open.map((m) => `#${m.id} ${m.status} "${m.title}"`).join('; ') : 'no open missions'}`);
      for (const k of all(`SELECT * FROM kpis WHERE scope = 'team' AND scope_id = ?`, t.id)) lines.push(`    kpi ${k.name}: ${k.actual}${k.unit} / ${k.target ?? '—'}${k.unit}`);
    }
  }
  const since = now() - 86_400_000;
  const done = all(`SELECT t.title, t.summary, t.verify_status, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.org_id = ? AND t.kind = 'mission' AND t.finished_at > ? ORDER BY t.finished_at DESC LIMIT 15`, orgId, since);
  if (done.length) lines.push('FINISHED IN THE LAST 24H:', ...done.map((t) => `- ${t.agent}: ${t.title} [${t.verify_status ?? 'done'}] ${t.summary ? `— ${t.summary.slice(0, 160)}` : ''}`));
  const failed = all(`SELECT title, error FROM tasks WHERE org_id = ? AND status = 'failed' AND finished_at > ?`, orgId, since);
  if (failed.length) lines.push('FAILED:', ...failed.map((t) => `- ${t.title}: ${String(t.error).slice(0, 160)}`));
  const pending = all(`SELECT kind, summary, route FROM approvals WHERE org_id = ? AND status = 'pending'`, orgId);
  lines.push(`WAITING FOR APPROVAL: ${pending.length}${pending.length ? '\n' + pending.map((a) => `- [${a.kind}→${a.route ?? 'owner'}] ${a.summary}`).join('\n') : ''}`);
  const sent = one('SELECT COUNT(*) AS n FROM sent_emails WHERE org_id = ? AND sent_at > ?', orgId, since).n;
  const replies = all(`SELECT r.from_email, r.subject, substr(r.body, 1, 200) AS body FROM replies r JOIN sent_emails s ON s.id = r.sent_email_id WHERE s.org_id = ? AND r.received_at > ?`, orgId, since);
  lines.push(`OUTREACH LAST 24H: ${sent} sent, ${replies.length} replies${replies.length ? '\n' + replies.map((r) => `- ${r.from_email}: ${r.body}`).join('\n') : ''}`);
  const leads = readLeads({ orgId });
  lines.push(`CRM: ${leads.length} leads (${leads.filter((l) => l.status === 'new').length} new)`);
  lines.push(`CONNECTORS: Gmail ${getSetting('gmail_address') ? 'connected' : 'not connected'}, HubSpot ${getSetting('hubspot_token') ? 'connected' : 'not connected'}`);
  return lines.join('\n');
}

function prompt(orgId, mode, reason) {
  const intro = {
    morning: 'It is the start of the working day. Set the plan for today.',
    midday: 'Mid-day check. Keep the organisation moving.',
    event: `Something happened: ${reason}. React to it.`,
    review: 'End of day. Review what happened and prepare tomorrow.',
  }[mode];
  return `${intro}

CURRENT STATE:
${situation(orgId)}

MEMORY.md:
${readMemory({ orgId }).slice(0, 5000)}

YOUR JOB AS OPERATOR:
1. Compare the state with the goals and KPIs. Find the biggest gap that moves revenue or a customer forward.
2. Create missions with the delegate tool for the departments/teams that own that work: 2 to 5 missions, each with complete instructions and a measurable definition of done (file names, counts, actions to propose). Do not create missions that duplicate open ones. Prefer missions that end in proposed actions (proposals sent, leads contacted, deliverables made) over more research.
3. If a mission failed or was sent back, decide whether to re-run it differently, split it, or drop it.
4. Update goal progress with update_goal where the facts justify it.
5. Write journal/plan-${today()}.md (overwrite if it exists): today's objectives, the missions you created (with ids), risks, and what the owner should look at. Keep it under 300 words.
6. Finish with a short spoken-style summary for the owner (3 to 5 sentences): what the organisation is doing today and what needs their attention. No questions.
Rules: never ask the owner what to do; the owner only approves money, contracts, deletions and first contact. If connectors are missing, work around it (leads still go to the CRM; drafts still get proposed).`;
}

export async function runOperator(orgId, { mode = 'midday', reason = '' } = {}) {
  if (runningFor.has(orgId)) return { skipped: 'already running' };
  if (scheduler.paused) return { skipped: 'paused' };
  if (!scheduler.status('claude').available && scheduler.status('claude').cooldownUntil) return { skipped: 'usage limit' };
  const jarvis = one(`SELECT * FROM agents WHERE org_id = ? AND tier = 'jarvis'`, orgId);
  if (!jarvis) return { skipped: 'no jarvis agent' };
  runningFor.add(orgId);
  const scope = { orgId };
  const cfg = MODES[mode] ?? MODES.midday;
  const taskId = insert(
    `INSERT INTO tasks (org_id, agent_id, title, instructions, priority, status, created_by, kind, started_at, created_at) VALUES (?, ?, ?, ?, 100, 'running', 'Jarvis', 'operator', ?, ?)`,
    orgId,
    jarvis.id,
    { morning: "Jarvis: today's plan", midday: 'Jarvis: mid-day check', event: `Jarvis: ${reason || 'event'}`, review: 'Jarvis: end-of-day review' }[mode],
    reason,
    now(),
    now(),
  );
  const task = one('SELECT * FROM tasks WHERE id = ?', taskId);
  log('info', `🧠 Jarvis is running ${one('SELECT name FROM orgs WHERE id = ?', orgId).name} (${mode})`, orgId);
  notify('tasks', { orgId });
  const root = writeClaudeMd(scope);
  try {
    syncKnowledge(scope, root);
  } catch {
    // optional
  }
  const runId = insert('INSERT INTO runs (task_id, provider, model, started_at) VALUES (?, ?, ?, ?)', taskId, 'claude', cfg.model, now());
  try {
    const tools = jarvisTools({ scope, task, agent: { ...jarvis, tier: 'operator' }, hooks: { createMission: (spec) => createMission({ ...spec, parent: task }) } });
    const res = await runSession({
      cwd: root,
      prompt: prompt(orgId, mode, reason),
      append: 'You are Jarvis, the operator who runs this organisation autonomously for its owner. You plan, delegate, and keep the organisation moving. You never ask the owner questions.',
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      maxBudgetUsd: cfg.budget,
      timeoutMs: 20 * 60_000,
      mcpServers: { jarvis: tools },
      disallowedTools: ['Agent', 'Task'],
      onProgress: (ev) => ev.kind === 'tool' && recordActivity({ scope, task, agent: 'Jarvis', kind: 'tool', text: ev.text }),
    });
    run('UPDATE runs SET finished_at = ?, outcome = ?, cost_usd = ? WHERE id = ?', now(), res.ok ? 'ok' : res.limited ? 'limited' : 'error', res.costUsd || 0, runId);
    if (res.limited) {
      const until = res.resetAt && res.resetAt > now() ? res.resetAt + 60_000 : now() + 30 * 60_000;
      setSetting('cooldown:claude', until);
      run(`UPDATE tasks SET status = 'cancelled', error = 'usage limit', finished_at = ? WHERE id = ?`, now(), taskId);
      log('warn', `Operator paused: Claude usage limit until ${new Date(until).toLocaleTimeString()}`, orgId);
      return { ok: false, limited: true };
    }
    const summary = res.text.trim().slice(0, 1500);
    run(`UPDATE tasks SET status = ?, result = ?, summary = ?, session_id = ?, cost_usd = ?, live_status = NULL, finished_at = ? WHERE id = ?`, res.ok ? 'done' : 'failed', res.text, summary.slice(0, 300), res.sessionId, res.costUsd || 0, now(), taskId);
    if (res.ok) {
      setSetting(`operator:${orgId}:plan`, JSON.stringify({ mode, at: now(), text: summary }));
      setSetting(`operator:${orgId}:last_${mode}`, today());
      const planFile = path.join(scopeDir(scope), 'journal', `plan-${today()}.md`);
      if (mode !== 'review' && !fs.existsSync(planFile)) fs.writeFileSync(planFile, `# Plan ${today()}\n\n${summary}\n`);
      log('info', `🧠 Jarvis (${mode}): ${summary.split('\n')[0].slice(0, 160)}`, orgId);
    } else log('error', `Operator run failed: ${res.error.slice(0, 200)}`, orgId);
    notify('operator', { orgId });
    notify('tasks', { orgId });
    return { ok: res.ok, summary };
  } finally {
    runningFor.delete(orgId);
  }
}

export const currentPlan = (orgId) => {
  try {
    return JSON.parse(getSetting(`operator:${orgId}:plan`, 'null'));
  } catch {
    return null;
  }
};

// Schedule: morning plan after 7:00, a mid-day check around 13:00 when nothing is running,
// an end-of-day review after 19:00. Called every few minutes by the server.
export async function operatorTick() {
  if (getSetting('autonomy', '1') !== '1' || scheduler.paused) return;
  const h = new Date().getHours();
  for (const org of all('SELECT id FROM orgs WHERE archived = 0')) {
    if (!one(`SELECT id FROM departments WHERE org_id = ?`, org.id)) continue; // nothing to run yet
    const last = (mode) => getSetting(`operator:${org.id}:last_${mode}`, '');
    if (h >= 7 && last('morning') !== today()) await runOperator(org.id, { mode: 'morning' });
    else if (h >= 13 && h < 19 && last('midday') !== today()) {
      const open = one(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND kind = 'mission' AND status IN ('queued','running')`, org.id).n;
      if (open === 0) await runOperator(org.id, { mode: 'midday' });
    } else if (h >= 19 && last('review') !== today()) await runOperator(org.id, { mode: 'review' });
  }
}

// Events (a reply arrived, a mission finished) wake the Operator, at most once per 20 minutes per organisation.
const lastEvent = new Map();
export function wakeOperator(orgId, reason) {
  if (!orgId || getSetting('autonomy', '1') !== '1') return;
  const t = lastEvent.get(orgId) ?? 0;
  if (now() - t < 20 * 60_000) return;
  lastEvent.set(orgId, now());
  runOperator(orgId, { mode: 'event', reason }).catch((err) => log('warn', `Operator event run failed: ${err.message}`, orgId));
}
