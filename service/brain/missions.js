// Missions: outcome-oriented units of work with a definition of done. A mission runs as one sandboxed
// session led by the responsible agent (department head or team leader) with their people as subagents.
// When the session ends, the deliverable is verified (deterministic checks + a verifier session); a
// failed verification re-runs the mission with feedback, up to three rounds. "Done" means delivered.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { one, all, run, insert, now, getSetting, setSetting } from '../db.js';
import { log, notify } from '../events.js';
import { extractJson, clampPriority } from '../protocol.js';
import { runCodex } from '../providers/codex.js';
import { writeReport } from '../connectors/obsidian.js';
import { syncKnowledge } from '../connectors/obsidian.js';
import { runSession, GRADE_MODEL } from './runtime.js';
import { jarvisTools, recordActivity } from './tools.js';
import { ensureWorkspace, writeClaudeMd, readMemory } from './workspace.js';
import { hasPlaceholders } from './policy.js';
import { releaseReviewed, reviewItems } from './proposals.js';
import { snapshot } from './history.js';

const MAX_ROUNDS = 3;
// Two Claude sessions at a time: enough to keep departments moving without draining the 5-hour window in one burst.
const CONCURRENCY = { claude: 2, codex: 1 };
const TICK_MS = 3000;
const OUTPUT_EXT = /\.(csv|md|txt|json|html?|css|js|ts|py|pdf|docx?|xlsx?|pptx?|png|jpe?g|svg)$/i;

// ---------- creating missions ----------
function resolveTarget(scope, target) {
  const orgId = scope.orgId ?? null;
  if (typeof target === 'string') {
    const m = target.match(/^(department|dept|team|org|organisation|personal)\s*:?\s*(.*)$/i);
    if (!m) throw new Error(`Unknown target "${target}". Use "department:<name>" or "team:<name>".`);
    const kind = m[1].toLowerCase();
    const name = m[2].trim();
    if (kind === 'personal') return { type: 'personal', id: null };
    if (kind.startsWith('org')) return { type: 'org', id: orgId };
    if (kind === 'team') {
      const t = one(`SELECT t.id FROM teams t JOIN departments d ON d.id = t.department_id WHERE d.org_id = ? AND lower(t.name) = lower(?)`, orgId, name);
      if (!t) throw new Error(`No team named "${name}". Teams: ${all('SELECT t.name FROM teams t JOIN departments d ON d.id = t.department_id WHERE d.org_id = ?', orgId).map((x) => x.name).join(', ')}`);
      return { type: 'team', id: t.id };
    }
    const d = one('SELECT id FROM departments WHERE org_id = ? AND lower(name) = lower(?)', orgId, name);
    if (!d) throw new Error(`No department named "${name}". Departments: ${all('SELECT name FROM departments WHERE org_id = ?', orgId).map((x) => x.name).join(', ')}`);
    return { type: 'department', id: d.id };
  }
  return target;
}

// The agent who leads a mission for a target.
export function leaderFor(scope, target) {
  const orgId = scope.orgId ?? null;
  switch (target.type) {
    case 'team':
      return one(`SELECT * FROM agents WHERE team_id = ? AND tier = 'leader'`, target.id) ?? one(`SELECT * FROM agents WHERE team_id = ? ORDER BY id LIMIT 1`, target.id);
    case 'department':
      return one(`SELECT * FROM agents WHERE department_id = ? AND team_id IS NULL AND tier = 'head'`, target.id) ?? one(`SELECT a.* FROM agents a JOIN teams t ON t.id = a.team_id WHERE t.department_id = ? AND a.tier = 'leader' ORDER BY a.id LIMIT 1`, target.id);
    case 'agent':
      return one('SELECT * FROM agents WHERE id = ?', target.id);
    case 'org':
      return one(`SELECT * FROM agents WHERE org_id = ? AND tier = 'jarvis'`, orgId);
    default:
      return one(`SELECT * FROM agents WHERE org_id IS NULL AND tier = 'jarvis'`);
  }
}

export function createMission({ scope, target, title, instructions = '', dod = '', priority = 60, parent = null, createdBy = 'owner', kind = 'mission', projectId = null }) {
  const t = resolveTarget(scope, target);
  const leader = leaderFor(scope, t);
  if (!leader) throw new Error('Nobody can lead this mission yet: add a head or team leader first.');
  const deptId = leader.department_id ?? (leader.team_id ? one('SELECT department_id FROM teams WHERE id = ?', leader.team_id)?.department_id : null);
  const id = insert(
    `INSERT INTO tasks (org_id, project_id, department_id, team_id, agent_id, parent_id, root_id, depth, title, instructions, priority, created_by, kind, dod, target, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    scope.orgId ?? null,
    parent?.project_id ?? projectId,
    t.type === 'personal' ? null : deptId,
    leader.team_id,
    leader.id,
    parent?.id ?? null,
    parent ? parent.root_id ?? parent.id : null,
    parent ? parent.depth + 1 : 0,
    String(title).slice(0, 200),
    instructions,
    clampPriority(priority),
    createdBy,
    kind,
    String(dod ?? '').slice(0, 4000),
    JSON.stringify(t),
    now(),
  );
  log('info', `Mission #${id} for ${leader.name}: ${title}`, scope.orgId ?? null);
  notify('tasks', { orgId: scope.orgId ?? null });
  scheduler.tick();
  return id;
}

// ---------- the team as subagents ----------
// Sonnet leads and works; Opus is reserved for the Operator's planning (and agents explicitly set to "strong").
const MODEL_OF = (a) => GRADE_MODEL[['strong', 'worker', 'bulk'].includes(a.model) ? a.model : a.tier === 'jarvis' ? 'strong' : 'worker'] ?? 'sonnet';
const TOOLS_WORKER = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite'];

export function teamAsSubagents(leader) {
  let members = [];
  if (leader.tier === 'leader' && leader.team_id) members = all(`SELECT * FROM agents WHERE team_id = ? AND id != ?`, leader.team_id, leader.id);
  else if (leader.tier === 'head' && leader.department_id) members = all(`SELECT a.*, t.name AS team_name FROM agents a LEFT JOIN teams t ON t.id = a.team_id WHERE (a.department_id = ? OR t.department_id = ?) AND a.id != ?`, leader.department_id, leader.department_id, leader.id);
  else if (leader.org_id === null) members = all(`SELECT * FROM agents WHERE org_id IS NULL AND id != ?`, leader.id);
  const defs = {};
  for (const m of members) {
    const key = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `agent-${m.id}`;
    defs[key] = {
      description: `${m.name}, ${m.role}${m.team_name ? ` (${m.team_name} team)` : ''}${m.tier === 'leader' ? ', team leader' : ''}${m.web ? '; can research on the web' : ''}`,
      prompt: `You are ${m.name}, ${m.role}, part of an autonomous AI team. ${m.instructions || ''}\nDo the assigned work completely and return concrete results (facts with source URLs, finished text, file paths you created). Never fabricate contact details. You cannot send anything; return drafts and findings to your leader, who files them with the Jarvis tools.`,
      model: MODEL_OF(m),
      tools: m.web ? TOOLS_WORKER : TOOLS_WORKER.filter((t) => !t.startsWith('Web')),
      maxTurns: 60,
      // Foreground: a background subagent's permission prompts can never be answered, and one unanswered
      // prompt poisons the whole session ("the user doesn't want to take this action").
      background: false,
    };
  }
  return defs;
}

// ---------- prompts ----------
function missionPrompt(task, leader, subagents) {
  const team = Object.entries(subagents).map(([k, d]) => `- ${k}: ${d.description}`).join('\n');
  const parts = [
    `You are ${leader.name}, ${leader.role}. You lead this mission and are responsible for its outcome.`,
    `MISSION #${task.id}: ${task.title}`,
    task.instructions ? `INSTRUCTIONS:\n${task.instructions}` : '',
    task.dod ? `DEFINITION OF DONE (this is what will be verified):\n${task.dod}` : 'DEFINITION OF DONE: a concrete deliverable exists in the workspace (files) and, where relevant, actions were proposed with propose_action.',
    task.verify_note && task.round > 1 ? `THIS IS ROUND ${task.round}. The previous attempt failed verification:\n${task.verify_note}\nFix exactly that.` : '',
    team ? `YOUR TEAM (delegate with the Agent tool; they cannot use the jarvis tools, so you file their results):\n${team}` : 'You have no subagents; do the work yourself.',
    'WAY OF WORKING:\n- Start by writing journal/mission-' + task.id + '.md with your plan; keep it updated with progress and assumptions.\n- Split independent work across your team in parallel; verify their results before filing them.\n- File results with the jarvis tools (add_lead, propose_action, update_kpi, update_goal, remember) and save deliverables in the workspace.\n- Call report_progress at each milestone.\n- Never stop to ask questions; decide and continue. Never leave placeholders.\n- Finish with a short report: what was delivered (file paths, counts), what was proposed, what remains.',
  ];
  return parts.filter(Boolean).join('\n\n');
}

const memorySnippet = (scope) => {
  const m = readMemory(scope).trim();
  return m.length > 40 ? `\n\nMEMORY.md (lasting facts):\n${m.slice(0, 6000)}` : '';
};

// ---------- verification ----------
function changedFiles(root, sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'knowledge') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else {
        const st = fs.statSync(abs);
        if (st.mtimeMs >= sinceMs - 1000 && OUTPUT_EXT.test(e.name)) out.push({ rel: path.relative(root, abs).split(path.sep).join('/'), size: st.size });
      }
    }
  };
  walk(root, 0);
  return out;
}

function registerFiles(scope, taskId, files) {
  for (const f of files) {
    const existing = one('SELECT id FROM files WHERE org_id IS ? AND project_id IS NULL AND rel_path = ?', scope.orgId ?? null, f.rel);
    if (existing) run('UPDATE files SET size = ?, task_id = ?, created_at = ? WHERE id = ?', f.size, taskId, now(), existing.id);
    else insert('INSERT INTO files (org_id, project_id, task_id, rel_path, size, created_at) VALUES (?, NULL, ?, ?, ?, ?)', scope.orgId ?? null, taskId, f.rel, f.size, now());
  }
  if (files.length) notify('files', { orgId: scope.orgId ?? null });
}

// Cheap, deterministic checks first: files named in the definition of done must exist with real content.
function quickChecks(root, task, files) {
  const problems = [];
  const named = String(task.dod ?? '').match(/[\w./-]+\.(?:csv|md|txt|json|html?|py|js|ts|xlsx?|docx?|pdf)/gi) ?? [];
  for (const rel of new Set(named)) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      problems.push(`${rel} does not exist.`);
      continue;
    }
    const content = fs.readFileSync(abs, 'utf8');
    if (!content.trim()) problems.push(`${rel} is empty.`);
    if (rel.endsWith('.csv') && content.trim().split(/\r?\n/).length < 2) problems.push(`${rel} has no data rows.`);
    const want = String(task.dod).match(new RegExp(`(\\d+)\\s+(?:rows?|leads?|entries|lines)[^.]{0,60}${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.]{0,60}?(\\d+)\\s+(?:rows?|leads?|entries|lines)`, 'i'));
    const minRows = want ? Number(want[1] ?? want[2]) : null;
    if (rel.endsWith('.csv') && minRows && content.trim().split(/\r?\n/).length - 1 < minRows) problems.push(`${rel} has fewer than ${minRows} rows.`);
  }
  for (const f of files.slice(0, 40)) {
    if (/\.(csv|md|txt|html?)$/i.test(f.rel) && f.size < 200_000) {
      const content = fs.readFileSync(path.join(root, f.rel), 'utf8');
      if (hasPlaceholders(content)) problems.push(`${f.rel} still contains placeholders.`);
    }
  }
  // Messages waiting for Jarvis's review: the obvious defects are caught here, the judgement is the verifier's.
  for (const a of reviewItems(task.id)) {
    const d = JSON.parse(a.payload || '{}');
    const body = String(d.body ?? '');
    if (body.trim().length < 40) problems.push(`Message "${a.summary.slice(0, 60)}" has no real body.`);
    if ((a.kind === 'email' || a.kind === 'proposal') && !String(d.subject ?? '').trim()) problems.push(`Email "${a.summary.slice(0, 60)}" has no subject.`);
    if (hasPlaceholders(`${d.subject ?? ''}\n${body}`)) problems.push(`Message "${a.summary.slice(0, 60)}" still contains placeholders.`);
  }
  return problems;
}

// The messages a mission proposed, written where the verifier can read them.
function writeProposedFile(root, task) {
  const items = reviewItems(task.id);
  const file = path.join(root, 'journal', `proposed-${task.id}.md`);
  if (!items.length) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return { count: 0, rel: null };
  }
  const lines = [`# Messages proposed in mission #${task.id}`, '', 'Jarvis sends these automatically once the mission passes verification.', ''];
  items.forEach((a, i) => {
    const d = JSON.parse(a.payload || '{}');
    lines.push(`## ${i + 1}. [${a.kind}] ${a.summary}`, `To: ${d.to ?? ''}${d.to_name ? ` (${d.to_name})` : ''}${d.company ? ` · ${d.company}` : ''}`, d.subject ? `Subject: ${d.subject}` : '', d.hook ? `Hook: ${d.hook}` : '', '', String(d.body ?? ''), '');
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.filter((l) => l !== null).join('\n'));
  return { count: items.length, rel: `journal/proposed-${task.id}.md` };
}

async function verify({ scope, task, leader, root, report, files, signal }) {
  const problems = quickChecks(root, task, files);
  if (problems.length) return { passed: false, feedback: problems.join(' ') };
  const proposed = writeProposedFile(root, task);
  if (!task.dod && !proposed.count) return { passed: true, feedback: 'No definition of done; accepted on delivery.' };
  const res = await runSession({
    cwd: root,
    model: 'sonnet',
    maxTurns: 25,
    maxBudgetUsd: 1.5,
    timeoutMs: 10 * 60_000,
    disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task', 'WebSearch', 'WebFetch'],
    append: 'You are Jarvis reviewing your team’s work: strict but fair. You only read files; you never change anything. Judge whether the definition of done was actually met with real content (no placeholders, no invented contact details, numbers as required), and review every proposed message as if you were sending it under your own name. Reply with a short assessment and end with exactly one json block: {"passed": true|false, "feedback": "what is missing or wrong, specific and actionable"}.',
    prompt: `MISSION: ${task.title}\n\nDEFINITION OF DONE:\n${task.dod || '(none: judge the proposed messages only)'}\n\nLEADER'S FINAL REPORT:\n${report.slice(0, 8000)}\n\nFILES CHANGED DURING THE MISSION (paths relative to the workspace; read the important ones):\n${files.map((f) => `- ${f.rel} (${f.size} bytes)`).join('\n') || '(none)'}\n\n${proposed.count ? `MESSAGES PROPOSED: ${proposed.count}, listed in ${proposed.rel}. Read that file. They are sent automatically the moment you pass this mission, so check each one: a real recipient found on a real page; personalised to that business (not a template with the name swapped); the language the recipient uses; consistent with the company profile, offer and prices in CLAUDE.md; no false claims; no placeholders; polite and short enough for the channel; not a duplicate to the same recipient. If any message is not ready, fail the mission and name the numbers and what to fix.` : 'No messages were proposed.'} Leads in the CRM: ${(() => { try { return fs.readFileSync(path.join(root, 'crm', 'leads.csv'), 'utf8').trim().split(/\r?\n/).length - 1; } catch { return 0; } })()}.`,
    signal,
  });
  if (!res.ok) return { passed: true, feedback: `Verifier unavailable (${res.error.slice(0, 120)}); accepted.` };
  const verdict = extractJson(res.text);
  if (!verdict || typeof verdict.passed !== 'boolean') return { passed: true, feedback: 'Verifier gave no verdict; accepted.' };
  return { passed: verdict.passed, feedback: String(verdict.feedback ?? '').slice(0, 2000) };
}

// ---------- the scheduler ----------
class Scheduler {
  running = new Map(); // taskId -> { controller, engine }
  timer = null;
  started = false;

  get paused() {
    return getSetting('paused', '0') === '1';
  }

  start() {
    const { changes } = run(`UPDATE tasks SET status = 'queued', live_status = 'restarted' WHERE status = 'running' AND kind IN ('mission','review')`);
    if (changes) log('warn', `Recovered ${changes} interrupted mission(s) after restart`);
    // An Operator run cannot be resumed as a mission; the next scheduled tick simply runs it again.
    run(`UPDATE tasks SET status = 'cancelled', error = 'interrupted by a restart', finished_at = ? WHERE status = 'running' AND kind = 'operator'`, now());
    run(`UPDATE agents SET status = 'idle'`);
    // First-generation queue items (no mission target) are retired; the Operator re-plans the work properly.
    const retired = run(`UPDATE tasks SET status = 'cancelled', error = 'Retired: replaced by the new brain', finished_at = ? WHERE status = 'queued' AND target IS NULL`, now()).changes;
    if (retired) log('info', `Retired ${retired} first-generation queued task(s)`);
    this.started = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    for (const r of this.running.values()) r.controller.abort();
  }

  cooldownUntil = (engine) => Number(getSetting(`cooldown:${engine}`, '0'));

  status(engine) {
    const runningNow = [...this.running.values()].filter((r) => r.engine === engine).length;
    const cd = this.cooldownUntil(engine);
    const enabled = getSetting(`${engine}_enabled`, '1') === '1';
    return { name: engine, enabled, running: runningNow, maxConcurrent: CONCURRENCY[engine], cooldownUntil: cd > now() ? cd : null, available: enabled && cd <= now() && runningNow < CONCURRENCY[engine] };
  }

  pick(task) {
    if (this.status('claude').available) return 'claude';
    // Codex is a fallback for building software while Claude is out of quota.
    if (this.status('codex').available && /build|website|landing|app|script|code|prototype/i.test(`${task.title} ${task.dod}`)) return 'codex';
    return null;
  }

  tick() {
    if (!this.started || this.paused) return;
    const queued = all(
      `SELECT * FROM tasks WHERE status = 'queued' AND kind IN ('mission','operator','review') AND not_before <= ?
         AND (blocked_by IS NULL OR blocked_by IN (SELECT id FROM tasks WHERE status = 'done'))
       ORDER BY priority DESC, id ASC LIMIT 50`,
      now(),
    );
    for (const task of queued) {
      if (this.running.has(task.id)) continue;
      const engine = this.pick(task);
      if (!engine) break;
      this.launch(task, engine).catch((err) => log('error', `Mission #${task.id} crashed: ${err.message}`, task.org_id));
    }
  }

  async launch(task, engine) {
    const scope = { orgId: task.org_id };
    const leader = task.agent_id ? one('SELECT * FROM agents WHERE id = ?', task.agent_id) : leaderFor(scope, JSON.parse(task.target || '{"type":"org"}'));
    if (!leader) return this.finish(task.id, 'failed', 'No agent can lead this mission');
    const controller = new AbortController();
    this.running.set(task.id, { controller, engine });
    const startedAt = now();
    run(`UPDATE tasks SET status = 'running', provider = ?, attempts = attempts + 1, started_at = ?, live_status = 'starting' WHERE id = ?`, engine, startedAt, task.id);
    run(`UPDATE agents SET status = 'working' WHERE id = ?`, leader.id);
    log('info', `▶ ${leader.name} started mission #${task.id} (${engine}${task.round > 1 ? `, round ${task.round}` : ''}): ${task.title}`, task.org_id);
    notify('tasks', { orgId: task.org_id });

    const root = writeClaudeMd(scope);
    try {
      syncKnowledge(scope, root);
    } catch {
      // Obsidian notes are optional
    }
    const subagents = teamAsSubagents(leader);
    const prompt = missionPrompt(task, leader, subagents) + memorySnippet(scope);
    snapshot(root, `Before mission #${task.id}: ${task.title}`);
    const runId = insert('INSERT INTO runs (task_id, provider, model, started_at) VALUES (?, ?, ?, ?)', task.id, engine, engine === 'claude' ? MODEL_OF(leader) : null, startedAt);
    const onProgress = (ev) => {
      if (ev.kind === 'tool') recordActivity({ scope, task, agent: ev.subagent ? `${leader.name} › ${ev.subagent}` : leader.name, kind: 'tool', text: ev.text });
    };

    let res;
    if (engine === 'claude') {
      const tools = jarvisTools({ scope, task, agent: leader, hooks: { createMission: (spec) => createMission({ ...spec, parent: task }) } });
      res = await runSession({ cwd: root, prompt, model: MODEL_OF(leader), agents: subagents, mcpServers: { jarvis: tools, ...(await browserServers()) }, onProgress, signal: controller.signal, timeoutMs: config.runTimeoutMs * 3 });
    } else {
      const r = await runCodex({ bin: config.codexBin, prompt: `${prompt}\n\n(Work inside this folder only. You have no jarvis tools in this mode: put leads in crm/leads.csv and drafts in drafts/, and describe proposed actions in your final report.)`, cwd: root, timeoutMs: config.runTimeoutMs * 2, signal: controller.signal });
      res = { ...r, sessionId: null, toolCalls: 0, denials: [] };
    }
    this.running.delete(task.id);
    run(`UPDATE agents SET status = 'idle' WHERE id = ?`, leader.id);
    const outcome = res.ok ? 'ok' : res.limited ? 'limited' : res.timedOut ? 'timeout' : res.aborted ? 'aborted' : 'error';
    run('UPDATE runs SET finished_at = ?, outcome = ?, cost_usd = ? WHERE id = ?', now(), outcome, res.costUsd || 0, runId);
    run('UPDATE tasks SET session_id = COALESCE(?, session_id), cost_usd = cost_usd + ? WHERE id = ?', res.sessionId ?? null, res.costUsd || 0, task.id);

    if (res.limited) {
      const until = res.resetAt && res.resetAt > now() ? res.resetAt + 60_000 : now() + config.limitCooldownMs;
      setSetting(`cooldown:${engine}`, until);
      run(`UPDATE tasks SET status = 'queued', attempts = attempts - 1, live_status = ? WHERE id = ?`, `waiting: ${engine} usage limit until ${new Date(until).toLocaleTimeString()}`, task.id);
      log('warn', `${engine} usage limit reached; missions wait until ${new Date(until).toLocaleTimeString()}`, task.org_id);
      notify('status');
      return;
    }
    if (res.aborted) return this.finish(task.id, 'cancelled', 'Cancelled');
    if (!res.ok) {
      const fresh = one('SELECT attempts FROM tasks WHERE id = ?', task.id);
      if (fresh.attempts < config.maxAttempts && !res.timedOut) {
        run(`UPDATE tasks SET status = 'queued', not_before = ?, error = ?, live_status = 'retrying' WHERE id = ?`, now() + 2 ** fresh.attempts * 60_000, res.error, task.id);
        log('warn', `Mission #${task.id} ${outcome}; retrying. ${String(res.error).slice(0, 160)}`, task.org_id);
        notify('tasks', { orgId: task.org_id });
        return;
      }
      return this.finish(task.id, 'failed', res.error || outcome);
    }

    // Delivered: snapshot the folder, register files, verify, and either accept or send it back with feedback.
    const sha = snapshot(root, `Mission #${task.id} (round ${task.round}): ${task.title}`);
    if (sha) run('UPDATE tasks SET commits = ? WHERE id = ?', JSON.stringify([...JSON.parse(one('SELECT commits FROM tasks WHERE id = ?', task.id).commits || '[]'), sha]), task.id);
    const files = changedFiles(root, startedAt);
    registerFiles(scope, task.id, files);
    run(`UPDATE tasks SET result = ?, summary = ?, live_status = 'verifying' WHERE id = ?`, res.text, res.text.split('\n').find((l) => l.trim())?.slice(0, 300) ?? '', task.id);
    notify('tasks', { orgId: task.org_id });
    let verdict = { passed: true, feedback: '' };
    if (task.kind === 'mission') verdict = await verify({ scope, task, leader, root, report: res.text, files, signal: controller.signal });
    if (verdict.passed) {
      run(`UPDATE tasks SET status = 'done', verify_status = ?, verify_note = ?, live_status = NULL, finished_at = ? WHERE id = ?`, task.dod ? 'passed' : 'skipped', verdict.feedback, now(), task.id);
      const released = task.kind === 'mission' ? releaseReviewed(task.id, { passed: true }) : 0;
      log('info', `✔ Mission #${task.id} delivered and verified: ${task.title}${files.length ? ` · ${files.length} file(s)` : ''}${released ? ` · ${released} message(s) reviewed and released` : ''}`, task.org_id);
      writeReport(one('SELECT * FROM tasks WHERE id = ?', task.id), leader);
      // A delivered mission wakes the Operator so the next piece of work is planned without waiting for the clock.
      if (task.org_id) import('./operator.js').then((m) => m.wakeOperator(task.org_id, `mission #${task.id} delivered: ${task.title}`)).catch(() => {});
    } else if (task.round < MAX_ROUNDS) {
      run(`UPDATE tasks SET status = 'queued', round = round + 1, verify_status = 'failed', verify_note = ?, live_status = 'sent back with feedback' WHERE id = ?`, verdict.feedback, task.id);
      log('warn', `↩ Mission #${task.id} sent back (round ${task.round + 1}): ${verdict.feedback.slice(0, 160)}`, task.org_id);
    } else {
      run(`UPDATE tasks SET status = 'failed', verify_status = 'failed', verify_note = ?, error = ?, live_status = NULL, finished_at = ? WHERE id = ?`, verdict.feedback, `Not delivered after ${MAX_ROUNDS} rounds: ${verdict.feedback}`, now(), task.id);
      releaseReviewed(task.id, { passed: false, feedback: verdict.feedback });
      log('error', `✖ Mission #${task.id} failed verification ${MAX_ROUNDS} times: ${task.title}`, task.org_id);
    }
    notify('tasks', { orgId: task.org_id });
    notify('status');
    setImmediate(() => this.tick());
  }

  finish(id, status, error) {
    run('UPDATE tasks SET status = ?, error = ?, live_status = NULL, finished_at = ? WHERE id = ?', status, error, now(), id);
    if (status !== 'done') releaseReviewed(id, { passed: false, feedback: String(error ?? status) });
    const t = one('SELECT org_id, title, agent_id FROM tasks WHERE id = ?', id);
    if (t?.agent_id) run(`UPDATE agents SET status = 'idle' WHERE id = ?`, t.agent_id);
    if (status === 'failed') log('error', `✖ Mission failed: ${t?.title}: ${String(error).slice(0, 200)}`, t?.org_id);
    notify('tasks', { orgId: t?.org_id });
  }

  cancel(id) {
    const r = this.running.get(id);
    if (r) r.controller.abort();
    else if (one('SELECT status FROM tasks WHERE id = ?', id)?.status === 'queued') this.finish(id, 'cancelled', 'Cancelled');
  }

  retry(id) {
    run(`UPDATE tasks SET status = 'queued', attempts = 0, not_before = 0, error = NULL, round = 1, verify_note = NULL WHERE id = ? AND status IN ('failed','cancelled')`, id);
    notify('tasks');
    this.tick();
  }

  pause() {
    setSetting('paused', '1');
    for (const r of this.running.values()) r.controller.abort();
    log('warn', 'All agents stopped by the owner');
    notify('status');
  }

  resume() {
    setSetting('paused', '0');
    log('info', 'Agents resumed');
    notify('status');
    this.tick();
  }

  clearCooldown(engine) {
    setSetting(`cooldown:${engine}`, '0');
    notify('status');
    this.tick();
  }
}

// The browser MCP server is optional (task #7); loaded lazily so a missing install never blocks missions.
let browserModule = null;
async function browserServers() {
  if (browserModule === null) {
    try {
      browserModule = await import('./browser.js');
    } catch {
      browserModule = false;
    }
  }
  if (!browserModule?.playwrightServer) return {};
  try {
    return { playwright: browserModule.playwrightServer() };
  } catch {
    return {};
  }
}

export const scheduler = new Scheduler();
