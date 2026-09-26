// Jarvis's own tools, exposed to every agent session as an in-process MCP server ("jarvis").
// This replaces the fragile "end your reply with a JSON block" protocol: agents call real tools,
// each of which is validated and applies the owner's policy.
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { one, all, run, insert, now } from '../db.js';
import { notify } from '../events.js';
import { addMemory } from '../mind.js';
import { isBlocked } from '../optout.js';
import { hubspotConnected, addLead as hubspotAddLead } from '../connectors/hubspot.js';
import { whatsappConnected, recentWhatsapp } from '../connectors/whatsapp.js';
import { proposeAction, contactHasReplied } from './proposals.js';
import { KINDS } from './policy.js';
import { scopeDir } from './workspace.js';

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const csvCell = (v) => {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const LEAD_COLUMNS = ['name', 'company', 'website', 'email', 'phone', 'area', 'why_fit', 'source_url', 'status', 'added'];

export function leadsFile(scope) {
  return path.join(scopeDir(scope), 'crm', 'leads.csv');
}

export function readLeads(scope) {
  const file = leadsFile(scope);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q && c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = !q;
      else if (c === ',' && !q) (cells.push(cur), (cur = ''));
      else cur += c;
    }
    cells.push(cur);
    rows.push(Object.fromEntries(LEAD_COLUMNS.map((k, i) => [k, cells[i] ?? ''])));
  }
  return rows;
}

export function appendLead(scope, lead) {
  const file = leadsFile(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${LEAD_COLUMNS.join(',')}\n`);
  const existing = readLeads(scope);
  const dup = existing.find(
    (r) => (lead.email && r.email.toLowerCase() === lead.email.toLowerCase()) || (lead.website && r.website && r.website.replace(/^https?:\/\/(www\.)?/, '').toLowerCase() === lead.website.replace(/^https?:\/\/(www\.)?/, '').toLowerCase()),
  );
  if (dup) return { added: false, total: existing.length };
  const row = { ...lead, status: 'new', added: new Date().toISOString().slice(0, 10) };
  fs.appendFileSync(file, `${LEAD_COLUMNS.map((k) => csvCell(row[k])).join(',')}\n`);
  return { added: true, total: existing.length + 1 };
}

export function recordActivity({ scope, task, agent, kind, text: line }) {
  insert('INSERT INTO activity (ts, org_id, task_id, agent, kind, text) VALUES (?, ?, ?, ?, ?, ?)', now(), scope.orgId ?? null, task?.id ?? null, agent ?? null, kind, String(line).slice(0, 300));
  if (task?.id) run('UPDATE tasks SET live_status = ? WHERE id = ?', String(line).slice(0, 200), task.id);
  notify('activity', { orgId: scope.orgId ?? null, taskId: task?.id ?? null });
}

/**
 * @param {object} ctx
 * @param {{orgId: number|null}} ctx.scope
 * @param {object|null} ctx.task        the mission row this session works on
 * @param {object} ctx.agent            { name, role, tier, department_id, team_id, org_id }
 * @param {object} ctx.hooks            { createMission(spec) -> id }
 */
export function jarvisTools(ctx) {
  const { scope, task, agent } = ctx;
  const orgId = scope.orgId ?? null;
  const canDelegate = ['operator', 'jarvis', 'head', 'leader'].includes(agent.tier);

  const propose = tool(
    'propose_action',
    `The only way anything leaves the company. Propose every outgoing message here (email, proposal, whatsapp, post): Jarvis reviews them when your mission is delivered and then sends them itself through Gmail and WhatsApp. If a connector is not set up yet the message waits in the Outbox and goes out the moment the owner adds the key, so keep proposing. Money (payment, purchase) waits for the owner. There is no owner to-do list: "call" and "other" are refused. WhatsApp first contacts go out as the approved template (name, company, your one-line hook) and your full body is used once they reply. Never ask the owner questions with this; decide yourself.`,
    {
      kind: z.enum(KINDS).describe('email | proposal | whatsapp | post | payment | purchase | contract | deletion'),
      summary: z.string().describe('One line: what and to whom'),
      details: z
        .object({
          to: z.string().optional().describe('Recipient email address you actually found (required for email/proposal)'),
          to_name: z.string().optional(),
          company: z.string().optional(),
          website: z.string().optional(),
          phone: z.string().optional().describe('Phone number in international format (required for whatsapp)'),
          hook: z.string().optional().describe('For whatsapp first contact: one short personalised sentence used as the template variable'),
          subject: z.string().optional(),
          body: z.string().optional().describe('Full message text. The owner signature is added automatically.'),
          amount: z.number().optional().describe('Money involved, if any'),
          channel: z.string().optional().describe('For "other": how to carry it out (contact form URL, WhatsApp number)'),
        })
        .optional(),
    },
    async (args) => {
      const r = proposeAction({ scope, task, kind: args.kind, summary: args.summary, details: args.details ?? {} });
      recordActivity({ scope, task, agent: agent.name, kind: 'action', text: `${args.kind}: ${args.summary}` });
      return text(r.message);
    },
  );

  const addLeadTool = tool(
    'add_lead',
    'Adds a verified lead to the CRM (crm/leads.csv and HubSpot when connected). Nothing is sent, so no approval is needed. Only leads you actually verified on a live page.',
    {
      company: z.string(),
      website: z.string().optional(),
      name: z.string().optional().describe('Decision maker, if public'),
      email: z.string().optional().describe('Public business email, only if you saw it'),
      phone: z.string().optional(),
      area: z.string().optional().describe('City/district'),
      why_fit: z.string().describe('Why they match the ideal customer'),
      source_url: z.string().describe('Where you verified this'),
    },
    async (lead) => {
      if (lead.email && isBlocked(orgId, lead.email)) return text(`Skipped: ${lead.email} is on the do-not-contact list.`);
      const r = appendLead(scope, lead);
      if (r.added) {
        run(`UPDATE kpis SET actual = actual + 1, updated_at = ? WHERE org_id IS ? AND lower(name) LIKE '%lead%' AND scope IN ('department','team') AND scope_id IN (?, ?)`, now(), orgId, agent.department_id ?? -1, agent.team_id ?? -1);
        if (hubspotConnected()) hubspotAddLead({ company: lead.company, website: lead.website, email: lead.email, name: lead.name, phone: lead.phone, notes: lead.why_fit }).catch(() => {});
        recordActivity({ scope, task, agent: agent.name, kind: 'lead', text: `Lead added: ${lead.company}` });
      }
      return text(r.added ? `Added. The CRM now has ${r.total} leads.` : `Already in the CRM (${r.total} leads).`);
    },
  );

  const checkContact = tool(
    'check_contact',
    'Checks whether an email address or phone number may be contacted and whether the person has replied to us before.',
    { email: z.string().describe('Email address or phone number') },
    async ({ email }) => text(JSON.stringify({ allowed: !isBlocked(orgId, email), has_replied: contactHasReplied(orgId, email) })),
  );

  const delegate = tool(
    'delegate',
    canDelegate
      ? 'Hands a sub-mission to a department or team, which runs it as its own session with its own agents. Use for work that another part of the organisation owns; give complete instructions and a measurable definition of done.'
      : 'Not available for your role: do the work yourself or with your subagents.',
    {
      target: z.string().describe('"department:<name>" or "team:<name>"'),
      title: z.string(),
      instructions: z.string().describe('Complete, self-contained instructions'),
      definition_of_done: z.string().describe('What must exist when finished, e.g. "crm/leads.csv has 20 rows with source URLs; 10 drafts proposed"'),
      priority: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      if (!canDelegate) return text('Refused: your role cannot delegate. Do it yourself.');
      try {
        const id = await ctx.hooks.createMission({ scope, target: args.target, title: args.title, instructions: args.instructions, dod: args.definition_of_done, priority: args.priority ?? 60, parent: task, createdBy: agent.name });
        recordActivity({ scope, task, agent: agent.name, kind: 'delegate', text: `Delegated to ${args.target}: ${args.title}` });
        return text(`Mission #${id} created for ${args.target}. It runs on its own; you do not need to wait for it.`);
      } catch (err) {
        return text(`Refused: ${err.message}`);
      }
    },
  );

  const progress = tool('report_progress', 'One line about what you just achieved or are doing now; the owner sees it live. Call it at every milestone.', { text: z.string() }, async ({ text: line }) => {
    recordActivity({ scope, task, agent: agent.name, kind: 'progress', text: line });
    return text('Noted.');
  });

  const kpi = tool(
    'update_kpi',
    'Records a KPI change you actually caused (never estimates). Either add to the value or set it.',
    { name: z.string().describe('Exact KPI name'), add: z.number().optional(), set: z.number().optional() },
    async ({ name, add, set }) => {
      const k = one(`SELECT * FROM kpis WHERE org_id IS ? AND lower(name) = lower(?) ORDER BY CASE scope WHEN 'team' THEN 0 WHEN 'department' THEN 1 ELSE 2 END LIMIT 1`, orgId, name);
      if (!k) return text(`No KPI named "${name}". Known: ${all('SELECT name FROM kpis WHERE org_id IS ?', orgId).map((x) => x.name).join(', ')}`);
      const value = Number.isFinite(set) ? set : k.actual + (Number.isFinite(add) ? add : 0);
      const history = JSON.parse(k.history || '[]').concat([[now(), value]]).slice(-30);
      run('UPDATE kpis SET actual = ?, history = ?, updated_at = ? WHERE id = ?', value, JSON.stringify(history), now(), k.id);
      notify('goals', { orgId });
      return text(`${k.name} is now ${value}${k.unit} (target ${k.target ?? '—'}${k.unit}).`);
    },
  );

  const goal = tool('update_goal', 'Sets the progress (0-100) of a goal you moved.', { title: z.string(), progress: z.number().int().min(0).max(100) }, async ({ title, progress: p }) => {
    const g = one('SELECT * FROM goals WHERE org_id IS ? AND lower(title) = lower(?)', orgId, title);
    if (!g) return text(`No goal titled "${title}".`);
    run('UPDATE goals SET progress = ?, updated_at = ? WHERE id = ?', p, now(), g.id);
    notify('goals', { orgId });
    return text(`Goal "${g.title}" set to ${p}%.`);
  });

  const remember = tool('remember', 'Saves a lasting fact to the organisation memory (never secrets, never temporary states).', { fact: z.string() }, async ({ fact }) => {
    addMemory({ orgId, content: fact, source: 'agent' });
    const file = path.join(scopeDir(scope), 'MEMORY.md');
    fs.appendFileSync(file, `- ${fact.replace(/\r?\n/g, ' ')} _(${new Date().toISOString().slice(0, 10)}, ${agent.name})_\n`);
    return text('Remembered.');
  });

  const replies = tool('read_replies', 'Recent replies (email and WhatsApp) to messages Jarvis sent for this organisation.', { limit: z.number().int().min(1).max(50).optional() }, async ({ limit }) => {
    const rows = all(
      `SELECT r.from_email, r.subject, r.body, r.received_at, s.subject AS our_subject FROM replies r JOIN sent_emails s ON s.id = r.sent_email_id WHERE s.org_id IS ? ORDER BY r.received_at DESC LIMIT ?`,
      orgId,
      limit ?? 10,
    );
    const wa = recentWhatsapp(orgId, limit ?? 10);
    if (!rows.length && !wa.length) return text('No replies yet.');
    const emails = rows.map((r) => `EMAIL FROM ${r.from_email} (${new Date(r.received_at).toISOString().slice(0, 10)}) re "${r.our_subject}":\n${r.body}`);
    const chats = wa.map((m) => `WHATSAPP FROM +${m.phone}${m.name ? ` (${m.name})` : ''} (${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')}):\n${m.body}`);
    return text([...chats, ...emails].join('\n\n---\n\n'));
  });

  // The Operator may grow the organisation when that is what reaching the goal needs.
  const canRestructure = ['operator', 'jarvis'].includes(agent.tier) && orgId;
  const createDepartment = tool(
    'create_department',
    canRestructure ? 'Creates a new department with a head agent, teams, leaders and workers. Use when the goals need work no existing department owns.' : 'Not available for your role.',
    {
      name: z.string(),
      description: z.string().optional(),
      head: z.object({ name: z.string(), role: z.string(), instructions: z.string().optional() }),
      teams: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            leader: z.object({ name: z.string(), role: z.string(), instructions: z.string().optional() }),
            agents: z.array(z.object({ name: z.string(), role: z.string(), instructions: z.string().optional(), web: z.boolean().optional() })).optional(),
          }),
        )
        .optional(),
    },
    async (d) => {
      if (!canRestructure) return text('Refused: only Jarvis can change the structure.');
      if (one('SELECT id FROM departments WHERE org_id = ? AND lower(name) = lower(?)', orgId, d.name)) return text(`A department named "${d.name}" already exists.`);
      const count = one('SELECT COUNT(*) AS n FROM departments WHERE org_id = ?', orgId).n;
      const colors = ['#ff8a3d', '#3fb5ff', '#b36bff', '#ff5a5a', '#ffd23f', '#39e58c', '#ff6fb1', '#29d3f5'];
      const deptId = insert('INSERT INTO departments (org_id, name, description, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', orgId, d.name.slice(0, 60), (d.description ?? '').slice(0, 400), colors[count % colors.length], count, now());
      insert(`INSERT INTO agents (org_id, department_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, 'head', 'auto', 1, ?)`, orgId, deptId, d.head.name.slice(0, 40), d.head.role.slice(0, 80), (d.head.instructions ?? '').slice(0, 1500), now());
      for (const [i, t] of (d.teams ?? []).entries()) {
        const teamId = insert('INSERT INTO teams (department_id, name, description, position, created_at) VALUES (?, ?, ?, ?, ?)', deptId, t.name.slice(0, 60), (t.description ?? '').slice(0, 400), i, now());
        insert(`INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, ?, 'leader', 'auto', 1, ?)`, orgId, deptId, teamId, t.leader.name.slice(0, 40), t.leader.role.slice(0, 80), (t.leader.instructions ?? '').slice(0, 1500), now());
        for (const a of t.agents ?? []) insert(`INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, ?, 'worker', 'auto', ?, ?)`, orgId, deptId, teamId, a.name.slice(0, 40), a.role.slice(0, 80), (a.instructions ?? '').slice(0, 1500), a.web ? 1 : 0, now());
      }
      recordActivity({ scope, task, agent: agent.name, kind: 'structure', text: `Created department ${d.name} with ${(d.teams ?? []).length} team(s)` });
      notify('org', { orgId });
      return text(`Department "${d.name}" created (head ${d.head.name}, ${(d.teams ?? []).length} team(s)). You can delegate to department:${d.name} now.`);
    },
  );

  const createTeam = tool(
    'create_team',
    canRestructure ? 'Adds a team (leader plus workers) to an existing department.' : 'Not available for your role.',
    {
      department: z.string(),
      name: z.string(),
      description: z.string().optional(),
      leader: z.object({ name: z.string(), role: z.string(), instructions: z.string().optional() }),
      agents: z.array(z.object({ name: z.string(), role: z.string(), instructions: z.string().optional(), web: z.boolean().optional() })).optional(),
    },
    async (t) => {
      if (!canRestructure) return text('Refused: only Jarvis can change the structure.');
      const dept = one('SELECT id FROM departments WHERE org_id = ? AND lower(name) = lower(?)', orgId, t.department);
      if (!dept) return text(`No department named "${t.department}".`);
      const n = one('SELECT COUNT(*) AS n FROM teams WHERE department_id = ?', dept.id).n;
      const teamId = insert('INSERT INTO teams (department_id, name, description, position, created_at) VALUES (?, ?, ?, ?, ?)', dept.id, t.name.slice(0, 60), (t.description ?? '').slice(0, 400), n, now());
      insert(`INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, ?, 'leader', 'auto', 1, ?)`, orgId, dept.id, teamId, t.leader.name.slice(0, 40), t.leader.role.slice(0, 80), (t.leader.instructions ?? '').slice(0, 1500), now());
      for (const a of t.agents ?? []) insert(`INSERT INTO agents (org_id, department_id, team_id, name, role, instructions, tier, model, web, created_at) VALUES (?, ?, ?, ?, ?, ?, 'worker', 'auto', ?, ?)`, orgId, dept.id, teamId, a.name.slice(0, 40), a.role.slice(0, 80), (a.instructions ?? '').slice(0, 1500), a.web ? 1 : 0, now());
      recordActivity({ scope, task, agent: agent.name, kind: 'structure', text: `Created team ${t.name} in ${t.department}` });
      notify('org', { orgId });
      return text(`Team "${t.name}" created in ${t.department}. Delegate to team:${t.name}.`);
    },
  );

  const missions = tool('list_missions', 'Open and recent missions in this organisation.', {}, async () => {
    const rows = all(
      `SELECT t.id, t.title, t.status, t.live_status, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.org_id IS ? AND t.kind = 'mission' ORDER BY (t.status IN ('queued','running')) DESC, t.id DESC LIMIT 25`,
      orgId,
    );
    return text(rows.map((r) => `#${r.id} [${r.status}] ${r.title}${r.agent ? ` (${r.agent})` : ''}${r.live_status ? ` — ${r.live_status}` : ''}`).join('\n') || 'None.');
  });

  return createSdkMcpServer({ name: 'jarvis', version: '2.0.0', tools: [propose, addLeadTool, checkContact, delegate, progress, kpi, goal, remember, replies, missions, createDepartment, createTeam] });
}
