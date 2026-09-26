// The CEO's map of the company: what every business needs in order to run and grow, and where this
// organisation stands on each point. Code gathers hard facts (signals) from the workspace and the
// connectors; the Operator judges the rest each cycle and keeps the map current, so it notices by
// itself that "we have no website" or "nobody owns delivery" and creates the mission or department.
import fs from 'node:fs';
import path from 'node:path';
import { one, all, getSetting, setSetting, now } from '../db.js';
import { notify } from '../events.js';
import { scopeDir, readMemory } from './workspace.js';
import { readLeads } from './tools.js';
import { whatsappConnected } from '../connectors/whatsapp.js';

export const STAGES = ['foundation', 'go-to-market', 'operate', 'grow'];
export const STATUSES = ['unknown', 'missing', 'building', 'ready', 'n/a'];

export const BLUEPRINT = [
  { key: 'offer', name: 'Offer and pricing', stage: 'foundation', why: 'Nothing can be sold or delivered without a clear offer with prices.' },
  { key: 'brand', name: 'Brand and identity', stage: 'foundation', why: 'Name, logo, colours and tone: the face of every message.' },
  { key: 'website', name: 'Website', stage: 'foundation', why: 'The place every prospect checks before answering.' },
  { key: 'payments', name: 'Way to get paid', stage: 'foundation', why: 'Invoice template and a payment method (mobile money, bank, PayPal) ready before the first yes.' },
  { key: 'icp', name: 'Ideal customer and market', stage: 'go-to-market', why: 'Who we sell to, where they are, why they buy, what they pay.' },
  { key: 'pipeline', name: 'Lead pipeline', stage: 'go-to-market', why: 'A steady source of verified leads in the CRM.' },
  { key: 'channels', name: 'Outreach channels', stage: 'go-to-market', why: 'Connected email and WhatsApp, with templates and follow-up sequences.' },
  { key: 'sales', name: 'Sales process', stage: 'go-to-market', why: 'Proposal, objection answers, closing steps, terms or contract.' },
  { key: 'delivery', name: 'Delivery capability', stage: 'operate', why: 'Everything needed to deliver each product within the promised time.' },
  { key: 'onboarding', name: 'Client onboarding and support', stage: 'operate', why: 'Intake, kick-off, communication rhythm, support answers.' },
  { key: 'finance', name: 'Finance and reporting', stage: 'operate', why: 'Revenue and cost tracking, weekly scorecard, goals reviewed.' },
  { key: 'team', name: 'Organisation structure', stage: 'operate', why: 'Departments and teams covering sales, delivery, success and finance, each with KPIs.' },
  { key: 'marketing', name: 'Marketing and presence', stage: 'grow', why: 'Social profiles, content, reviews and local listings that bring inbound demand.' },
  { key: 'retention', name: 'Retention and referrals', stage: 'grow', why: 'Follow-up, feedback, case studies, upsells, referrals.' },
];

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  } catch {
    return [];
  }
};

// Hard facts the Operator cannot argue with.
export function signals(orgId) {
  const org = one('SELECT * FROM orgs WHERE id = ?', orgId) ?? {};
  const root = scopeDir({ orgId });
  const memory = readMemory({ orgId });
  const profile = String(org.profile ?? '');
  const day = now() - 86_400_000;
  const leads = readLeads({ orgId });
  const projects = listDir(path.join(root, 'projects')).filter((e) => e.isDirectory()).map((e) => e.name);
  const outputs = listDir(path.join(root, 'outputs')).map((e) => e.name).slice(0, 80);
  const sentEmails = one('SELECT COUNT(*) AS n FROM sent_emails WHERE org_id = ?', orgId).n;
  const sentWa = one(`SELECT COUNT(*) AS n FROM wa_messages WHERE org_id = ? AND direction = 'out'`, orgId).n;
  const replies = one('SELECT COUNT(*) AS n FROM replies r JOIN sent_emails s ON s.id = r.sent_email_id WHERE s.org_id = ?', orgId).n + one(`SELECT COUNT(*) AS n FROM wa_messages WHERE org_id = ? AND direction = 'in'`, orgId).n;
  const urlInMemory = memory.match(/(?:live|deployed|online|published|website)[^\n]{0,80}?(https?:\/\/[^\s)]+)/i)?.[1] ?? null;
  const departments = all('SELECT name FROM departments WHERE org_id = ? ORDER BY position', orgId).map((d) => d.name);
  const revenueKpi = one(`SELECT SUM(actual) AS v FROM kpis WHERE org_id = ? AND (lower(name) LIKE '%revenue%' OR lower(name) LIKE '%income%')`, orgId)?.v ?? 0;
  const clientsKpi = one(`SELECT SUM(actual) AS v FROM kpis WHERE org_id = ? AND (lower(name) LIKE '%client%' OR lower(name) LIKE '%customer%') AND (lower(name) LIKE '%paying%' OR lower(name) LIKE '%won%' OR lower(name) LIKE '%closed%')`, orgId)?.v ?? 0;
  return {
    profileHasPrices: /\d[\d,.]*\s*(?:rwf|frw|usd|eur|\$|€|£)/i.test(profile) || /(?:rwf|usd|\$)\s*\d/i.test(profile),
    paymentInfo: /momo|mobile money|airtel money|paypal|bank account|iban|account number|stripe|flutterwave/i.test(`${memory}\n${profile}`),
    website: { projects: projects.filter((p) => /site|web|landing|www/i.test(p)), liveUrl: urlInMemory },
    projects,
    outputs,
    leads: { total: leads.length, new: leads.filter((l) => l.status === 'new').length, withEmail: leads.filter((l) => l.email).length, withPhone: leads.filter((l) => l.phone).length },
    outreach: { sentEmails, sentWhatsapp: sentWa, replies, sentLast24h: one('SELECT COUNT(*) AS n FROM sent_emails WHERE org_id = ? AND sent_at > ?', orgId, day).n + one(`SELECT COUNT(*) AS n FROM wa_messages WHERE org_id = ? AND direction = 'out' AND ts > ?`, orgId, day).n },
    connectors: { gmail: Boolean(getSetting('gmail_address')), whatsapp: whatsappConnected(), hubspot: Boolean(getSetting('hubspot_token')), obsidian: Boolean(getSetting('obsidian_vault')) },
    waitingForConnector: one(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND status = 'approved' AND delivery = 'needs_connector'`, orgId).n,
    inReview: one(`SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND status = 'review'`, orgId).n,
    structure: { departments, teams: one('SELECT COUNT(*) AS n FROM teams t JOIN departments d ON d.id = t.department_id WHERE d.org_id = ?', orgId).n, agents: one('SELECT COUNT(*) AS n FROM agents WHERE org_id = ?', orgId).n },
    revenue: revenueKpi,
    payingClients: clientsKpi,
    missionsDone7d: one(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND kind = 'mission' AND status = 'done' AND finished_at > ?`, orgId, now() - 7 * 86_400_000).n,
    missionsFailed7d: one(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND kind = 'mission' AND status = 'failed' AND finished_at > ?`, orgId, now() - 7 * 86_400_000).n,
  };
}

export function signalsText(orgId) {
  const s = signals(orgId);
  return [
    `- Offer with prices in the profile: ${s.profileHasPrices ? 'yes' : 'NO'}`,
    `- Payment details known (mobile money, bank, PayPal): ${s.paymentInfo ? 'yes' : 'NO'}`,
    `- Website: ${s.website.liveUrl ? `live at ${s.website.liveUrl}` : s.website.projects.length ? `built in projects/${s.website.projects[0]} but NOT known to be live` : 'NONE'}`,
    `- Projects: ${s.projects.join(', ') || 'none'}`,
    `- Outputs folder: ${s.outputs.length} item(s)${s.outputs.length ? ` (${s.outputs.slice(0, 25).join(', ')}${s.outputs.length > 25 ? ', …' : ''})` : ''}`,
    `- Leads: ${s.leads.total} (${s.leads.new} new, ${s.leads.withEmail} with email, ${s.leads.withPhone} with phone)`,
    `- Outreach: ${s.outreach.sentEmails} emails and ${s.outreach.sentWhatsapp} WhatsApp messages sent in total, ${s.outreach.sentLast24h} in the last 24 h, ${s.outreach.replies} replies; ${s.inReview} messages in review, ${s.waitingForConnector} waiting for a connector`,
    `- Connectors: Gmail ${s.connectors.gmail ? 'on' : 'OFF'}, WhatsApp ${s.connectors.whatsapp ? 'on' : 'OFF'}, HubSpot ${s.connectors.hubspot ? 'on' : 'OFF'}, Obsidian ${s.connectors.obsidian ? 'on' : 'off'}`,
    `- Structure: ${s.structure.departments.length} departments (${s.structure.departments.join(', ') || 'none'}), ${s.structure.teams} teams, ${s.structure.agents} agents`,
    `- Revenue recorded in KPIs: ${s.revenue}; paying clients: ${s.payingClients}; missions last 7 days: ${s.missionsDone7d} delivered, ${s.missionsFailed7d} failed`,
  ].join('\n');
}

const KEY = (orgId) => `company_map:${orgId}`;

// The map as stored (Operator judgements), merged over the blueprint.
export function readMap(orgId) {
  let stored = { updated_at: null, items: [] };
  try {
    stored = JSON.parse(getSetting(KEY(orgId), 'null')) ?? stored;
  } catch {
    // corrupt; start over
  }
  const byKey = Object.fromEntries((stored.items ?? []).map((i) => [i.key, i]));
  const items = BLUEPRINT.map((b) => ({ ...b, status: 'unknown', evidence: '', next: '', department: '', ...byKey[b.key] }));
  for (const i of stored.items ?? []) if (!BLUEPRINT.some((b) => b.key === i.key)) items.push({ stage: 'grow', why: '', ...i });
  return { updated_at: stored.updated_at, items };
}

export function updateMap(orgId, updates) {
  const current = readMap(orgId);
  const byKey = Object.fromEntries(current.items.map((i) => [i.key, i]));
  let changed = 0;
  for (const u of updates ?? []) {
    const key = String(u.key ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
    if (!key) continue;
    const prev = byKey[key] ?? { key, name: String(u.name ?? key).slice(0, 60), stage: STAGES.includes(u.stage) ? u.stage : 'grow', why: String(u.why ?? '').slice(0, 200) };
    const next = {
      ...prev,
      name: u.name ? String(u.name).slice(0, 60) : prev.name,
      status: STATUSES.includes(u.status) ? u.status : prev.status ?? 'unknown',
      evidence: u.evidence !== undefined ? String(u.evidence).slice(0, 300) : prev.evidence ?? '',
      next: u.next !== undefined ? String(u.next).slice(0, 300) : prev.next ?? '',
      department: u.department !== undefined ? String(u.department).slice(0, 60) : prev.department ?? '',
      updated_at: now(),
    };
    byKey[key] = next;
    changed++;
  }
  const items = Object.values(byKey);
  setSetting(KEY(orgId), JSON.stringify({ updated_at: now(), items }));
  writeMapFile(orgId, items);
  notify('company', { orgId });
  return changed;
}

function writeMapFile(orgId, items) {
  try {
    const dir = path.join(scopeDir({ orgId }), 'journal');
    fs.mkdirSync(dir, { recursive: true });
    const lines = ['# Company map', '', `Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. Status: ready / building / missing / n/a.`, ''];
    for (const stage of STAGES) {
      const rows = items.filter((i) => i.stage === stage);
      if (!rows.length) continue;
      lines.push(`## ${stage}`, '');
      for (const i of rows) lines.push(`- **${i.name}** — ${i.status.toUpperCase()}${i.department ? ` (owner: ${i.department})` : ''}${i.evidence ? ` — ${i.evidence}` : ''}${i.next ? ` — next: ${i.next}` : ''}`);
      lines.push('');
    }
    fs.writeFileSync(path.join(dir, 'company-map.md'), lines.join('\n'));
  } catch {
    // the file is a courtesy copy
  }
}

// Compact text for prompts and CLAUDE.md.
export function mapText(orgId) {
  const { items, updated_at } = readMap(orgId);
  const line = (i) => `- [${i.status.toUpperCase()}] ${i.name}${i.department ? ` (owner: ${i.department})` : ''}${i.evidence ? ` — ${i.evidence}` : ''}${i.next ? ` — next: ${i.next}` : ''}`;
  const groups = STAGES.map((s) => {
    const rows = items.filter((i) => i.stage === s);
    return rows.length ? `${s.toUpperCase()}:\n${rows.map(line).join('\n')}` : '';
  }).filter(Boolean);
  return `${updated_at ? `(last updated ${new Date(updated_at).toISOString().slice(0, 10)})` : '(never assessed: assess it now)'}\n${groups.join('\n')}`;
}

// Where the company stands: the earliest stage with a capability that is not ready.
export function stageOf(orgId) {
  const { items } = readMap(orgId);
  for (const s of STAGES) if (items.some((i) => i.stage === s && ['missing', 'building', 'unknown'].includes(i.status))) return s;
  return 'grow';
}
