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
    'The only way anything leaves the company. Proposes an outgoing action; Jarvis routes it by policy (sends it automatically when the contact already replied, or asks the team leader / owner) and sends approved emails itself. Never ask the owner questions with this; decide yourself.',
    {
      kind: z.enum(KINDS).describe('email | proposal | post | call | payment | purchase | contract | deletion | other'),
      summary: z.string().describe('One line: what and to whom'),
      details: z
        .object({
          to: z.string().optional().describe('Recipient email address you actually found (required for email/proposal)'),
          to_name: z.string().optional(),
          company: z.string().optional(),
          website: z.string().optional(),
          phone: z.string().optional(),
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
    'Checks whether an email address may be contacted and whether the person has replied to us before.',
    { email: z.string() },
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

  const replies = tool('read_replies', 'Recent replies to emails Jarvis sent for this organisation.', { limit: z.number().int().min(1).max(50).optional() }, async ({ limit }) => {
    const rows = all(
      `SELECT r.from_email, r.subject, r.body, r.received_at, s.subject AS our_subject FROM replies r JOIN sent_emails s ON s.id = r.sent_email_id WHERE s.org_id IS ? ORDER BY r.received_at DESC LIMIT ?`,
      orgId,
      limit ?? 10,
    );
    if (!rows.length) return text('No replies yet.');
    return text(rows.map((r) => `FROM ${r.from_email} (${new Date(r.received_at).toISOString().slice(0, 10)}) re "${r.our_subject}":\n${r.body}`).join('\n\n---\n\n'));
  });

  const missions = tool('list_missions', 'Open and recent missions in this organisation.', {}, async () => {
    const rows = all(
      `SELECT t.id, t.title, t.status, t.live_status, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.org_id IS ? AND t.kind = 'mission' ORDER BY (t.status IN ('queued','running')) DESC, t.id DESC LIMIT 25`,
      orgId,
    );
    return text(rows.map((r) => `#${r.id} [${r.status}] ${r.title}${r.agent ? ` (${r.agent})` : ''}${r.live_status ? ` — ${r.live_status}` : ''}`).join('\n') || 'None.');
  });

  return createSdkMcpServer({ name: 'jarvis', version: '2.0.0', tools: [propose, addLeadTool, checkContact, delegate, progress, kpi, goal, remember, replies, missions] });
}
