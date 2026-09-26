import { config } from './config.js';
import { one, all, run, insert, tx, now, getSetting, setSetting } from './db.js';
import { log, notify } from './events.js';
import { parseAgentOutput, extractJson, clampPriority } from './protocol.js';
import { workDir, addMemory, registerOutputs } from './mind.js';
import {
  agentGrade,
  agentTools,
  prefersCodex,
  CLI_MODEL,
  systemPrompt,
  reviewPrompt,
  resolveAssignee,
  relevantGoals,
  relevantKpis,
} from './agents.js';
import { runClaude } from './providers/claude.js';
import { runCodex } from './providers/codex.js';
import { runAnthropicApi } from './providers/anthropic-api.js';
import { routeApproved } from './outbox.js';
import { hubspotConnected, addLead } from './connectors/hubspot.js';
import { syncKnowledge, writeReport } from './connectors/obsidian.js';

// Pacing per engine. Subscriptions refill on a timer, so quota is the budget: limited concurrency
// and runs per hour spread work out, and a usage-limit error pauses that engine until it resets.
const LIMITS = {
  claude: { maxConcurrent: 2, maxPerHour: 20 },
  codex: { maxConcurrent: 1, maxPerHour: 15 },
  api: { maxConcurrent: 2, maxPerHour: 40 },
};
const TICK_MS = 2000;

const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

export function apiSpendThisMonth() {
  return one(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE provider = 'api' AND started_at >= ?`, monthStart()).s;
}

export const apiCap = () => Number(getSetting('api_monthly_cap', '30'));

// ---------- tasks ----------
export function createTask({ agent, title, instructions = '', priority = 50, parent = null, projectId = null, createdBy = 'owner', blockedBy = null }) {
  const teamDept = agent.team_id ? one('SELECT department_id FROM teams WHERE id = ?', agent.team_id)?.department_id : null;
  const id = insert(
    `INSERT INTO tasks (org_id, project_id, department_id, team_id, agent_id, parent_id, root_id, depth, title, instructions,
       priority, created_by, blocked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent.org_id,
    parent?.project_id ?? projectId,
    agent.department_id ?? teamDept ?? null,
    agent.team_id,
    agent.id,
    parent?.id ?? null,
    parent ? parent.root_id ?? parent.id : null,
    parent ? parent.depth + 1 : 0,
    title.slice(0, 200),
    instructions,
    clampPriority(priority),
    createdBy,
    blockedBy,
    now(),
  );
  log('info', `Task #${id} for ${agent.name}: ${title}${blockedBy ? ` (after task #${blockedBy})` : ''}`, agent.org_id);
  notify('tasks', { orgId: agent.org_id });
  return id;
}

// ---------- approvals ----------
export function decideApproval(id, approve, by = 'owner', note = null) {
  const a = one('SELECT * FROM approvals WHERE id = ?', id);
  if (!a) throw new Error('Approval not found');
  if (a.status !== 'pending') throw new Error(`Already ${a.status}`);
  if (a.kind === 'payment' && by !== 'owner') throw new Error('Payments can only be approved by the owner');
  run('UPDATE approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'rejected', by, note ?? (approve ? 'Approved.' : 'Rejected.'), now(), id);
  // Approved emails and proposals go to the Outbox and are sent from Gmail when connected.
  const outcome = approve ? routeApproved(one('SELECT * FROM approvals WHERE id = ?', id)) : note ?? 'Rejected.';
  log('info', `${by === 'owner' ? 'You' : 'Team leader'} ${approve ? 'approved' : 'rejected'}: ${a.summary}`, a.org_id);
  notify('approvals', { orgId: a.org_id });
  return { status: approve ? 'approved' : 'rejected', note: outcome };
}

// Word overlap between two summaries (0..1), used to merge near-duplicate requests.
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_.]{3,}/g) ?? []);
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

function createApproval(task, action) {
  // Several agents often raise the same question; keep one request instead of a pile.
  // Emails and proposals to different people are never merged.
  if (!['email', 'proposal'].includes(action.kind)) {
    const pending = all(`SELECT id, summary FROM approvals WHERE status = 'pending' AND kind = ? AND org_id IS ?`, action.kind, task.org_id);
    if (pending.some((p) => similarity(p.summary, action.summary) >= 0.3)) return null;
  }
  const id = insert(
    'INSERT INTO approvals (task_id, org_id, team_id, kind, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    task.id,
    task.org_id,
    task.team_id,
    action.kind,
    action.summary,
    JSON.stringify(action.details),
    now(),
  );
  // Team leaders review outgoing work only when the owner switched that on. Payments never.
  const team = task.team_id ? one('SELECT * FROM teams WHERE id = ?', task.team_id) : null;
  if (action.kind !== 'payment' && team?.leader_can_approve) {
    const leader = one(`SELECT * FROM agents WHERE team_id = ? AND tier = 'leader'`, team.id);
    if (leader) {
      const approval = one('SELECT * FROM approvals WHERE id = ?', id);
      createTask({ agent: leader, title: `Review: ${action.summary}`.slice(0, 200), instructions: reviewPrompt(leader, approval), priority: 90, createdBy: `review:${id}` });
    }
  }
  return id;
}

// ---------- applying an agent's result ----------
function applyUpdates(agent, parsed) {
  const kpis = relevantKpis(agent);
  for (const u of parsed.kpiUpdates) {
    const k = kpis.find((x) => x.name.toLowerCase() === u.name.toLowerCase());
    if (!k) continue;
    const value = Number.isFinite(u.set) ? u.set : k.actual + u.add;
    const history = JSON.parse(k.history || '[]').concat([[now(), value]]).slice(-30);
    run('UPDATE kpis SET actual = ?, history = ?, updated_at = ? WHERE id = ?', value, JSON.stringify(history), now(), k.id);
  }
  const goals = relevantGoals(agent);
  for (const u of parsed.goalUpdates) {
    const g = goals.find((x) => x.title.toLowerCase() === u.title.toLowerCase());
    if (g) run('UPDATE goals SET progress = ?, updated_at = ? WHERE id = ?', u.progress, now(), g.id);
  }
}

function applyResult(task, agent, parsed) {
  const created = { subtasks: 0, approvals: 0, dropped: 0 };
  tx(() => {
    run(`UPDATE tasks SET status = 'done', summary = ?, result = ?, error = NULL, finished_at = ? WHERE id = ?`, parsed.summary, parsed.report, now(), task.id);
    const rootId = task.root_id ?? task.id;
    let room = config.maxTasksPerRoot - one('SELECT COUNT(*) AS n FROM tasks WHERE root_id = ? OR id = ?', rootId, rootId).n;
    const ids = [];
    for (const s of parsed.subtasks) {
      const target = resolveAssignee(agent, s.assignee);
      if (!target || task.depth + 1 > config.maxDepth || room <= 0) {
        created.dropped++;
        ids.push(null);
        continue;
      }
      const blockedBy = s.after && s.after <= ids.length ? ids[s.after - 1] : null;
      ids.push(createTask({ agent: target, title: s.title, instructions: s.instructions, priority: s.priority, parent: task, createdBy: agent.name, blockedBy }));
      room--;
      created.subtasks++;
    }
    for (const a of parsed.actions) {
      if (createApproval(task, a)) created.approvals++;
    }
    for (const m of parsed.memories) addMemory({ orgId: task.org_id, projectId: task.org_id ? null : task.project_id, content: m, source: 'agent' });
    applyUpdates(agent, parsed);
  });
  if (parsed.leads.length && hubspotConnected()) {
    Promise.allSettled(parsed.leads.map((l) => addLead(l))).then((results) => {
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      log(ok ? 'info' : 'warn', `HubSpot: ${ok} of ${parsed.leads.length} lead(s) from ${agent.name} added`, task.org_id);
    });
  }
  if (created.dropped) log('warn', `${agent.name}: ${created.dropped} delegation(s) skipped (unknown assignee or swarm limit)`, task.org_id);
  if (created.approvals) notify('approvals', { orgId: task.org_id });
  notify('goals', { orgId: task.org_id });
  return created;
}

// ---------- engine ----------
class Engine {
  running = new Map(); // taskId -> { controller, provider, requeue }
  timer = null;

  get paused() {
    return getSetting('paused', '0') === '1';
  }

  start() {
    const { changes } = run(`UPDATE tasks SET status = 'queued' WHERE status = 'running'`);
    if (changes) log('warn', `Recovered ${changes} interrupted task(s) after restart`);
    run(`UPDATE agents SET status = 'idle'`);
    run(`UPDATE runs SET finished_at = ?, outcome = 'aborted' WHERE finished_at IS NULL`, now());
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    for (const r of this.running.values()) {
      r.requeue = true;
      r.controller.abort();
    }
  }

  enabled(name) {
    if (name === 'api') return Boolean(getSetting('anthropic_api_key')) && apiSpendThisMonth() < apiCap();
    return getSetting(`${name}_enabled`, '1') === '1';
  }

  status(name) {
    const t = now();
    const cooldown = Number(getSetting(`cooldown:${name}`, '0'));
    const runsLastHour = one('SELECT COUNT(*) AS n FROM runs WHERE provider = ? AND started_at > ?', name, t - 3_600_000).n;
    const runningNow = [...this.running.values()].filter((r) => r.provider === name).length;
    const lim = LIMITS[name];
    const enabled = this.enabled(name);
    return {
      name,
      enabled,
      running: runningNow,
      maxConcurrent: lim.maxConcurrent,
      runsLastHour,
      maxPerHour: lim.maxPerHour,
      cooldownUntil: cooldown > t ? cooldown : null,
      available: enabled && cooldown <= t && runningNow < lim.maxConcurrent && runsLastHour < lim.maxPerHour,
    };
  }

  // Subscriptions first; the paid API only as the last resort. Codex has no web tools.
  order(agent) {
    const subs = prefersCodex(agent) && !agent.web ? ['codex', 'claude'] : agent.web ? ['claude'] : ['claude', 'codex'];
    return [...subs, 'api'];
  }

  pick(agent, { ignoreBusy = false } = {}) {
    return this.order(agent).find((p) => {
      const s = this.status(p);
      return ignoreBusy ? s.enabled && !s.cooldownUntil : s.available;
    });
  }

  // One model call for an agent on a given engine. Records the run and handles usage limits.
  async call(provider, agent, { prompt, system, cwd, signal, taskId = null }) {
    const grade = agentGrade(agent);
    const model = provider === 'claude' ? CLI_MODEL[grade] : provider === 'api' ? grade : null;
    const runId = insert('INSERT INTO runs (task_id, provider, model, started_at) VALUES (?, ?, ?, ?)', taskId, provider, model, now());
    let res;
    try {
      if (provider === 'claude') {
        res = await runClaude({ bin: config.claudeBin, prompt, system, model, tools: agentTools(agent), cwd, timeoutMs: config.runTimeoutMs, signal });
      } else if (provider === 'codex') {
        res = await runCodex({ bin: config.codexBin, prompt, system, cwd, timeoutMs: config.runTimeoutMs, signal });
      } else {
        res = await runAnthropicApi({ apiKey: getSetting('anthropic_api_key'), prompt, system, grade, web: Boolean(agent.web), signal });
      }
    } catch (err) {
      res = { ok: false, error: err.message, costUsd: 0 };
    }
    const outcome = res.ok ? 'ok' : res.limited ? 'limited' : res.timedOut ? 'timeout' : res.aborted ? 'aborted' : 'error';
    // Subscription runs report an API-equivalent value but cost nothing; only API runs count as spend.
    run('UPDATE runs SET finished_at = ?, outcome = ?, cost_usd = ? WHERE id = ?', now(), outcome, provider === 'api' ? res.costUsd || 0 : 0, runId);
    if (res.limited) {
      const until = res.resetAt && res.resetAt > now() ? res.resetAt + 60_000 : now() + config.limitCooldownMs;
      setSetting(`cooldown:${provider}`, until);
      log('warn', `${provider} reached its usage limit; paused until ${new Date(until).toLocaleTimeString()}`);
      notify('status');
    }
    return { ...res, provider, model: provider === 'api' ? res.model : model, outcome };
  }

  // Direct call outside the queue (Ask Jarvis, structure proposals). Falls through engines on limits.
  async ask(agent, { prompt, system, cwd }) {
    for (const provider of this.order(agent)) {
      const s = this.status(provider);
      if (!s.enabled || s.cooldownUntil) continue;
      const res = await this.call(provider, agent, { prompt, system, cwd });
      if (res.ok || !res.limited) return res;
    }
    return { ok: false, error: 'All engines are out of quota right now. Try again after the reset, or add an API key in Settings.' };
  }

  tick() {
    if (this.paused) return;
    // A task waiting on a failed or cancelled step can never start.
    for (const t of all(`SELECT t.id, b.title FROM tasks t JOIN tasks b ON b.id = t.blocked_by WHERE t.status = 'queued' AND b.status IN ('failed', 'cancelled')`)) {
      this.finish(t.id, 'failed', `The step it depends on ("${t.title}") did not finish`);
    }
    const queued = all(
      `SELECT * FROM tasks WHERE status = 'queued' AND not_before <= ?
         AND (blocked_by IS NULL OR blocked_by IN (SELECT id FROM tasks WHERE status = 'done'))
       ORDER BY priority DESC, id ASC LIMIT 100`,
      now(),
    );
    for (const task of queued) {
      const agent = task.agent_id ? one('SELECT * FROM agents WHERE id = ?', task.agent_id) : null;
      if (!agent) {
        this.finish(task.id, 'failed', 'No agent is assigned to this task');
        continue;
      }
      const provider = this.pick(agent);
      if (provider) this.launch(task, agent, provider);
      if (!['claude', 'codex', 'api'].some((p) => this.status(p).available)) break;
    }
  }

  async launch(task, agent, provider) {
    const startedAt = now();
    run(`UPDATE tasks SET status = 'running', provider = ?, attempts = attempts + 1, started_at = ? WHERE id = ?`, provider, startedAt, task.id);
    run(`UPDATE agents SET status = 'working' WHERE id = ?`, agent.id);
    const controller = new AbortController();
    const entry = { controller, provider, requeue: false };
    this.running.set(task.id, entry);
    log('info', `▶ ${agent.name} started: ${task.title}`, task.org_id);
    notify('tasks', { orgId: task.org_id });

    const review = task.created_by.startsWith('review:');
    const scope = { orgId: task.org_id, projectId: task.org_id ? null : task.project_id };
    const cwd = workDir(scope);
    if (!review) {
      try {
        syncKnowledge(scope, cwd);
      } catch (err) {
        log('warn', `Obsidian notes not synced: ${err.message}`, task.org_id);
      }
    }
    const prompt = review ? task.instructions : this.buildPrompt(task);
    const system = review ? `You are ${agent.name}, a careful team leader.` : systemPrompt(agent, task);
    const res = await this.call(provider, agent, { prompt, system, cwd, signal: controller.signal, taskId: task.id });
    this.running.delete(task.id);
    run(`UPDATE agents SET status = 'idle' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE agent_id = ? AND status = 'running')`, agent.id, agent.id);
    run('UPDATE tasks SET model = ?, cost_usd = cost_usd + ? WHERE id = ?', res.model ?? null, provider === 'api' ? res.costUsd || 0 : 0, task.id);

    const fresh = one('SELECT * FROM tasks WHERE id = ?', task.id);
    if (res.ok) {
      if (review) this.finishReview(fresh, res.text);
      else {
        const parsed = parseAgentOutput(res.text);
        const created = applyResult(fresh, agent, parsed);
        const files = registerOutputs(scope, task.id, startedAt);
        writeReport(one('SELECT * FROM tasks WHERE id = ?', task.id), agent);
        log(
          'info',
          `✔ ${agent.name} finished: ${task.title}` +
            (created.subtasks ? ` · delegated ${created.subtasks}` : '') +
            (created.approvals ? ` · ${created.approvals} for approval` : '') +
            (files ? ` · ${files} file(s)` : ''),
          task.org_id,
        );
      }
    } else if (res.limited) {
      run(`UPDATE tasks SET status = 'queued', attempts = attempts - 1 WHERE id = ?`, task.id);
    } else if (res.aborted) {
      if (entry.requeue) run(`UPDATE tasks SET status = 'queued', attempts = attempts - 1 WHERE id = ?`, task.id);
      else this.finish(task.id, 'cancelled', 'Cancelled');
    } else if (fresh.attempts < config.maxAttempts) {
      const delay = 2 ** fresh.attempts * 60_000;
      run(`UPDATE tasks SET status = 'queued', not_before = ?, error = ? WHERE id = ?`, now() + delay, res.error || res.outcome, task.id);
      log('warn', `${agent.name}: "${task.title}" ${res.outcome}; retrying in ${delay / 60_000} min`, task.org_id);
    } else {
      this.finish(task.id, 'failed', res.error || res.outcome);
    }
    notify('tasks', { orgId: task.org_id });
    notify('status');
    setImmediate(() => this.tick());
  }

  finishReview(task, text) {
    const approvalId = Number(task.created_by.split(':')[1]);
    const decision = extractJson(text);
    run(`UPDATE tasks SET status = 'done', summary = ?, result = ?, finished_at = ? WHERE id = ?`, decision?.reason ?? 'Reviewed', text, now(), task.id);
    const approval = one('SELECT status FROM approvals WHERE id = ?', approvalId);
    if (approval?.status !== 'pending' || !decision) return; // unclear answer: stays with the owner
    try {
      decideApproval(approvalId, decision.decision === 'approve', 'leader', decision.reason ?? null);
    } catch (err) {
      log('warn', `Leader review skipped: ${err.message}`, task.org_id);
    }
  }

  buildPrompt(task) {
    const parts = [];
    if (task.parent_id) {
      const parent = one('SELECT title, created_by, agent_id FROM tasks WHERE id = ?', task.parent_id);
      const from = parent?.agent_id ? one('SELECT name FROM agents WHERE id = ?', parent.agent_id)?.name : null;
      if (parent) parts.push(`ASSIGNED BY ${from ?? 'the owner'} as part of: "${parent.title}"`);
    }
    if (task.blocked_by) {
      const input = one('SELECT t.title, t.summary, t.result, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.id = ?', task.blocked_by);
      if (input) parts.push(`INPUT FROM ${input.agent ?? 'the previous step'} ("${input.title}"):
${(input.result || input.summary || '').slice(0, 6000)}`);
    }
    if (task.project_id) {
      const p = one('SELECT name, description FROM projects WHERE id = ?', task.project_id);
      if (p) parts.push(`PROJECT: ${p.name}${p.description ? ` (${p.description})` : ''}`);
    }
    parts.push(`TASK: ${task.title}\n\n${task.instructions || task.title}`);
    return parts.join('\n\n');
  }

  finish(id, status, error) {
    run('UPDATE tasks SET status = ?, error = ?, finished_at = ? WHERE id = ?', status, error, now(), id);
    const t = one('SELECT org_id, title FROM tasks WHERE id = ?', id);
    if (status === 'failed') log('error', `✖ Failed: ${t?.title}: ${String(error).slice(0, 200)}`, t?.org_id);
    notify('tasks', { orgId: t?.org_id });
  }

  pause() {
    setSetting('paused', '1');
    for (const r of this.running.values()) {
      r.requeue = true;
      r.controller.abort();
    }
    log('warn', 'All agents stopped by the owner');
    notify('status');
  }

  resume() {
    setSetting('paused', '0');
    log('info', 'Agents resumed');
    notify('status');
    this.tick();
  }

  cancel(id) {
    const r = this.running.get(id);
    if (r) r.controller.abort();
    else if (one('SELECT status FROM tasks WHERE id = ?', id)?.status === 'queued') this.finish(id, 'cancelled', 'Cancelled');
  }

  retry(id) {
    run(`UPDATE tasks SET status = 'queued', attempts = 0, not_before = 0, error = NULL WHERE id = ? AND status IN ('failed', 'cancelled')`, id);
    notify('tasks');
    this.tick();
  }

  clearCooldown(name) {
    setSetting(`cooldown:${name}`, '0');
    notify('status');
    this.tick();
  }
}

export const engine = new Engine();
