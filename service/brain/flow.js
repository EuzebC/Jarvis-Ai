// The flow view: how a department (or the whole organisation) is wired. What feeds its brain, how it
// thinks before acting, which teams do the work, how results are verified, reviewed and sent, and
// which connectors carry them out. Built from the live state, so edges light up while data moves.
import { one, all, getSetting, now } from '../db.js';
import { readLeads } from './tools.js';
import { whatsappConnected } from '../connectors/whatsapp.js';
import { currentPlan } from './operator.js';
import { readMap, stageOf } from './company.js';
import { waitingForConnectors } from '../outbox.js';

const RECENT_MS = 3 * 60_000;

function recentActivity(orgId) {
  return all('SELECT agent, kind, text, ts, task_id FROM activity WHERE org_id = ? AND ts > ? ORDER BY id DESC LIMIT 300', orgId, now() - RECENT_MS);
}

const THINKING = [
  'Reads the goals, KPIs, memory, CRM, replies and the company map',
  'Finds the biggest gap between the state and the goal',
  'Writes a mission with a definition of done and delegates it',
  'The leader plans in journal/, splits work across the team, files results with the Jarvis tools',
  'Verification: files exist, no placeholders, counts met, then a verifier session judges the definition of done',
  'Jarvis reviews every proposed message with the mission; delivered → sent, failed → sent back (up to 3 rounds)',
];

function connectorNodes(orgId, sentRecently) {
  const waiting = Object.fromEntries(waitingForConnectors(orgId).map((w) => [w.connector, w.count]));
  return [
    { id: 'c:gmail', type: 'connector', label: 'Gmail', sub: getSetting('gmail_address') ? getSetting('gmail_address') : 'not connected', status: getSetting('gmail_address') ? (sentRecently.gmail ? 'live' : 'idle') : 'missing', detail: { receives: ['Approved emails and proposals from the Outbox'], does: ['Sends from your address (daily limit)', 'Reads replies from people it emailed', 'Replies become missions for the team'], current: waiting.gmail ? `${waiting.gmail} message(s) waiting for this connector` : '' } },
    { id: 'c:whatsapp', type: 'connector', label: 'WhatsApp', sub: whatsappConnected() ? getSetting('whatsapp_number', 'connected') : 'not connected', status: whatsappConnected() ? (sentRecently.whatsapp ? 'live' : 'idle') : 'missing', detail: { receives: ['Approved WhatsApp messages from the Outbox'], does: ['First contact as your approved template', 'Free text once they reply', 'Webhook brings replies back as missions'], current: waiting.whatsapp ? `${waiting.whatsapp} message(s) waiting for this connector` : '' } },
    { id: 'c:hubspot', type: 'connector', label: 'HubSpot CRM', sub: getSetting('hubspot_token') ? 'connected' : 'not connected', status: getSetting('hubspot_token') ? 'idle' : 'missing', detail: { receives: ['Leads, sent messages, replies'], does: ['Contacts, companies, deals; deals move forward on replies'] } },
    { id: 'c:obsidian', type: 'connector', label: 'Obsidian', sub: getSetting('obsidian_vault') ? 'vault linked' : 'not connected', status: getSetting('obsidian_vault') ? 'idle' : 'missing', detail: { receives: ['Reports, briefing, minds'], does: ['Your notes in Knowledge/ are read by the agents'] } },
  ];
}

function inputNodes(orgId, { departmentId = null } = {}) {
  const leads = readLeads({ orgId });
  const replies = one('SELECT COUNT(*) AS n FROM replies r JOIN sent_emails s ON s.id = r.sent_email_id WHERE s.org_id = ? AND r.received_at > ?', orgId, now() - 86_400_000).n + one(`SELECT COUNT(*) AS n FROM wa_messages WHERE org_id = ? AND direction = 'in' AND ts > ?`, orgId, now() - 86_400_000).n;
  const goals = departmentId ? all(`SELECT title, progress, period_label FROM goals WHERE scope = 'department' AND scope_id = ?`, departmentId) : all(`SELECT title, progress, period_label FROM goals WHERE scope = 'org' AND scope_id = ?`, orgId);
  const kpis = departmentId ? all(`SELECT name, actual, target, unit FROM kpis WHERE scope = 'department' AND scope_id = ?`, departmentId) : [];
  const map = readMap(orgId);
  const ready = map.items.filter((i) => i.status === 'ready').length;
  return [
    { id: 'i:goals', type: 'input', label: 'Goals & KPIs', sub: goals.length ? `${goals.length} goal(s)` : 'no goals yet', status: goals.length ? 'idle' : 'missing', detail: { does: goals.map((g) => `${g.period_label}: ${g.title} (${g.progress}%)`).concat(kpis.map((k) => `KPI ${k.name}: ${k.actual}${k.unit} / ${k.target ?? '—'}${k.unit}`)) } },
    { id: 'i:map', type: 'input', label: 'Company map', sub: `${ready}/${map.items.length} ready · stage: ${stageOf(orgId)}`, status: map.updated_at ? 'idle' : 'missing', detail: { does: map.items.map((i) => `${i.status.toUpperCase()} ${i.name}${i.next ? ` → ${i.next}` : ''}`) } },
    { id: 'i:memory', type: 'input', label: 'Memory & profile', sub: 'MEMORY.md, CLAUDE.md', status: 'idle', detail: { does: ['The organisation profile, structure, rules and lasting facts, regenerated before every session'] } },
    { id: 'i:crm', type: 'input', label: 'CRM', sub: `${leads.length} leads`, status: leads.length ? 'idle' : 'missing', detail: { does: [`${leads.filter((l) => l.status === 'new').length} new, ${leads.filter((l) => l.email).length} with email, ${leads.filter((l) => l.phone).length} with phone`] } },
    { id: 'i:replies', type: 'input', label: 'Replies', sub: `${replies} in 24 h`, status: replies ? 'live' : 'idle', detail: { does: ['Email and WhatsApp replies arrive as missions for the team that wrote first'] } },
    { id: 'i:web', type: 'input', label: 'Web & browser', sub: 'search, fetch, headless browser', status: 'idle', detail: { does: ['Public business information, verified on live pages; everything read is treated as untrusted data'] } },
  ];
}

function processNodes(orgId, scopeSql, scopeArgs, recent) {
  const running = all(`SELECT id, title, live_status, round, agent_id FROM tasks WHERE kind = 'mission' AND status = 'running' AND ${scopeSql}`, ...scopeArgs);
  const queued = one(`SELECT COUNT(*) AS n FROM tasks WHERE kind = 'mission' AND status = 'queued' AND ${scopeSql}`, ...scopeArgs).n;
  const verifying = running.filter((t) => t.live_status === 'verifying').length;
  const inReview = one(`SELECT COUNT(*) AS n FROM approvals ap JOIN tasks t ON t.id = ap.task_id WHERE ap.status = 'review' AND t.${scopeSql}`, ...scopeArgs).n;
  const sentDay = one(`SELECT COUNT(*) AS n FROM approvals ap LEFT JOIN tasks t ON t.id = ap.task_id WHERE ap.delivery = 'sent' AND ap.sent_at > ? AND (t.${scopeSql} OR (t.id IS NULL AND ap.org_id = ?))`, now() - 86_400_000, ...scopeArgs, scopeArgs[0]).n;
  const waiting = one(`SELECT COUNT(*) AS n FROM approvals ap LEFT JOIN tasks t ON t.id = ap.task_id WHERE ap.status = 'approved' AND ap.delivery IN ('needs_connector', 'queued') AND (t.${scopeSql} OR (t.id IS NULL AND ap.org_id = ?))`, ...scopeArgs, scopeArgs[0]).n;
  const doneDay = one(`SELECT COUNT(*) AS n FROM tasks WHERE kind = 'mission' AND status = 'done' AND finished_at > ? AND ${scopeSql}`, now() - 86_400_000, ...scopeArgs).n;
  const sentBack = recent.filter((r) => /sent back/i.test(r.text)).length;
  return [
    { id: 'p:missions', type: 'process', label: 'Missions', sub: `${running.length} running · ${queued} queued · ${doneDay} delivered today`, status: running.length ? 'live' : queued ? 'idle' : 'idle', detail: { thinks: THINKING.slice(2, 4), current: running.map((t) => `#${t.id} ${t.title}${t.round > 1 ? ` (round ${t.round})` : ''}${t.live_status ? ` — ${t.live_status}` : ''}`) } },
    { id: 'p:verify', type: 'process', label: 'Verification', sub: verifying ? `${verifying} verifying now` : 'definition of done, up to 3 rounds', status: verifying ? 'live' : 'idle', detail: { thinks: [THINKING[4]], current: sentBack ? [`${sentBack} mission(s) sent back in the last minutes`] : [] } },
    { id: 'p:review', type: 'process', label: "Jarvis's review", sub: `${inReview} message(s) in review`, status: inReview ? 'live' : 'idle', detail: { thinks: [THINKING[5]], does: ['Real recipient, personalised, right language, consistent with prices, no false claims', 'Delivered mission → messages released; failed → dropped'] } },
    { id: 'p:outbox', type: 'process', label: 'Outbox', sub: `${sentDay} sent today · ${waiting} waiting`, status: sentDay && recent.length ? 'live' : waiting ? 'idle' : 'idle', detail: { does: ['Sends through the connectors within the daily limits', 'Messages without a connector wait and go out the moment the key is added'] } },
  ];
}

const liveAgentNames = (recent) => new Set(recent.map((r) => String(r.agent).split(' › ')[0]));

function teamNodes(departmentId, recent) {
  const teams = all('SELECT * FROM teams WHERE department_id = ? ORDER BY position, id', departmentId);
  const activeNames = liveAgentNames(recent);
  return teams.map((t) => {
    const leader = one(`SELECT id, name, role, status FROM agents WHERE team_id = ? AND tier = 'leader'`, t.id);
    const agents = all(`SELECT id, name, role, status, web FROM agents WHERE team_id = ? AND tier = 'worker'`, t.id);
    const mission = one(`SELECT id, title, live_status, round FROM tasks WHERE team_id = ? AND status = 'running' AND kind = 'mission' ORDER BY started_at DESC LIMIT 1`, t.id);
    const queued = one(`SELECT COUNT(*) AS n FROM tasks WHERE team_id = ? AND status = 'queued' AND kind = 'mission'`, t.id).n;
    const kpis = all(`SELECT name, actual, target, unit FROM kpis WHERE scope = 'team' AND scope_id = ?`, t.id);
    const live = Boolean(mission) || (leader && activeNames.has(leader.name));
    const usesWeb = recent.some((r) => String(r.agent).startsWith(leader?.name ?? '§') && /searches the web|fetch|browser|opens|navigat/i.test(r.text));
    const subagentsLive = recent.filter((r) => String(r.agent).startsWith(`${leader?.name} › `)).map((r) => String(r.agent).split(' › ')[1]);
    return {
      id: `t:${t.id}`,
      type: 'team',
      label: t.name,
      sub: mission ? `#${mission.id} ${mission.live_status ?? 'working'}` : queued ? `${queued} queued` : 'idle',
      status: live ? 'live' : 'idle',
      link: `/team/${t.id}`,
      usesWeb,
      detail: {
        receives: ['A mission from the head or from Jarvis, with instructions and a definition of done', 'CLAUDE.md, MEMORY.md, the CRM and the journal'],
        thinks: ['The leader writes journal/mission-<id>.md with the plan', 'Splits independent work across the team in parallel and checks their results', 'Files results with the Jarvis tools; never asks the owner'],
        team: [leader ? `Leader: ${leader.name} — ${leader.role}` : 'No leader', ...agents.map((a) => `${a.name} — ${a.role}${a.web ? ' (web)' : ''}${subagentsLive.includes(a.name) ? ' · active now' : ''}`)],
        kpis: kpis.map((k) => `${k.name}: ${k.actual}${k.unit} / ${k.target ?? '—'}${k.unit}`),
        current: mission ? [`#${mission.id} ${mission.title}${mission.round > 1 ? ` (round ${mission.round})` : ''}`, ...recent.filter((r) => String(r.agent).startsWith(leader?.name ?? '§')).slice(0, 6).map((r) => `${new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${r.agent}: ${r.text}`)] : [],
      },
    };
  });
}

function outputNodes(orgId, scopeSql, scopeArgs) {
  const day = now() - 86_400_000;
  const files = one(`SELECT COUNT(*) AS n FROM files f JOIN tasks t ON t.id = f.task_id WHERE f.created_at > ? AND t.${scopeSql}`, day, ...scopeArgs).n;
  const leadsDay = readLeads({ orgId }).filter((l) => l.added === new Date().toISOString().slice(0, 10)).length;
  const kpiUpdates = one(`SELECT COUNT(*) AS n FROM kpis WHERE org_id = ? AND updated_at > ?`, orgId, day).n;
  return [
    { id: 'o:files', type: 'output', label: 'Deliverables', sub: `${files} file(s) today`, status: files ? 'live' : 'idle', detail: { does: ['Documents, lists, designs, websites and programs saved in the organisation folder (outputs/, projects/)', 'Every mission is a git snapshot: undo from the task page'] } },
    { id: 'o:leads', type: 'output', label: 'CRM leads', sub: `${leadsDay} added today`, status: leadsDay ? 'live' : 'idle', detail: { does: ['crm/leads.csv and HubSpot; de-duplicated by email and website'] } },
    { id: 'o:kpis', type: 'output', label: 'KPIs & goals', sub: `${kpiUpdates} update(s) today`, status: kpiUpdates ? 'live' : 'idle', detail: { does: ['Only numbers the agents actually moved'] } },
  ];
}

export function departmentFlow(departmentId) {
  const d = one('SELECT * FROM departments WHERE id = ?', departmentId);
  if (!d) return null;
  const orgId = d.org_id;
  const recent = recentActivity(orgId);
  const head = one(`SELECT id, name, role, status FROM agents WHERE department_id = ? AND tier = 'head'`, d.id);
  const scopeSql = 'department_id = ?';
  const scopeArgs = [d.id];
  const teams = teamNodes(d.id, recent);
  const process = processNodes(orgId, scopeSql, scopeArgs, recent);
  const sentRecently = { gmail: recent.some((r) => /Sent to .*@/i.test(r.text)), whatsapp: recent.some((r) => /WhatsApp/i.test(r.text) && /sent/i.test(r.text)) };
  const running = teams.some((t) => t.status === 'live');
  const brain = {
    id: 'b:head',
    type: 'brain',
    label: head ? head.name : `${d.name} head`,
    sub: head ? head.role : 'no head',
    status: running || (head && liveAgentNames(recent).has(head.name)) ? 'live' : 'idle',
    detail: {
      receives: ['Missions from Jarvis (the CEO loop) and tasks from you', 'Department goals and KPIs, the company map, memory, CRM and replies'],
      thinks: [THINKING[0], THINKING[1], THINKING[2], 'Delegates to a team (or does it with the department agents) and follows up on failed rounds'],
      does: ['Runs missions as sandboxed Claude Code sessions inside the organisation folder', 'Can build software, browse the web, write documents, add leads, propose messages'],
      current: currentPlan(orgId)?.text ? [currentPlan(orgId).text.slice(0, 600)] : [],
    },
  };
  const nodes = [...inputNodes(orgId, { departmentId: d.id }), brain, ...teams, ...process, ...outputNodes(orgId, scopeSql, scopeArgs), ...connectorNodes(orgId, sentRecently)];
  const edges = [];
  for (const i of nodes.filter((n) => n.type === 'input')) edges.push({ from: i.id, to: brain.id, live: running && i.id !== 'i:web' });
  for (const t of teams) {
    edges.push({ from: brain.id, to: t.id, live: t.status === 'live' });
    edges.push({ from: t.id, to: 'p:missions', live: t.status === 'live' });
    if (t.usesWeb) edges.push({ from: 'i:web', to: t.id, live: true });
  }
  if (!teams.length) edges.push({ from: brain.id, to: 'p:missions', live: running });
  edges.push({ from: 'p:missions', to: 'p:verify', live: process[1].status === 'live' });
  edges.push({ from: 'p:verify', to: 'p:review', live: process[2].status === 'live' });
  edges.push({ from: 'p:review', to: 'p:outbox', live: process[3].status === 'live' });
  edges.push({ from: 'p:missions', to: 'o:files', live: process[0].status === 'live' });
  edges.push({ from: 'p:missions', to: 'o:leads', live: nodes.find((n) => n.id === 'o:leads').status === 'live' });
  edges.push({ from: 'p:missions', to: 'o:kpis', live: false });
  edges.push({ from: 'p:outbox', to: 'c:gmail', live: sentRecently.gmail });
  edges.push({ from: 'p:outbox', to: 'c:whatsapp', live: sentRecently.whatsapp });
  edges.push({ from: 'o:leads', to: 'c:hubspot', live: false });
  edges.push({ from: 'o:files', to: 'c:obsidian', live: false });
  edges.push({ from: 'c:gmail', to: 'i:replies', live: false, back: true });
  edges.push({ from: 'c:whatsapp', to: 'i:replies', live: false, back: true });
  return { title: d.name, color: d.color, orgId, departmentId: d.id, nodes, edges, columns: ['Inputs', 'Brain', 'Teams', 'Process', 'Outputs', 'Connectors'] };
}

export function orgFlow(orgId) {
  const org = one('SELECT * FROM orgs WHERE id = ?', orgId);
  if (!org) return null;
  const recent = recentActivity(orgId);
  const scopeSql = 'org_id = ?';
  const scopeArgs = [orgId];
  const operatorRunning = Boolean(one(`SELECT id FROM tasks WHERE org_id = ? AND kind = 'operator' AND status = 'running'`, orgId));
  const plan = currentPlan(orgId);
  const brain = {
    id: 'b:ceo',
    type: 'brain',
    label: 'Jarvis · CEO loop',
    sub: operatorRunning ? 'thinking now' : plan ? `last run ${new Date(plan.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${plan.mode})` : 'not run yet',
    status: operatorRunning ? 'live' : 'idle',
    detail: {
      receives: ['Goals and KPIs, the company map, hard signals from the workspace and connectors', 'Memory, CRM, replies, the mission board, your Obsidian notes'],
      thinks: ['Foundations first (offer, website, payment, channels), then pipeline and sales, then delivery and success, then growth', 'Compares the map with reality, marks what is missing, building or ready', 'Creates the department or team that is missing, then the missions (2 to 5 per run, with a definition of done)', 'Runs after 7:00, every idle 15 minutes, on every delivered mission and reply, and a strategy review each week'],
      current: plan?.text ? [plan.text.slice(0, 900)] : [],
    },
  };
  const departments = all('SELECT * FROM departments WHERE org_id = ? ORDER BY position, id', orgId).map((d) => {
    const running = one(`SELECT COUNT(*) AS n FROM tasks WHERE department_id = ? AND status = 'running' AND kind = 'mission'`, d.id).n;
    const queued = one(`SELECT COUNT(*) AS n FROM tasks WHERE department_id = ? AND status = 'queued' AND kind = 'mission'`, d.id).n;
    const head = one(`SELECT name, role FROM agents WHERE department_id = ? AND tier = 'head'`, d.id);
    const teams = all('SELECT name FROM teams WHERE department_id = ?', d.id).map((t) => t.name);
    return { id: `d:${d.id}`, type: 'team', label: d.name, sub: running ? `${running} mission(s) running` : queued ? `${queued} queued` : 'idle', status: running ? 'live' : 'idle', color: d.color, link: `/flow/${d.id}`, detail: { team: [head ? `Head: ${head.name} — ${head.role}` : 'No head', ...teams.map((t) => `Team: ${t}`)], does: ['Click to open this department’s own flow'] } };
  });
  const process = processNodes(orgId, scopeSql, scopeArgs, recent);
  const sentRecently = { gmail: recent.some((r) => /Sent to .*@/i.test(r.text)), whatsapp: recent.some((r) => /WhatsApp/i.test(r.text) && /sent/i.test(r.text)) };
  const nodes = [...inputNodes(orgId), brain, ...departments, ...process, ...outputNodes(orgId, scopeSql, scopeArgs), ...connectorNodes(orgId, sentRecently)];
  const edges = [];
  for (const i of nodes.filter((n) => n.type === 'input')) edges.push({ from: i.id, to: brain.id, live: operatorRunning && i.id !== 'i:web' });
  for (const d of departments) {
    edges.push({ from: brain.id, to: d.id, live: d.status === 'live' });
    edges.push({ from: d.id, to: 'p:missions', live: d.status === 'live' });
  }
  edges.push({ from: 'i:web', to: 'p:missions', live: recent.some((r) => /searches the web|fetch|browser/i.test(r.text)) });
  edges.push({ from: 'p:missions', to: 'p:verify', live: process[1].status === 'live' });
  edges.push({ from: 'p:verify', to: 'p:review', live: process[2].status === 'live' });
  edges.push({ from: 'p:review', to: 'p:outbox', live: process[3].status === 'live' });
  edges.push({ from: 'p:missions', to: 'o:files', live: process[0].status === 'live' });
  edges.push({ from: 'p:missions', to: 'o:leads', live: nodes.find((n) => n.id === 'o:leads').status === 'live' });
  edges.push({ from: 'p:missions', to: 'o:kpis', live: false });
  edges.push({ from: 'p:outbox', to: 'c:gmail', live: sentRecently.gmail });
  edges.push({ from: 'p:outbox', to: 'c:whatsapp', live: sentRecently.whatsapp });
  edges.push({ from: 'o:leads', to: 'c:hubspot', live: false });
  edges.push({ from: 'o:files', to: 'c:obsidian', live: false });
  edges.push({ from: 'c:gmail', to: 'i:replies', live: false, back: true });
  edges.push({ from: 'c:whatsapp', to: 'i:replies', live: false, back: true });
  edges.push({ from: 'p:missions', to: brain.id, live: false, back: true, label: 'delivered → wakes the CEO loop' });
  return { title: org.name, color: null, orgId, departmentId: null, nodes, edges, columns: ['Inputs', 'CEO brain', 'Departments', 'Process', 'Outputs', 'Connectors'] };
}
