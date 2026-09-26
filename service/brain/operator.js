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
import { approvalSentence } from './policy.js';
import { whatsappConnected } from '../connectors/whatsapp.js';
import { waitingForConnectors } from '../outbox.js';
import { mapText, signalsText, stageOf, readMap } from './company.js';
import { periodLabels } from '../agents.js';

const runningFor = new Set();
const today = () => new Date().toISOString().slice(0, 10);
const MODES = {
  strategy: { model: 'opus', maxTurns: 60, budget: 7 },
  morning: { model: 'opus', maxTurns: 45, budget: 5 },
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
  const pending = all(`SELECT kind, summary FROM approvals WHERE org_id = ? AND status = 'pending'`, orgId);
  lines.push(`MONEY WAITING FOR THE OWNER: ${pending.length}${pending.length ? '\n' + pending.map((a) => `- [${a.kind}] ${a.summary}`).join('\n') : ''}`);
  const inReview = one(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND status = 'review'`, orgId).n;
  const waiting = waitingForConnectors(orgId);
  lines.push(`MESSAGES: ${inReview} in review (released when their missions are delivered)${waiting.length ? '; waiting for a connector: ' + waiting.map((w) => `${w.label} ${w.count}`).join(', ') + ' (the owner has been asked to add the key; they send by themselves then)' : ''}`);
  const sent = one('SELECT COUNT(*) AS n FROM sent_emails WHERE org_id = ? AND sent_at > ?', orgId, since).n;
  const replies = all(`SELECT r.from_email, r.subject, substr(r.body, 1, 200) AS body FROM replies r JOIN sent_emails s ON s.id = r.sent_email_id WHERE s.org_id = ? AND r.received_at > ?`, orgId, since);
  lines.push(`OUTREACH LAST 24H: ${sent} sent, ${replies.length} replies${replies.length ? '\n' + replies.map((r) => `- ${r.from_email}: ${r.body}`).join('\n') : ''}`);
  const leads = readLeads({ orgId });
  lines.push(`CRM: ${leads.length} leads (${leads.filter((l) => l.status === 'new').length} new)`);
  lines.push(`CONNECTORS: Gmail ${getSetting('gmail_address') ? 'connected' : 'not connected'}, WhatsApp ${whatsappConnected() ? 'connected' : 'not connected'}, HubSpot ${getSetting('hubspot_token') ? 'connected' : 'not connected'}`);
  lines.push(`WORKSPACE FOLDER: ${scopeDir({ orgId })}`);
  return lines.join('\n');
}

function prompt(orgId, mode, reason) {
  const org = one('SELECT name FROM orgs WHERE id = ?', orgId);
  const intro = {
    strategy: 'Weekly strategy review. Look at the whole company as its CEO: which stage it is at, what blocked revenue this week, what the structure is missing, what to build next, and set or correct the goals with set_goal.',
    morning: 'It is the start of the working day. Decide what the company builds and does today.',
    midday: 'Cycle check. The teams are free or nearly free: give them the next most valuable work.',
    event: `Something happened: ${reason}. React to it, then keep the company moving.`,
    review: 'End of day. Review what was delivered, what failed and why, update the company map, and line up tomorrow.',
  }[mode];
  const stage = stageOf(orgId);
  const assessed = Boolean(readMap(orgId).updated_at);
  return `${intro}

You are the CEO of ${org?.name ?? 'this organisation'}. Nobody tells you what the company needs: you know what a company needs in order to run and grow, you see what is missing, and you build it. The owner never has to remind you that there is no website, no way to get paid, no follow-up sequence or nobody owning delivery.

CURRENT STATE:
${situation(orgId)}

COMPANY MAP (what every company needs, and where this one stands; current stage: ${stage}):
${mapText(orgId)}

HARD SIGNALS (facts gathered from the folder and the connectors):
${signalsText(orgId)}

MEMORY.md:
${readMemory({ orgId }).slice(0, 5000)}

HOW YOU THINK, EVERY RUN:
1. Foundations before outreach: an offer with prices, a website that is actually live, a way to get paid (invoice + payment details), a connected channel. If any of these is MISSING or unproven, this run builds or proves it (a mission with a definition of done that names the file, URL or number), in parallel with pipeline work, never instead of thinking about it.
2. Then pipeline and sales: verified leads in the CRM, first contacts proposed, follow-up sequences, proposals, closing.
3. Then delivery and success: what a paying client receives, onboarding, support, feedback, case studies.
4. Then growth: presence (social, listings, reviews), retention, referrals, new products, new markets.
5. Ownership: every capability needs a department or team that owns it. If none exists, create it now with create_department or create_team (lean: one unit, clear KPI) and delegate to it in this same run.
6. Keep the map truthful with update_company_map${assessed ? '' : ' (it has NEVER been assessed: assess every item now from the signals and the folder before anything else)'}: mark READY only with evidence (a file path, a live URL, a count), BUILDING with the mission id, MISSING with the next step and the owner department. Never leave "unknown".
7. Missions: 2 to 5 per run, each with complete instructions and a measurable definition of done. Do not duplicate open missions; do not re-propose the same recipients. If a mission failed or was sent back, re-run it differently, split it, or drop it.
8. Goals: when goals are missing, vague or stale, set them with set_goal (quarter, month, week) so every department has a number to move; update progress with update_goal only where facts justify it.
9. Write journal/plan-${today()}.md (overwrite if it exists): the stage, today's objectives, the missions you created (ids), what you decided to build because it was missing, risks. Under 300 words.
10. Finish with a short spoken-style summary for the owner (3 to 5 sentences): what the company is building and doing today, what you noticed was missing and how you are fixing it, and the one thing only they can do (a key, a payment detail) if any. No questions.
Rules: never ask the owner what to do. ${approvalSentence(getSetting('approval_level', 'payments'))} You run in a loop: as soon as missions are delivered you are woken again, so always leave the teams with the next concrete work. Messages wait in the Outbox while a connector is missing and go out by themselves once the owner adds the key: never plan manual sending, never ask the owner to send anything. Use the time to build what will be delivered after the first replies and to widen the pipeline.`;
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
    { strategy: 'Jarvis: weekly strategy', morning: "Jarvis: today's plan", midday: 'Jarvis: cycle', event: `Jarvis: ${reason || 'event'}`, review: 'Jarvis: end-of-day review' }[mode],
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
      append: 'You are Jarvis, the CEO who runs this organisation autonomously for its owner. You know what a company needs, you notice what is missing, you build it, you plan, delegate and keep the organisation moving. You never ask the owner questions.',
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
      if (mode === 'strategy') {
        setSetting(`operator:${orgId}:last_morning`, today()); // the strategy run is the morning run of that day
        setSetting(`operator:${orgId}:last_strategy_week`, weekLabel());
      }
      setSetting(`operator:${orgId}:last_cycle_at`, now()); // any successful run counts as a cycle
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

// The loop: a morning plan after 7:00, then a new cycle every two hours (7:00–22:00) whenever the
// organisation has fewer than two open missions, an end-of-day review after 19:00, and a wake-up
// whenever a mission is delivered. Agents therefore always get new work. Called every few minutes.
const weekLabel = () => `${new Date().getFullYear()}-${periodLabels().week}`;
const CYCLE_MS = 2 * 60 * 60_000; // a fresh look while missions are still running
const IDLE_MS = 15 * 60_000; // never leave the teams idle longer than this during the day
export async function operatorTick() {
  if (getSetting('autonomy', '1') !== '1' || scheduler.paused) return;
  const h = new Date().getHours();
  for (const org of all('SELECT id FROM orgs WHERE archived = 0')) {
    if (!one(`SELECT id FROM departments WHERE org_id = ?`, org.id)) continue; // nothing to run yet
    const last = (mode) => getSetting(`operator:${org.id}:last_${mode}`, '');
    const open = one(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND kind = 'mission' AND status IN ('queued','running')`, org.id).n;
    const lastCycle = Number(getSetting(`operator:${org.id}:last_cycle_at`, '0'));
    if (h >= 7 && last('morning') !== today()) await runOperator(org.id, { mode: getSetting(`operator:${org.id}:last_strategy_week`, '') !== weekLabel() ? 'strategy' : 'morning' });
    else if (h >= 19 && last('review') !== today()) await runOperator(org.id, { mode: 'review' });
    else if (h >= 7 && h < 22 && ((open === 0 && now() - lastCycle > IDLE_MS) || (open < 2 && now() - lastCycle > CYCLE_MS))) {
      setSetting(`operator:${org.id}:last_cycle_at`, now());
      await runOperator(org.id, { mode: 'midday', reason: open === 0 ? 'the teams are free' : 'next cycle' });
    }
  }
}

// Events (a reply arrived, a mission finished) wake the Operator: at most once per 20 minutes per organisation,
// or once per 5 minutes when nothing is running any more, so the teams get new work quickly.
const lastEvent = new Map();
export function wakeOperator(orgId, reason) {
  if (!orgId || getSetting('autonomy', '1') !== '1') return;
  const t = lastEvent.get(orgId) ?? 0;
  const open = one(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND kind = 'mission' AND status IN ('queued','running')`, orgId).n;
  if (now() - t < (open === 0 ? 5 : 20) * 60_000) return;
  lastEvent.set(orgId, now());
  runOperator(orgId, { mode: 'event', reason }).catch((err) => log('warn', `Operator event run failed: ${err.message}`, orgId));
}
