import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { one, all, run, insert, now, getSetting, setSetting } from './db.js';
import { log, notify, bus } from './events.js';
import * as auth from './auth.js';
import { route, readJson, readBody, send, HttpError, id, optId, text, maybe } from './http.js';
import { decideApproval, apiSpendThisMonth, apiCap } from './engine.js';
import { scheduler, createMission } from './brain/missions.js';
import { runOperator, currentPlan } from './brain/operator.js';
import { chat, resetConversation } from './brain/chat.js';
import { ensureOrgJarvis, DEPARTMENT_COLORS, periodLabels } from './agents.js';
import { proposeStructure, applyDraft, latestDraft } from './structure.js';
import { addMemory, listMemories, saveKnowledge, resolveFile } from './mind.js';
import { probe } from './providers/process.js';
import { config } from './config.js';
import { clampPriority } from './protocol.js';
import { testHubspot } from './connectors/hubspot.js';
import { testGmail } from './connectors/gmail.js';
import { testWhatsapp, verifyToken, signatureValid, whatsappConnected, whatsappDailyLimit, whatsappSentToday } from './connectors/whatsapp.js';
import { deliverQueued, dailyLimit, sentToday, receiveWhatsapp } from './outbox.js';
import { orgDir, suggestOrgFolder, moveOrgWorkspace, ensureWorkspace } from './brain/workspace.js';
import { LEVELS, approvalSentence } from './brain/policy.js';
import { defaultVault, initVault, syncMinds, writeBriefing } from './connectors/obsidian.js';
import { listBlocked, blockContact, unblock } from './optout.js';

const COOKIE = 'jarvis_session';
const cookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
const parseApproval = (a) => ({ ...a, payload: JSON.parse(a.payload || '{}') });
const orgParam = (q) => (q.get('org') ? id(q.get('org')) : null);

// Writes only the listed fields that were actually sent.
function update(table, rowId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  run(`UPDATE ${table} SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...entries.map(([, v]) => v), rowId);
}

function mustExist(table, rowId, label) {
  const row = one(`SELECT * FROM ${table} WHERE id = ?`, rowId);
  if (!row) throw new HttpError(404, `${label} not found`);
  return row;
}

// ---------- auth ----------
route('GET', '/healthz', (req, res) => send(res, 200, { ok: true }), { open: true });
route('GET', '/api/me', (req, res, ctx) => send(res, 200, { authenticated: ctx.authed, setupRequired: !auth.isSetUp() }), { open: true });

// First run only, and only from this computer: choose the password in the app.
route(
  'POST',
  '/api/setup',
  async (req, res) => {
    if (auth.isSetUp()) throw new HttpError(409, 'A password is already set');
    const addr = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new HttpError(403, 'Setup is only allowed on this computer');
    const { password } = await readJson(req);
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Use at least 8 characters');
    auth.setPassword(password);
    const token = auth.createSession(req.headers['user-agent']);
    log('info', 'Password created');
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(token, 30 * 86400) });
  },
  { open: true },
);

route(
  'POST',
  '/api/login',
  async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!auth.loginAllowed(ip)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
    const { password, client } = await readJson(req);
    if (!auth.checkPassword(String(password ?? ''))) {
      auth.recordFailure(ip);
      throw new HttpError(401, 'Wrong password');
    }
    auth.clearFailures(ip);
    const token = auth.createSession(req.headers['user-agent']);
    send(res, 200, client === 'app' ? { ok: true, token } : { ok: true }, { 'Set-Cookie': cookie(token, 30 * 86400) });
  },
  { open: true },
);

route('POST', '/api/logout', (req, res, ctx) => {
  auth.destroySession(ctx.token);
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
});

// ---------- overview / home ----------
function departmentCards(orgId) {
  return all('SELECT * FROM departments WHERE org_id = ? ORDER BY position, id', orgId).map((d) => {
    const agents = all(`SELECT a.status FROM agents a LEFT JOIN teams t ON t.id = a.team_id WHERE a.department_id = ? OR t.department_id = ?`, d.id, d.id);
    const pending = one(
      `SELECT COUNT(*) AS n FROM approvals ap JOIN tasks t ON t.id = ap.task_id WHERE t.department_id = ? AND ap.status = 'pending'`,
      d.id,
    ).n;
    const goal = one(`SELECT title, progress, period_label FROM goals WHERE scope = 'department' AND scope_id = ? AND period = 'month' LIMIT 1`, d.id);
    const head = one(`SELECT name FROM agents WHERE department_id = ? AND tier = 'head'`, d.id);
    const teams = one('SELECT COUNT(*) AS n FROM teams WHERE department_id = ?', d.id).n;
    return {
      ...d,
      head: head?.name ?? null,
      teams,
      total: agents.length,
      live: agents.filter((a) => a.status === 'working').length,
      pending,
      goal,
    };
  });
}

route('GET', '/api/overview', (req, res, ctx) => {
  const orgId = orgParam(ctx.query);
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const scopeSql = orgId ? 'org_id = ?' : 'org_id IS NULL';
  const scopeArgs = orgId ? [orgId] : [];
  const needsYou = all(
    `SELECT ap.*, t.title AS task_title, a.name AS agent_name FROM approvals ap LEFT JOIN tasks t ON t.id = ap.task_id
     LEFT JOIN agents a ON a.id = t.agent_id WHERE ap.status = 'pending' AND ap.${scopeSql} ORDER BY ap.id DESC LIMIT 20`,
    ...scopeArgs,
  ).map(parseApproval);
  const last = one(`SELECT id, title, summary FROM tasks WHERE status = 'done' AND ${scopeSql} AND created_by NOT LIKE 'review:%' ORDER BY finished_at DESC LIMIT 1`, ...scopeArgs);
  const agents = all(`SELECT status FROM agents WHERE ${scopeSql}`, ...scopeArgs);
  send(res, 200, {
    paused: scheduler.paused,
    autonomy: getSetting('autonomy', '1') === '1',
    plan: orgId ? currentPlan(orgId) : null,
    activity: all('SELECT * FROM activity WHERE (? IS NULL AND org_id IS NULL OR org_id = ?) ORDER BY id DESC LIMIT 20', orgId, orgId),
    engines: [scheduler.status('claude'), scheduler.status('codex'), { name: 'api', enabled: Boolean(getSetting('anthropic_api_key')), running: 0, maxConcurrent: 0, cooldownUntil: null, available: false }],
    api: { spent: apiSpendThisMonth(), cap: apiCap(), keySet: Boolean(getSetting('anthropic_api_key')) },
    today: one(`SELECT COUNT(*) AS runs, SUM(outcome = 'ok') AS ok FROM runs WHERE started_at >= ?`, dayStart),
    pendingTotal: one(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`).n,
    needsYou,
    lastOutput: last,
    queued: one(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND kind = 'mission' AND ${scopeSql}`, ...scopeArgs).n,
    running: one(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'running' AND kind IN ('mission','operator') AND ${scopeSql}`, ...scopeArgs).n,
    agentsTotal: agents.length,
    agentsWorking: agents.filter((a) => a.status === 'working').length,
    departments: orgId ? departmentCards(orgId) : [],
    periods: periodLabels(),
  });
});

// ---------- organisations ----------
route('GET', '/api/orgs', (req, res) => {
  send(
    res,
    200,
    all('SELECT * FROM orgs WHERE archived = 0 ORDER BY name COLLATE NOCASE').map((o) => ({
      ...o,
      pending: one(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND status = 'pending'`, o.id).n,
      working: one(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND status = 'working'`, o.id).n,
      departments: one('SELECT COUNT(*) AS n FROM departments WHERE org_id = ?', o.id).n,
    })),
  );
});

route('POST', '/api/orgs', async (req, res) => {
  const b = await readJson(req);
  const t = now();
  const count = one('SELECT COUNT(*) AS n FROM orgs').n;
  const orgId = insert(
    'INSERT INTO orgs (name, description, profile, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    text(b.name, 80, 'Name'),
    maybe(b.description, 300) ?? '',
    maybe(b.profile, 20_000) ?? '',
    ['#39e58c', '#ff8a3d', '#b36bff', '#3fb5ff', '#ffd23f'][count % 5],
    t,
    t,
  );
  ensureOrgJarvis(orgId);
  // Every organisation gets its own folder on this PC, where Jarvis has full rights.
  let folder = null;
  try {
    const wanted = typeof b.folder === 'string' && path.isAbsolute(b.folder.trim()) ? b.folder.trim() : suggestOrgFolder(b.name);
    folder = moveOrgWorkspace(orgId, wanted);
    ensureWorkspace({ orgId });
  } catch (err) {
    log('warn', `Could not create the folder for ${b.name}: ${err.message}`, orgId);
  }
  log('info', `Organisation created: ${b.name}${folder ? ` (folder ${folder})` : ''}`, orgId);
  notify('orgs');
  send(res, 201, { id: orgId, folder });
});

route('GET', '/api/orgs/folder-suggestion', (req, res, ctx) => send(res, 200, { folder: suggestOrgFolder(ctx.query.get('name') || '') }));

// Move an organisation to another folder on this PC (its files are copied over).
route('PUT', '/api/orgs/:id/workspace', async (req, res, ctx) => {
  const org = mustExist('orgs', id(ctx.params.id), 'Organisation');
  const b = await readJson(req);
  const target = text(b.path, 400, 'Folder').trim();
  if (!path.isAbsolute(target)) throw new HttpError(400, 'Use a full folder path, for example D:\\JarvisCompanies\\Acme');
  const lower = path.resolve(target).toLowerCase();
  const src = path.resolve(import.meta.dirname, '..').toLowerCase();
  if (lower === src || lower.startsWith(src + path.sep) || lower.startsWith(path.resolve(config.dataDir).toLowerCase() + path.sep + 'db')) throw new HttpError(400, 'Choose a folder outside the Jarvis program folder');
  try {
    const folder = moveOrgWorkspace(org.id, target);
    ensureWorkspace({ orgId: org.id });
    log('info', `${org.name} now works in ${folder}`, org.id);
    notify('orgs');
    send(res, 200, { ok: true, folder });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});

// Opens the organisation's folder in Explorer.
route('POST', '/api/orgs/:id/workspace/open', (req, res, ctx) => {
  const org = mustExist('orgs', id(ctx.params.id), 'Organisation');
  const dir = ensureWorkspace({ orgId: org.id });
  spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  send(res, 200, { ok: true, folder: dir });
});

route('GET', '/api/orgs/:id', (req, res, ctx) => {
  const org = mustExist('orgs', id(ctx.params.id), 'Organisation');
  send(res, 200, {
    ...org,
    folder: orgDir(org.id),
    departments: departmentCards(org.id),
    goals: all(`SELECT * FROM goals WHERE scope = 'org' AND scope_id = ? ORDER BY period`, org.id),
    feed: all('SELECT * FROM events WHERE org_id = ? ORDER BY id DESC LIMIT 12', org.id),
  });
});

route('PUT', '/api/orgs/:id', async (req, res, ctx) => {
  const orgId = id(ctx.params.id);
  const b = await readJson(req);
  update('orgs', orgId, { name: maybe(b.name, 80), description: maybe(b.description, 300), profile: maybe(b.profile, 20_000), color: maybe(b.color, 9), updated_at: now() });
  notify('orgs');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/orgs/:id', (req, res, ctx) => {
  run('UPDATE orgs SET archived = 1 WHERE id = ?', id(ctx.params.id));
  notify('orgs');
  send(res, 200, { ok: true });
});

route('POST', '/api/orgs/:id/propose', (req, res, ctx) => {
  const orgId = mustExist('orgs', id(ctx.params.id), 'Organisation').id;
  proposeStructure(orgId).catch((err) => log('error', `Proposal crashed: ${err.message}`, orgId));
  send(res, 202, { ok: true });
});

route('GET', '/api/orgs/:id/draft', (req, res, ctx) => send(res, 200, latestDraft(id(ctx.params.id))));

route('POST', '/api/orgs/:id/draft/apply', async (req, res, ctx) => {
  const orgId = id(ctx.params.id);
  const b = await readJson(req);
  applyDraft(orgId, b.body ?? latestDraft(orgId)?.body);
  send(res, 200, { ok: true });
});

// ---------- departments ----------
route('GET', '/api/departments/:id', (req, res, ctx) => {
  const d = mustExist('departments', id(ctx.params.id), 'Department');
  const teams = all('SELECT * FROM teams WHERE department_id = ? ORDER BY position, id', d.id).map((t) => ({
    ...t,
    leader: one(`SELECT id, name, role, status FROM agents WHERE team_id = ? AND tier = 'leader'`, t.id),
    agents: all(`SELECT id, name, role, status FROM agents WHERE team_id = ? AND tier = 'worker'`, t.id),
    open: one(`SELECT COUNT(*) AS n FROM tasks WHERE team_id = ? AND status IN ('queued','running')`, t.id).n,
    pending: one(`SELECT COUNT(*) AS n FROM approvals WHERE team_id = ? AND status = 'pending'`, t.id).n,
    kpis: all(`SELECT * FROM kpis WHERE scope = 'team' AND scope_id = ?`, t.id),
  }));
  send(res, 200, {
    ...d,
    org: one('SELECT id, name FROM orgs WHERE id = ?', d.org_id),
    head: one(`SELECT * FROM agents WHERE department_id = ? AND tier = 'head'`, d.id),
    teams,
    goals: all(`SELECT * FROM goals WHERE scope = 'department' AND scope_id = ? ORDER BY CASE period WHEN 'quarter' THEN 0 WHEN 'month' THEN 1 ELSE 2 END`, d.id),
    kpis: all(`SELECT * FROM kpis WHERE scope = 'department' AND scope_id = ?`, d.id),
    agentKpis: all(
      `SELECT k.*, a.name AS agent_name FROM kpis k JOIN agents a ON a.id = k.scope_id
       LEFT JOIN teams t ON t.id = a.team_id WHERE k.scope = 'agent' AND (a.department_id = ? OR t.department_id = ?)`,
      d.id,
      d.id,
    ),
    needsYou: all(
      `SELECT ap.* FROM approvals ap JOIN tasks t ON t.id = ap.task_id WHERE t.department_id = ? AND ap.status = 'pending' ORDER BY ap.id DESC`,
      d.id,
    ).map(parseApproval),
    tasks: all('SELECT id, title, status, summary, agent_id FROM tasks WHERE department_id = ? ORDER BY id DESC LIMIT 20', d.id),
  });
});

route('POST', '/api/orgs/:id/departments', async (req, res, ctx) => {
  const orgId = mustExist('orgs', id(ctx.params.id), 'Organisation').id;
  const b = await readJson(req);
  const n = one('SELECT COUNT(*) AS n FROM departments WHERE org_id = ?', orgId).n;
  const deptId = insert(
    'INSERT INTO departments (org_id, name, description, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    orgId,
    text(b.name, 60, 'Name'),
    maybe(b.description, 400) ?? '',
    maybe(b.color, 9) ?? DEPARTMENT_COLORS[n % DEPARTMENT_COLORS.length],
    n,
    now(),
  );
  insert(
    `INSERT INTO agents (org_id, department_id, name, role, instructions, tier, web, created_at) VALUES (?, ?, ?, ?, ?, 'head', 1, ?)`,
    orgId,
    deptId,
    maybe(b.headName, 40) || 'Head',
    maybe(b.headRole, 80) || `Head of ${b.name}`,
    maybe(b.headInstructions, 1500) ?? '',
    now(),
  );
  notify('org', { orgId });
  send(res, 201, { id: deptId });
});

route('PUT', '/api/departments/:id', async (req, res, ctx) => {
  const b = await readJson(req);
  update('departments', id(ctx.params.id), { name: maybe(b.name, 60), description: maybe(b.description, 400), color: maybe(b.color, 9) });
  notify('org');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/departments/:id', (req, res, ctx) => {
  run('DELETE FROM departments WHERE id = ?', id(ctx.params.id));
  notify('org');
  send(res, 200, { ok: true });
});

// ---------- teams ----------
route('GET', '/api/teams/:id', (req, res, ctx) => {
  const t = mustExist('teams', id(ctx.params.id), 'Team');
  const dept = one('SELECT * FROM departments WHERE id = ?', t.department_id);
  const agents = all(`SELECT * FROM agents WHERE team_id = ? ORDER BY tier = 'leader' DESC, id`, t.id).map((a) => ({
    ...a,
    current: one(`SELECT id, title FROM tasks WHERE agent_id = ? AND status = 'running' LIMIT 1`, a.id),
    kpis: all(`SELECT * FROM kpis WHERE scope = 'agent' AND scope_id = ?`, a.id),
  }));
  send(res, 200, {
    ...t,
    department: dept,
    org: one('SELECT id, name FROM orgs WHERE id = ?', dept.org_id),
    leader: agents.find((a) => a.tier === 'leader') ?? null,
    agents: agents.filter((a) => a.tier !== 'leader'),
    goals: all(`SELECT * FROM goals WHERE scope = 'team' AND scope_id = ?`, t.id),
    deptGoals: all(`SELECT * FROM goals WHERE scope = 'department' AND scope_id = ?`, dept.id),
    kpis: all(`SELECT * FROM kpis WHERE scope = 'team' AND scope_id = ?`, t.id),
    tasks: all(
      `SELECT t.id, t.title, t.status, t.summary, t.priority, t.created_by, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.team_id = ? ORDER BY t.id DESC LIMIT 60`,
      t.id,
    ),
    needsYou: all(`SELECT * FROM approvals WHERE team_id = ? AND status = 'pending' ORDER BY id DESC`, t.id).map(parseApproval),
  });
});

route('POST', '/api/departments/:id/teams', async (req, res, ctx) => {
  const dept = mustExist('departments', id(ctx.params.id), 'Department');
  const b = await readJson(req);
  const n = one('SELECT COUNT(*) AS n FROM teams WHERE department_id = ?', dept.id).n;
  const teamId = insert('INSERT INTO teams (department_id, name, description, position, created_at) VALUES (?, ?, ?, ?, ?)', dept.id, text(b.name, 60, 'Name'), maybe(b.description, 400) ?? '', n, now());
  insert(
    `INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, web, created_at) VALUES (?, ?, ?, ?, ?, ?, 'leader', 1, ?)`,
    dept.org_id,
    dept.id,
    teamId,
    maybe(b.leaderName, 40) || 'Leader',
    maybe(b.leaderRole, 80) || `${b.name} leader`,
    maybe(b.leaderInstructions, 1500) ?? '',
    now(),
  );
  notify('org', { orgId: dept.org_id });
  send(res, 201, { id: teamId });
});

route('PUT', '/api/teams/:id', async (req, res, ctx) => {
  const b = await readJson(req);
  const teamId = id(ctx.params.id);
  update('teams', teamId, {
    name: maybe(b.name, 60),
    description: maybe(b.description, 400),
    leader_can_approve: typeof b.leader_can_approve === 'boolean' ? Number(b.leader_can_approve) : undefined,
  });
  if (typeof b.leader_can_approve === 'boolean') {
    const t = one('SELECT name FROM teams WHERE id = ?', teamId);
    log('info', `${t.name}: team leader ${b.leader_can_approve ? 'can now approve' : 'can no longer approve'} outgoing work`);
  }
  notify('org');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/teams/:id', (req, res, ctx) => {
  run('DELETE FROM teams WHERE id = ?', id(ctx.params.id));
  notify('org');
  send(res, 200, { ok: true });
});

// ---------- agents, goals, KPIs ----------
route('POST', '/api/agents', async (req, res) => {
  const b = await readJson(req);
  const teamId = optId(b.team_id);
  const team = teamId ? mustExist('teams', teamId, 'Team') : null;
  const dept = team ? one('SELECT * FROM departments WHERE id = ?', team.department_id) : null;
  const agentId = insert(
    'INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    dept?.org_id ?? optId(b.org_id),
    dept?.id ?? optId(b.department_id),
    teamId,
    text(b.name, 40, 'Name'),
    text(b.role, 80, 'Role'),
    maybe(b.instructions, 2000) ?? '',
    ['worker', 'leader', 'head'].includes(b.tier) ? b.tier : 'worker',
    ['auto', 'strong', 'worker', 'bulk', 'codex'].includes(b.model) ? b.model : 'auto',
    b.web ? 1 : 0,
    now(),
  );
  notify('org');
  send(res, 201, { id: agentId });
});

route('PUT', '/api/agents/:id', async (req, res, ctx) => {
  const b = await readJson(req);
  update('agents', id(ctx.params.id), {
    name: maybe(b.name, 40),
    role: maybe(b.role, 80),
    instructions: maybe(b.instructions, 2000),
    model: ['auto', 'strong', 'worker', 'bulk', 'codex'].includes(b.model) ? b.model : undefined,
    web: typeof b.web === 'boolean' ? Number(b.web) : undefined,
  });
  notify('org');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/agents/:id', (req, res, ctx) => {
  run(`DELETE FROM agents WHERE id = ? AND tier != 'jarvis'`, id(ctx.params.id));
  notify('org');
  send(res, 200, { ok: true });
});

const SCOPES = ['org', 'department', 'team', 'agent'];
route('POST', '/api/goals', async (req, res) => {
  const b = await readJson(req);
  if (!SCOPES.includes(b.scope)) throw new HttpError(400, 'Invalid scope');
  const period = ['quarter', 'month', 'week'].includes(b.period) ? b.period : 'month';
  const t = now();
  const goalId = insert(
    'INSERT INTO goals (org_id, scope, scope_id, period, period_label, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id(b.org_id),
    b.scope,
    id(b.scope_id),
    period,
    maybe(b.period_label, 40) || periodLabels()[period],
    text(b.title, 200, 'Goal'),
    t,
    t,
  );
  notify('goals');
  send(res, 201, { id: goalId });
});

route('PUT', '/api/goals/:id', async (req, res, ctx) => {
  const b = await readJson(req);
  const progress = Number(b.progress);
  update('goals', id(ctx.params.id), { title: maybe(b.title, 200), progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : undefined, updated_at: now() });
  notify('goals');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/goals/:id', (req, res, ctx) => {
  run('DELETE FROM goals WHERE id = ?', id(ctx.params.id));
  notify('goals');
  send(res, 200, { ok: true });
});

route('POST', '/api/kpis', async (req, res) => {
  const b = await readJson(req);
  if (!['department', 'team', 'agent'].includes(b.scope)) throw new HttpError(400, 'Invalid scope');
  const target = Number(b.target);
  const kpiId = insert(
    'INSERT INTO kpis (org_id, scope, scope_id, name, target, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id(b.org_id),
    b.scope,
    id(b.scope_id),
    text(b.name, 80, 'KPI name'),
    Number.isFinite(target) ? target : null,
    maybe(b.unit, 12) ?? '',
    now(),
  );
  notify('goals');
  send(res, 201, { id: kpiId });
});

route('PUT', '/api/kpis/:id', async (req, res, ctx) => {
  const b = await readJson(req);
  const num = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  update('kpis', id(ctx.params.id), { name: maybe(b.name, 80), target: num(b.target), actual: num(b.actual), unit: maybe(b.unit, 12), updated_at: now() });
  notify('goals');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/kpis/:id', (req, res, ctx) => {
  run('DELETE FROM kpis WHERE id = ?', id(ctx.params.id));
  notify('goals');
  send(res, 200, { ok: true });
});

// ---------- projects ----------
route('GET', '/api/projects', (req, res, ctx) => {
  const orgId = orgParam(ctx.query);
  const rows = all(
    `SELECT p.*, SUM(t.status = 'done') AS done, COUNT(t.id) AS total FROM projects p LEFT JOIN tasks t ON t.project_id = p.id AND t.depth = 0
     WHERE p.org_id IS ? AND p.status != 'archived' GROUP BY p.id ORDER BY p.updated_at DESC`,
    orgId,
  ).map((p) => ({
    ...p,
    next: one(`SELECT title FROM tasks WHERE project_id = ? AND status IN ('queued','running') ORDER BY priority DESC, id LIMIT 1`, p.id)?.title ?? null,
  }));
  send(res, 200, rows);
});

route('POST', '/api/projects', async (req, res) => {
  const b = await readJson(req);
  const t = now();
  const projectId = insert(
    'INSERT INTO projects (org_id, department_id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    optId(b.org_id),
    optId(b.department_id),
    text(b.name, 80, 'Name'),
    maybe(b.description, 2000) ?? '',
    maybe(b.color, 9) ?? ['#ffb13d', '#39e58c', '#b36bff', '#ff5a5a', '#3fb5ff'][Math.floor(Math.random() * 5)],
    t,
    t,
  );
  notify('projects');
  send(res, 201, { id: projectId });
});

route('GET', '/api/projects/:id', (req, res, ctx) => {
  const p = mustExist('projects', id(ctx.params.id), 'Project');
  send(res, 200, {
    ...p,
    tasks: all(
      `SELECT t.id, t.title, t.status, t.summary, t.depth, t.created_at, t.finished_at, a.name AS agent_name FROM tasks t
       LEFT JOIN agents a ON a.id = t.agent_id WHERE t.project_id = ? ORDER BY t.id DESC LIMIT 100`,
      p.id,
    ),
  });
});

route('PUT', '/api/projects/:id', async (req, res, ctx) => {
  const b = await readJson(req);
  update('projects', id(ctx.params.id), {
    name: maybe(b.name, 80),
    description: maybe(b.description, 2000),
    status: ['active', 'done', 'archived'].includes(b.status) ? b.status : undefined,
    updated_at: now(),
  });
  notify('projects');
  send(res, 200, { ok: true });
});

// ---------- tasks ----------
route('GET', '/api/tasks', (req, res, ctx) => {
  const q = ctx.query;
  const where = ['1 = 1'];
  const args = [];
  if (q.get('org')) (where.push('t.org_id = ?'), args.push(id(q.get('org'))));
  if (q.get('personal')) where.push('t.org_id IS NULL');
  if (q.get('team')) (where.push('t.team_id = ?'), args.push(id(q.get('team'))));
  if (q.get('status')) (where.push('t.status = ?'), args.push(q.get('status')));
  const limit = Math.min(Number(q.get('limit')) || 100, 300);
  send(
    res,
    200,
    all(
      `SELECT t.id, t.org_id, t.project_id, t.title, t.status, t.summary, t.priority, t.provider, t.model, t.created_at, t.finished_at, t.kind, t.dod, t.verify_status, t.round, t.live_status, a.name AS agent_name
       FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE ${where.join(' AND ')}
       ORDER BY (t.status = 'running') DESC, (t.status = 'queued') DESC, t.id DESC LIMIT ?`,
      ...args,
      limit,
    ),
  );
});

route('POST', '/api/tasks', async (req, res) => {
  const b = await readJson(req);
  const target = b.target ?? { type: 'personal' };
  let orgId = null;
  if (target.type === 'org') orgId = id(target.id);
  else if (target.type === 'department') orgId = mustExist('departments', id(target.id), 'Department').org_id;
  else if (target.type === 'team') orgId = one('SELECT d.org_id FROM teams t JOIN departments d ON d.id = t.department_id WHERE t.id = ?', id(target.id))?.org_id ?? null;
  else if (target.type === 'agent') orgId = mustExist('agents', id(target.id), 'Agent').org_id;
  try {
    const missionId = createMission({
      scope: { orgId },
      target,
      title: text(b.title, 200, 'Title'),
      instructions: maybe(b.instructions, 20_000) || b.title,
      dod: maybe(b.dod, 4000) ?? '',
      priority: clampPriority(b.priority),
      projectId: optId(b.project_id),
    });
    send(res, 201, { id: missionId });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});

route('GET', '/api/tasks/:id', (req, res, ctx) => {
  const t = mustExist('tasks', id(ctx.params.id), 'Task');
  send(res, 200, {
    ...t,
    agent: t.agent_id ? one('SELECT id, name, role, tier FROM agents WHERE id = ?', t.agent_id) : null,
    children: all('SELECT t.id, t.title, t.status, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE parent_id = ? ORDER BY t.id', t.id),
    approvals: all('SELECT * FROM approvals WHERE task_id = ?', t.id).map(parseApproval),
    files: all(`SELECT * FROM files WHERE task_id = ? AND rel_path NOT LIKE 'knowledge/%'`, t.id),
  });
});

route('POST', '/api/tasks/:id/cancel', (req, res, ctx) => {
  scheduler.cancel(id(ctx.params.id));
  send(res, 200, { ok: true });
});
route('POST', '/api/tasks/:id/retry', (req, res, ctx) => {
  scheduler.retry(id(ctx.params.id));
  send(res, 200, { ok: true });
});

// ---------- approvals & outbox ----------
route('GET', '/api/approvals', (req, res, ctx) => {
  const status = ctx.query.get('status') || 'pending';
  const orgId = ctx.query.get('org') ? id(ctx.query.get('org')) : null;
  send(
    res,
    200,
    all(
      `SELECT ap.*, t.title AS task_title, a.name AS agent_name, o.name AS org_name, tm.name AS team_name FROM approvals ap
       LEFT JOIN tasks t ON t.id = ap.task_id LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN orgs o ON o.id = ap.org_id
       LEFT JOIN teams tm ON tm.id = ap.team_id WHERE ap.status = ? AND (? IS NULL OR ap.org_id = ?) ORDER BY ap.id DESC LIMIT 200`,
      status,
      orgId,
      orgId,
    ).map(parseApproval),
  );
});

for (const [verb, approve] of [['approve', true], ['reject', false]]) {
  route('POST', `/api/approvals/:id/${verb}`, (req, res, ctx) => {
    try {
      send(res, 200, decideApproval(id(ctx.params.id), approve, 'owner'));
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });
}

// ---------- ask Jarvis ----------
route('POST', '/api/ask', async (req, res) => {
  const b = await readJson(req);
  const r = await chat({ scope: { orgId: optId(b.org_id) }, text: text(b.text, 4000, 'Question'), spoken: Boolean(b.spoken) });
  send(res, 200, { reply: r.reply, ok: r.ok, tasks: [] });
});

route('POST', '/api/ask/reset', async (req, res) => {
  const b = await readJson(req);
  resetConversation({ orgId: optId(b.org_id) });
  send(res, 200, { ok: true });
});

// ---------- the Operator ----------
route('POST', '/api/orgs/:id/operator/run', async (req, res, ctx) => {
  const orgId = mustExist('orgs', id(ctx.params.id), 'Organisation').id;
  const b = await readJson(req);
  runOperator(orgId, { mode: ['morning', 'midday', 'review', 'event'].includes(b.mode) ? b.mode : 'midday', reason: maybe(b.reason, 300) ?? 'requested by the owner' }).catch((err) => log('error', `Operator: ${err.message}`, orgId));
  send(res, 202, { ok: true });
});

route('GET', '/api/activity', (req, res, ctx) => {
  const orgId = optId(ctx.query.get('org'));
  const limit = Math.min(Number(ctx.query.get('limit')) || 60, 300);
  send(res, 200, all('SELECT * FROM activity WHERE (? IS NULL AND org_id IS NULL OR org_id = ?) ORDER BY id DESC LIMIT ?', orgId, orgId, limit));
});

// ---------- the mind: memories and knowledge files ----------
const scopeOf = (q) => ({ orgId: q.get('org') ? id(q.get('org')) : null, projectId: q.get('project') ? id(q.get('project')) : null });

route('GET', '/api/memories', (req, res, ctx) => send(res, 200, listMemories(scopeOf(ctx.query))));
route('POST', '/api/memories', async (req, res) => {
  const b = await readJson(req);
  send(res, 201, { id: addMemory({ orgId: optId(b.org_id), projectId: optId(b.project_id), content: text(b.content, 1000, 'Memory'), pinned: Boolean(b.pinned) }) });
});
route('PUT', '/api/memories/:id', async (req, res, ctx) => {
  const b = await readJson(req);
  update('memories', id(ctx.params.id), { pinned: typeof b.pinned === 'boolean' ? Number(b.pinned) : undefined, content: maybe(b.content, 1000) });
  notify('memories');
  send(res, 200, { ok: true });
});
route('DELETE', '/api/memories/:id', (req, res, ctx) => {
  run('DELETE FROM memories WHERE id = ?', id(ctx.params.id));
  notify('memories');
  send(res, 200, { ok: true });
});

route('GET', '/api/files', (req, res, ctx) => {
  const s = scopeOf(ctx.query);
  send(res, 200, all('SELECT * FROM files WHERE org_id IS ? AND project_id IS ? ORDER BY created_at DESC', s.orgId, s.projectId));
});
route('POST', '/api/files', async (req, res, ctx) => {
  const name = decodeURIComponent(String(req.headers['x-filename'] || ''));
  if (!name) throw new HttpError(400, 'Missing file name');
  const buf = await readBody(req, 50_000_000);
  saveKnowledge(scopeOf(ctx.query), name, buf);
  notify('files');
  send(res, 201, { ok: true });
});
route('GET', '/api/files/:id/download', (req, res, ctx) => {
  const f = resolveFile(id(ctx.params.id));
  if (!f) throw new HttpError(404, 'File not found');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${f.name.replace(/[^\w.\- ()]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(f.abs).pipe(res);
});

// ---------- settings & engines ----------
const UI_KEYS = ['theme', 'core', 'retint', 'voice_wake', 'voice_speak', 'autonomy'];
route('GET', '/api/settings', (req, res) => {
  send(res, 200, {
    theme: getSetting('theme', 'green'),
    core: getSetting('core', 'reactor'),
    retint: getSetting('retint', '1') === '1',
    voice_wake: getSetting('voice_wake', '1') === '1',
    voice_speak: getSetting('voice_speak', '1') === '1',
    autonomy: getSetting('autonomy', '1') === '1',
    approval_level: getSetting('approval_level', 'payments'),
    approval_sentence: approvalSentence(getSetting('approval_level', 'payments')),
    ownerProfile: getSetting('owner_profile', ''),
    apiKeySet: Boolean(getSetting('anthropic_api_key')),
    apiCap: apiCap(),
    apiSpent: apiSpendThisMonth(),
    claude_enabled: getSetting('claude_enabled', '1') === '1',
    codex_enabled: getSetting('codex_enabled', '1') === '1',
  });
});

route('PUT', '/api/settings', async (req, res) => {
  const b = await readJson(req);
  for (const k of UI_KEYS) {
    if (typeof b[k] === 'string') setSetting(k, b[k].slice(0, 40));
    if (typeof b[k] === 'boolean') setSetting(k, b[k] ? '1' : '0');
  }
  if (typeof b.approval_level === 'string' && LEVELS.includes(b.approval_level)) {
    setSetting('approval_level', b.approval_level);
    log('info', approvalSentence(b.approval_level));
  }
  if (typeof b.ownerProfile === 'string') setSetting('owner_profile', b.ownerProfile.slice(0, 20_000));
  if (typeof b.anthropicApiKey === 'string') setSetting('anthropic_api_key', b.anthropicApiKey.trim());
  if (Number.isFinite(Number(b.apiCap)) && b.apiCap !== '' && b.apiCap !== undefined) setSetting('api_monthly_cap', Math.max(0, Number(b.apiCap)));
  for (const p of ['claude', 'codex']) if (typeof b[`${p}_enabled`] === 'boolean') setSetting(`${p}_enabled`, b[`${p}_enabled`] ? '1' : '0');
  notify('settings');
  send(res, 200, { ok: true });
});

let loginCache = { at: 0, value: null };
route('GET', '/api/engines/login', async (req, res) => {
  if (Date.now() - loginCache.at > 60_000) {
    const [claude, codex] = await Promise.all([probe(config.claudeBin, ['auth', 'status']), probe(config.codexBin, ['login', 'status'])]);
    loginCache = { at: Date.now(), value: { claude, codex } };
  }
  send(res, 200, loginCache.value);
});

route('POST', '/api/pause', (req, res) => {
  scheduler.pause();
  send(res, 200, { ok: true });
});
route('POST', '/api/resume', (req, res) => {
  scheduler.resume();
  send(res, 200, { ok: true });
});
route('POST', '/api/engines/:name/clear-cooldown', (req, res, ctx) => {
  if (!['claude', 'codex', 'api'].includes(ctx.params.name)) throw new HttpError(404, 'Unknown engine');
  scheduler.clearCooldown(ctx.params.name);
  send(res, 200, { ok: true });
});

route('GET', '/api/events', (req, res, ctx) => {
  const orgId = ctx.query.get('org') ? id(ctx.query.get('org')) : null;
  send(res, 200, all('SELECT * FROM events WHERE (? IS NULL OR org_id = ?) ORDER BY id DESC LIMIT 200', orgId, orgId));
});

route('GET', '/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const onEvent = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('event', onEvent);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
});

// ---------- offline voice model ----------
// Downloaded once (about 40 MB) the first time voice is switched on, then served locally.
const VOICE_MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
let modelDownload = null;
async function ensureVoiceModel() {
  const dir = `${config.dataDir}/voice`;
  const file = `${dir}/vosk-model-small-en-us-0.15.tar.gz`;
  if (fs.existsSync(file)) return file;
  modelDownload ??= (async () => {
    fs.mkdirSync(dir, { recursive: true });
    log('info', 'Downloading the offline voice model (about 40 MB)…');
    const res = await fetch(VOICE_MODEL_URL);
    if (!res.ok) throw new Error(`Voice model download failed (${res.status})`);
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, file);
    log('info', 'Offline voice model ready');
    return file;
  })().finally(() => {
    modelDownload = null;
  });
  return modelDownload;
}

route(
  'GET',
  '/api/voice/model.tar.gz',
  async (req, res) => {
    const file = await ensureVoiceModel();
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'public, max-age=31536000' });
    fs.createReadStream(file).pipe(res);
  },
  { open: true },
);

// ---------- connectors: HubSpot and Gmail ----------
// Keys and passwords are write-only: they are tested, stored, and never sent back to the app.

route('GET', '/api/connectors', (req, res) => {
  send(res, 200, {
    hubspot: { connected: Boolean(getSetting('hubspot_token')) },
    gmail: {
      connected: Boolean(getSetting('gmail_address') && getSetting('gmail_app_password')),
      address: getSetting('gmail_address', ''),
      senderName: getSetting('gmail_sender_name', ''),
      dailyLimit: dailyLimit(),
      sentToday: sentToday(),
      readReplies: getSetting('gmail_read_replies', '1') === '1',
      queued: one(`SELECT COUNT(*) AS n FROM approvals WHERE delivery = 'queued'`).n,
    },
    whatsapp: {
      connected: whatsappConnected(),
      number: getSetting('whatsapp_number', ''),
      name: getSetting('whatsapp_name', ''),
      phoneId: getSetting('whatsapp_phone_id', ''),
      template: getSetting('whatsapp_template', ''),
      templateLang: getSetting('whatsapp_template_lang', 'en'),
      templateParams: Number(getSetting('whatsapp_template_params', '2')),
      dailyLimit: whatsappDailyLimit(),
      sentToday: whatsappSentToday(),
      appSecretSet: Boolean(getSetting('whatsapp_app_secret')),
      publicUrl: getSetting('public_url', ''),
      verifyToken: verifyToken(),
      webhookPath: '/api/webhooks/whatsapp',
      inbound: one(`SELECT COUNT(*) AS n FROM wa_messages WHERE direction = 'in'`).n,
      lastInbound: one(`SELECT MAX(ts) AS t FROM wa_messages WHERE direction = 'in'`).t,
    },
    signature: getSetting('email_signature', ''),
    footer: getSetting('email_footer', "If you'd rather not hear from me, just reply and let me know."),
  });
});

route('PUT', '/api/connectors/whatsapp', async (req, res) => {
  const b = await readJson(req);
  const phoneId = text(b.phoneId, 40, 'Phone number ID').replace(/\D/g, '');
  const token = text(b.token, 600, 'Access token');
  try {
    const r = await testWhatsapp(phoneId, token);
    setSetting('whatsapp_phone_id', phoneId);
    setSetting('whatsapp_token', token);
    setSetting('whatsapp_number', r.number);
    setSetting('whatsapp_name', r.name);
    if (typeof b.appSecret === 'string' && b.appSecret.trim()) setSetting('whatsapp_app_secret', b.appSecret.trim().slice(0, 200));
    log('info', `WhatsApp connected (${r.number})`);
    notify('settings');
    deliverQueued().catch(() => {});
    send(res, 200, { ok: true, message: r.message });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});

route('PUT', '/api/connectors/whatsapp/options', async (req, res) => {
  const b = await readJson(req);
  if (typeof b.template === 'string') setSetting('whatsapp_template', b.template.trim().slice(0, 120));
  if (typeof b.templateLang === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(b.templateLang.trim())) setSetting('whatsapp_template_lang', b.templateLang.trim());
  const n = Number(b.templateParams);
  if (Number.isInteger(n) && n >= 0 && n <= 3) setSetting('whatsapp_template_params', n);
  const limit = Number(b.dailyLimit);
  if (Number.isFinite(limit) && limit >= 1) setSetting('whatsapp_daily_limit', Math.min(1000, Math.round(limit)));
  if (typeof b.publicUrl === 'string') setSetting('public_url', b.publicUrl.trim().replace(/\/+$/, '').slice(0, 300));
  if (typeof b.appSecret === 'string' && b.appSecret.trim()) setSetting('whatsapp_app_secret', b.appSecret.trim().slice(0, 200));
  notify('settings');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/connectors/whatsapp', (req, res) => {
  run(`DELETE FROM settings WHERE key IN ('whatsapp_phone_id', 'whatsapp_token', 'whatsapp_number', 'whatsapp_name')`);
  log('info', 'WhatsApp disconnected');
  notify('settings');
  send(res, 200, { ok: true });
});

// Meta calls these two without signing in: the GET proves we own the endpoint, the POST delivers messages.
route(
  'GET',
  '/api/webhooks/whatsapp',
  (req, res, ctx) => {
    const q = ctx.query;
    if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === verifyToken()) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(q.get('hub.challenge') ?? '');
      return;
    }
    send(res, 403, { error: 'Verify token mismatch' });
  },
  { open: true },
);
route(
  'POST',
  '/api/webhooks/whatsapp',
  async (req, res) => {
    const raw = await readBody(req, 2_000_000);
    if (!signatureValid(raw, req.headers['x-hub-signature-256'])) return send(res, 401, { error: 'Bad signature' });
    let payload = {};
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, { error: 'Bad JSON' });
    }
    send(res, 200, { ok: true }); // answer Meta at once; processing continues
    receiveWhatsapp(payload).catch((err) => log('warn', `WhatsApp webhook: ${err.message}`));
  },
  { open: true, webhook: true },
);

route('PUT', '/api/connectors/hubspot', async (req, res) => {
  const { token } = await readJson(req);
  const key = text(token, 500, 'HubSpot key');
  try {
    const message = await testHubspot(key);
    setSetting('hubspot_token', key);
    log('info', 'HubSpot connected');
    notify('settings');
    send(res, 200, { ok: true, message });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});

route('DELETE', '/api/connectors/hubspot', (req, res) => {
  run(`DELETE FROM settings WHERE key = 'hubspot_token'`);
  log('info', 'HubSpot disconnected');
  notify('settings');
  send(res, 200, { ok: true });
});

route('PUT', '/api/connectors/gmail', async (req, res) => {
  const b = await readJson(req);
  const address = text(b.address, 200, 'Gmail address').toLowerCase();
  const password = text(b.appPassword, 100, 'App Password');
  try {
    const message = await testGmail(address, password);
    setSetting('gmail_address', address);
    setSetting('gmail_app_password', password);
    if (typeof b.senderName === 'string') setSetting('gmail_sender_name', b.senderName.trim().slice(0, 80));
    log('info', `Gmail connected (${address})`);
    notify('settings');
    deliverQueued().catch(() => {});
    send(res, 200, { ok: true, message });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});

route('PUT', '/api/connectors/gmail/options', async (req, res) => {
  const b = await readJson(req);
  const limit = Number(b.dailyLimit);
  if (Number.isFinite(limit) && limit >= 1) setSetting('gmail_daily_limit', Math.min(500, Math.round(limit)));
  if (typeof b.readReplies === 'boolean') setSetting('gmail_read_replies', b.readReplies ? '1' : '0');
  if (typeof b.senderName === 'string') setSetting('gmail_sender_name', b.senderName.trim().slice(0, 80));
  if (typeof b.signature === 'string') setSetting('email_signature', b.signature.slice(0, 2000));
  if (typeof b.footer === 'string') setSetting('email_footer', b.footer.slice(0, 500));
  notify('settings');
  send(res, 200, { ok: true });
});

route('DELETE', '/api/connectors/gmail', (req, res) => {
  run(`DELETE FROM settings WHERE key IN ('gmail_address', 'gmail_app_password', 'gmail_last_uid')`);
  log('info', 'Gmail disconnected');
  notify('settings');
  send(res, 200, { ok: true });
});

// Re-queue an approved email whose sending failed, or one approved before Gmail was connected.
route('POST', '/api/approvals/:id/send', (req, res, ctx) => {
  const a = mustExist('approvals', id(ctx.params.id), 'Approval');
  if (a.status !== 'approved') throw new HttpError(400, 'Only approved items can be sent');
  if (a.delivery === 'sent') throw new HttpError(400, 'Already sent');
  run(`UPDATE approvals SET delivery = 'queued', delivery_note = 'Queued for sending…' WHERE id = ?`, a.id);
  deliverQueued().catch(() => {});
  notify('approvals');
  send(res, 200, { ok: true });
});

// ---------- Obsidian ----------
const OBSIDIAN_FEATURES = ['reports', 'briefing', 'minds', 'knowledge'];

// Adds the vault to Obsidian's own list so it shows up (and opens) in Obsidian.
function registerVault(dir) {
  const cfgDir = path.join(process.env.APPDATA || '', 'obsidian');
  const cfgFile = path.join(cfgDir, 'obsidian.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch {
    // Obsidian has not been opened yet
  }
  cfg.vaults ??= {};
  if (Object.values(cfg.vaults).some((v) => path.resolve(v.path) === path.resolve(dir))) return;
  for (const v of Object.values(cfg.vaults)) delete v.open;
  cfg.vaults[crypto.randomBytes(8).toString('hex')] = { path: dir, ts: Date.now(), open: true };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
}

route('GET', '/api/connectors/obsidian', (req, res) => {
  send(res, 200, {
    vault: getSetting('obsidian_vault', ''),
    suggested: defaultVault(),
    ...Object.fromEntries(OBSIDIAN_FEATURES.map((f) => [f, getSetting(`obsidian_${f}`, '1') === '1'])),
    lastBriefing: getSetting('obsidian_last_briefing', ''),
  });
});

route('PUT', '/api/connectors/obsidian', async (req, res) => {
  const b = await readJson(req);
  if (typeof b.vault === 'string') {
    const dir = b.vault.trim();
    if (dir) {
      if (!path.isAbsolute(dir)) throw new HttpError(400, 'Use a full folder path, e.g. C:\\Users\\you\\Documents\\Jarvis Vault');
      initVault(dir);
      registerVault(dir);
      setSetting('obsidian_vault', dir);
      log('info', `Obsidian vault connected: ${dir}`);
      syncMinds();
      writeBriefing(true);
    } else {
      run(`DELETE FROM settings WHERE key = 'obsidian_vault'`);
      log('info', 'Obsidian disconnected');
    }
  }
  for (const f of OBSIDIAN_FEATURES) if (typeof b[f] === 'boolean') setSetting(`obsidian_${f}`, b[f] ? '1' : '0');
  notify('settings');
  send(res, 200, { ok: true });
});

route('POST', '/api/connectors/obsidian/sync', (req, res) => {
  if (!getSetting('obsidian_vault')) throw new HttpError(400, 'Connect a vault first');
  const minds = syncMinds();
  writeBriefing(true);
  send(res, 200, { ok: true, message: `Vault updated (${minds} mind note(s) changed, briefing refreshed)` });
});

// Opens the vault in Obsidian on this computer.
route('POST', '/api/connectors/obsidian/open', (req, res) => {
  const vault = getSetting('obsidian_vault');
  if (!vault) throw new HttpError(400, 'Connect a vault first');
  const uri = `obsidian://open?path=${encodeURIComponent(path.join(vault, 'Jarvis.md'))}`;
  spawn('cmd', ['/c', 'start', '""', uri], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  send(res, 200, { ok: true });
});

// ---------- do-not-contact list ----------
route('GET', '/api/do-not-contact', (req, res, ctx) => send(res, 200, listBlocked(optId(ctx.query.get('org')))));
route('POST', '/api/do-not-contact', async (req, res) => {
  const b = await readJson(req);
  try {
    blockContact({ orgId: optId(b.org_id), email: text(b.email, 200, 'Email'), reason: maybe(b.reason, 300) ?? 'Added by the owner' });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  send(res, 201, { ok: true });
});
route('DELETE', '/api/do-not-contact/:id', (req, res, ctx) => {
  unblock(id(ctx.params.id));
  send(res, 200, { ok: true });
});
