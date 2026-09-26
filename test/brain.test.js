import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JARVIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-brain-'));
process.env.JARVIS_COMPANIES_DIR = path.join(process.env.JARVIS_DATA_DIR, 'companies'); // never the real D:\JarvisCompanies
const policy = await import('../service/brain/policy.js');
const ws = await import('../service/brain/workspace.js');
const { insert, one, now, setSetting } = await import('../service/db.js');
const wa = await import('../service/connectors/whatsapp.js');
const { migratePendingActions, requeueForConnector } = await import('../service/outbox.js');
const { releaseReviewed } = await import('../service/brain/proposals.js');
const { run: dbRun } = await import('../service/db.js');
const { proposeAction } = await import('../service/brain/proposals.js');
const { appendLead, readLeads } = await import('../service/brain/tools.js');
const { createMission, leaderFor, teamAsSubagents } = await import('../service/brain/missions.js');
const { applyDraft } = await import('../service/structure.js');
const { ensureOrgJarvis } = await import('../service/agents.js');

test('policy: payments always to the owner; the approval level decides the rest; questions declined', () => {
  // Default level "payments": only money waits for the owner.
  assert.equal(policy.routeAction({ kind: 'payment' }).route, 'owner');
  assert.equal(policy.routeAction({ kind: 'purchase' }).route, 'owner');
  assert.equal(policy.routeAction({ kind: 'deletion' }).route, 'auto');
  assert.equal(policy.routeAction({ kind: 'email' }).route, 'auto');
  assert.equal(policy.routeAction({ kind: 'whatsapp' }).route, 'auto');
  assert.equal(policy.routeAction({ kind: 'email', leaderCanApprove: true }).route, 'auto');
  // Level "money": contracts and deletions too.
  assert.equal(policy.routeAction({ kind: 'deletion', level: 'money' }).route, 'owner');
  assert.equal(policy.routeAction({ kind: 'email', level: 'money' }).route, 'auto');
  // Level "first_contact": the first message to a new contact as well.
  assert.equal(policy.routeAction({ kind: 'email', level: 'first_contact' }).route, 'owner');
  assert.equal(policy.routeAction({ kind: 'email', level: 'first_contact', leaderCanApprove: true }).route, 'leader');
  assert.equal(policy.routeAction({ kind: 'email', level: 'first_contact', contactHasReplied: true }).route, 'auto');
  assert.equal(policy.routeAction({ kind: 'email', hasRecipient: false }).route, 'decline');
  assert.match(policy.approvalSentence('payments'), /payments and purchases only/);
  assert.equal(policy.routeAction({ kind: 'other', summary: 'Owner: confirm the do-not-contact list is complete' }).route, 'decline');
  assert.equal(policy.routeAction({ kind: 'other', summary: 'Which approach should we take?' }).route, 'decline');
  assert.equal(policy.routeAction({ kind: 'other', summary: 'Submit the enquiry form on their website with our pitch' }).route, 'decline'); // agents do it themselves
  assert.equal(policy.routeAction({ kind: 'call' }).route, 'decline'); // Jarvis has no phone
  assert.equal(policy.hasPlaceholders('Dear [Client], your [AMOUNT]'), true);
  assert.equal(policy.hasPlaceholders('Dear Dr Uwase, 450,000 RWF'), false);
});

test('sandbox: paths and shell commands are confined to the workspace', () => {
  const root = path.join(os.tmpdir(), 'jarvis-ws', 'org-1');
  assert.equal(ws.insideSandbox(root, path.join(root, 'crm', 'leads.csv')), true);
  assert.equal(ws.insideSandbox(root, path.join(os.tmpdir(), 'jarvis-ws', 'org-2', 'a.txt')), false);
  assert.equal(ws.insideSandbox(root, path.join(root, '..', 'org-2')), false);
  assert.equal(ws.commandAllowed(root, 'python scripts/run.py > outputs/a.txt').ok, true);
  assert.equal(ws.commandAllowed(root, `type "${path.join(root, 'crm', 'leads.csv')}"`).ok, true);
  assert.equal(ws.commandAllowed(root, 'type C:\\Users\\HP\\secret.txt').ok, false);
  assert.equal(ws.commandAllowed(root, 'cat /c/Users/HP/secret.txt').ok, false);
  assert.equal(ws.commandAllowed(root, 'cat ~/.ssh/id_rsa').ok, false);
  assert.equal(ws.commandAllowed(root, 'shutdown /s /t 0').ok, false);
  assert.equal(ws.commandAllowed(root, 'rm -rf /').ok, false);
  assert.equal(ws.commandAllowed(root, 'cat ../../other/file').ok, false);
  // Folders with spaces work when the path is quoted; unquoted outside paths are still caught.
  const spaced = path.join(os.tmpdir(), 'Jarvis Companies', 'Lumora Digital');
  assert.equal(ws.commandAllowed(spaced, `type "${path.join(spaced, 'crm', 'leads.csv')}"`).ok, true);
  assert.equal(ws.commandAllowed(spaced, `Get-Content '${path.join(spaced, 'outputs', 'report.md')}'`).ok, true);
  assert.equal(ws.commandAllowed(spaced, `type "${path.join(os.tmpdir(), 'Jarvis Companies', 'Other Org', 'a.txt')}"`).ok, false);
  assert.equal(ws.commandAllowed(spaced, 'type C:\\Users\\HP\\secret.txt').ok, false);
});

test('organisation folders: suggested on the PC, moved with their files, adopted at start', () => {
  const suggested = ws.suggestOrgFolder('Acme / Digital: Agency');
  assert.ok(path.isAbsolute(suggested));
  assert.equal(path.dirname(suggested), process.env.JARVIS_COMPANIES_DIR);
  assert.equal(path.basename(suggested), 'Acme-Digital-Agency');
  const oid = insert('INSERT INTO orgs (name, created_at, updated_at) VALUES (?, ?, ?)', 'Folder Co', now(), now());
  const before = ws.ensureWorkspace({ orgId: oid });
  fs.writeFileSync(path.join(before, 'outputs', 'hello.md'), '# hi');
  const target = path.join(process.env.JARVIS_DATA_DIR, 'visible', 'Folder-Co');
  assert.equal(ws.moveOrgWorkspace(oid, target), target);
  assert.equal(ws.orgDir(oid), target);
  assert.equal(fs.readFileSync(path.join(target, 'outputs', 'hello.md'), 'utf8'), '# hi');
  assert.throws(() => ws.moveOrgWorkspace(oid, 'relative/path'));
  assert.equal(ws.adoptFolders().some(([name]) => name === 'Folder Co'), false); // already has a folder
});

// A small organisation to route proposals and missions through.
const orgId = insert('INSERT INTO orgs (name, profile, created_at, updated_at) VALUES (?, ?, ?, ?)', 'Brain Co', 'We sell websites.', now(), now());
ensureOrgJarvis(orgId);
applyDraft(orgId, {
  org_goals: [],
  departments: [
    {
      name: 'Sales',
      head: { name: 'Nova', role: 'Head of Sales' },
      goals: [],
      kpis: [{ name: 'Leads added', target: 100, unit: '' }],
      teams: [{ name: 'Outreach', leader: { name: 'Atlas', role: 'Lead' }, kpis: [], agents: [{ name: 'Echo', role: 'Writer', grade: 'worker' }, { name: 'Scout', role: 'Finder', grade: 'bulk', web: true }] }],
    },
  ],
});
const scope = { orgId };
const team = one('SELECT * FROM teams LIMIT 1');
const atlas = one(`SELECT * FROM agents WHERE name = 'Atlas'`);

test('workspace: CLAUDE.md carries the mind, structure, policy and tool guide', () => {
  const dir = ws.writeClaudeMd(scope);
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /# Brain Co/);
  assert.match(md, /We sell websites/);
  assert.match(md, /### Sales/);
  assert.match(md, /Team \*\*Outreach\*\*: leader Atlas/);
  assert.match(md, /propose_action/);
  assert.match(md, /Do-not-contact list/);
  for (const sub of ['knowledge', 'crm', 'projects', 'outputs', 'journal']) assert.ok(fs.existsSync(path.join(dir, sub)));
  assert.ok(fs.existsSync(path.join(dir, 'MEMORY.md')));
});

test('proposals: refuse missing recipients and placeholders, first contact follows the approval level, auto-send after a reply', () => {
  const task = { id: null, team_id: team.id, org_id: orgId };
  assert.match(proposeAction({ scope, task, kind: 'email', summary: 'x', details: {} }).message, /real recipient/);
  assert.match(proposeAction({ scope, task, kind: 'email', summary: 'x', details: { to: 'a@b.rw', body: 'Dear [Client]' } }).message, /placeholders/);
  // Default level: first contacts go out by themselves (they wait in the Outbox until Gmail is connected).
  const auto = proposeAction({ scope, task, kind: 'email', summary: 'Intro to Nova', details: { to: 'ceo@nova.rw', subject: 'Hi', body: 'Real text' } });
  assert.equal(auto.route, 'auto');
  assert.equal(one('SELECT status, decided_by FROM approvals WHERE id = ?', auto.approvalId).decided_by, 'policy');
  // Stricter level: the owner sees the first message.
  setSetting('approval_level', 'first_contact');
  const first = proposeAction({ scope, task, kind: 'email', summary: 'Intro to Smile', details: { to: 'dr@smile.rw', subject: 'Hi', body: 'Real text' } });
  assert.equal(first.route, 'owner');
  assert.equal(one('SELECT status FROM approvals WHERE id = ?', first.approvalId).status, 'pending');
  // WhatsApp needs a phone number and the connector.
  assert.match(proposeAction({ scope, task, kind: 'whatsapp', summary: 'x', details: { body: 'Hello' } }).message, /phone number/);
  assert.equal(proposeAction({ scope, task, kind: 'whatsapp', summary: 'x', details: { phone: '+250 788 123 456', body: 'Hello there, a real message.' } }).route, 'owner'); // first_contact level
  const sent = insert(`INSERT INTO sent_emails (org_id, message_id, to_email, subject, sent_at) VALUES (?, 'm1', 'dr@smile.rw', 'Hi', ?)`, orgId, now());
  insert(`INSERT INTO replies (sent_email_id, from_email, subject, body, received_at, uid) VALUES (?, 'dr@smile.rw', 'Re: Hi', 'Yes please', ?, 'u1')`, sent, now());
  const followUp = proposeAction({ scope, task, kind: 'email', summary: 'Follow-up', details: { to: 'dr@smile.rw', subject: 'Re: Hi', body: 'Great, Thursday?' } });
  assert.equal(followUp.route, 'auto');
  assert.equal(one('SELECT status, decided_by FROM approvals WHERE id = ?', followUp.approvalId).decided_by, 'policy');
  assert.equal(proposeAction({ scope, task, kind: 'other', summary: 'Owner: confirm the plan?', details: {} }).route, 'decline');
  assert.equal(proposeAction({ scope, task, kind: 'payment', summary: 'Renew domain', details: { amount: 12 } }).route, 'owner');
  setSetting('approval_level', 'payments');
});

test('whatsapp: numbers are normalised, webhook payloads are parsed, inbound messages are matched to what we sent', () => {
  assert.equal(wa.normalisePhone('+250 788 123 456'), '250788123456');
  assert.equal(wa.normalisePhone('12'), null);
  const payload = {
    entry: [{ changes: [{ value: { contacts: [{ wa_id: '250788123456', profile: { name: 'Dr Uwase' } }], messages: [{ id: 'wamid.1', from: '250788123456', timestamp: '1760000000', type: 'text', text: { body: 'Oui, intéressé' } }, { id: 'wamid.2', from: '250788123456', timestamp: '1760000001', type: 'image' }] } }] }],
  };
  const msgs = wa.parseInbound(payload);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].name, 'Dr Uwase');
  wa.recordOutbound({ orgId, teamId: team.id, approvalId: null, phone: '250788123456', body: 'Bonjour', waId: 'wamid.out', mode: 'template' });
  const rec = wa.recordInbound(msgs[0]);
  assert.equal(rec.last.body, 'Bonjour');
  assert.equal(rec.row.org_id, orgId);
  assert.equal(wa.recordInbound(msgs[0]), null); // seen once
  assert.equal(wa.hasWrittenToUs(orgId, '250788123456'), true);
  assert.equal(wa.inServiceWindow('250788123456'), false); // the sample timestamp is old
  assert.equal(policy.routeAction({ kind: 'whatsapp', contactHasReplied: true, level: 'first_contact' }).route, 'auto');
});

test('outbox: messages wait for a missing connector and go out when it is connected; no owner to-do list', () => {
  setSetting('approval_level', 'payments');
  const task = { id: null, team_id: team.id, org_id: orgId };
  // A message with a phone number is a WhatsApp message, even when the agent called it "other".
  const r = proposeAction({ scope, task, kind: 'other', summary: 'WhatsApp first contact to Salon Kigali', details: { company: 'Salon Kigali', phone: '+250 78 8000000', body: 'Muraho! Real pitch here, long enough to be a message.' } });
  assert.equal(r.route, 'auto');
  const row = one('SELECT * FROM approvals WHERE id = ?', r.approvalId);
  assert.equal(row.kind, 'whatsapp');
  assert.equal(row.status, 'approved');
  assert.equal(row.delivery, 'needs_connector');
  assert.equal(row.connector, 'whatsapp');
  assert.equal(JSON.parse(row.payload).to, '250788000000');
  // Actions the agent can do itself are refused with guidance, never queued for the owner.
  const unrelated = proposeAction({ scope, task, kind: 'other', summary: 'Submit the enquiry form on their website', details: { channel: 'https://example.rw/contact', body: 'Hello' } });
  assert.equal(unrelated.route, 'decline');
  assert.match(unrelated.message, /yourself/);
  assert.match(proposeAction({ scope, task, kind: 'call', summary: 'Call the clinic', details: {} }).message, /cannot place phone calls/);
  // Legacy rows from the old policy are migrated at start.
  const legacy = insert(`INSERT INTO approvals (org_id, kind, summary, payload, status, created_at) VALUES (?, 'other', 'WhatsApp first contact to X', ?, 'pending', ?)`, orgId, JSON.stringify({ phone: '+250788111222', body: 'Muraho, a real message body for the salon.' }), now());
  const call = insert(`INSERT INTO approvals (org_id, kind, summary, payload, status, created_at) VALUES (?, 'call', 'Call Y', '{}', 'pending', ?)`, orgId, now());
  assert.equal(migratePendingActions(), 2);
  assert.equal(one('SELECT kind, status, delivery FROM approvals WHERE id = ?', legacy).delivery, 'needs_connector');
  assert.equal(one('SELECT status FROM approvals WHERE id = ?', call).status, 'rejected');
  // Connecting WhatsApp releases everything that waited for it.
  setSetting('whatsapp_phone_id', '123');
  setSetting('whatsapp_token', 'test');
  assert.equal(requeueForConnector('whatsapp'), 2);
  dbRun(`DELETE FROM settings WHERE key IN ('whatsapp_phone_id', 'whatsapp_token')`); // before the queued delivery runs, so nothing is sent
  assert.equal(one('SELECT delivery FROM approvals WHERE id = ?', r.approvalId).delivery, 'queued');
});

test('review: messages proposed inside a mission wait for Jarvis and are released when the mission is delivered', () => {
  setSetting('approval_level', 'payments');
  const missionId = insert(`INSERT INTO tasks (org_id, team_id, title, instructions, status, kind, created_by, created_at) VALUES (?, ?, 'Outreach batch', 'x', 'running', 'mission', 'test', ?)`, orgId, team.id, now());
  const mission = one('SELECT * FROM tasks WHERE id = ?', missionId);
  const first = proposeAction({ scope, task: mission, kind: 'email', summary: 'Intro to Kigali Dental', details: { to: 'hello@kigalidental.rw', subject: 'Website', body: 'Dear Dr Mugisha, a real personalised message body here.' } });
  assert.equal(first.route, 'review');
  assert.equal(one('SELECT status FROM approvals WHERE id = ?', first.approvalId).status, 'review');
  // Proposing the same recipient again (after feedback) updates the draft instead of duplicating it.
  const again = proposeAction({ scope, task: mission, kind: 'email', summary: 'Intro to Kigali Dental (v2)', details: { to: 'hello@kigalidental.rw', subject: 'Website', body: 'Dear Dr Mugisha, an improved personalised message body here.' } });
  assert.equal(again.approvalId, first.approvalId);
  assert.match(JSON.parse(one('SELECT payload FROM approvals WHERE id = ?', first.approvalId).payload).body, /improved/);
  const second = proposeAction({ scope, task: mission, kind: 'whatsapp', summary: 'WhatsApp to Salon Z', details: { phone: '+250788333444', body: 'Muraho! A real WhatsApp message body for Salon Z.' } });
  assert.equal(one(`SELECT COUNT(*) AS n FROM approvals WHERE task_id = ? AND status = 'review'`, missionId).n, 2);
  // Delivered and verified: Jarvis releases both; each waits for its connector.
  assert.equal(releaseReviewed(missionId, { passed: true }), 2);
  assert.equal(one('SELECT status, decided_by, delivery, connector FROM approvals WHERE id = ?', first.approvalId).connector, 'gmail');
  assert.equal(one('SELECT delivery FROM approvals WHERE id = ?', first.approvalId).delivery, 'needs_connector');
  assert.equal(one('SELECT decided_by FROM approvals WHERE id = ?', second.approvalId).decided_by, 'jarvis');
  // A mission that fails for good drops its drafts.
  const failing = insert(`INSERT INTO tasks (org_id, team_id, title, instructions, status, kind, created_by, created_at) VALUES (?, ?, 'Bad batch', 'x', 'running', 'mission', 'test', ?)`, orgId, team.id, now());
  const dropped = proposeAction({ scope, task: one('SELECT * FROM tasks WHERE id = ?', failing), kind: 'email', summary: 'Intro', details: { to: 'x@y.rw', subject: 'Hi', body: 'A real message body that is long enough to pass.' } });
  releaseReviewed(failing, { passed: false, feedback: 'not personalised' });
  assert.equal(one('SELECT status FROM approvals WHERE id = ?', dropped.approvalId).status, 'rejected');
});

test('CRM file: leads are appended once, de-duplicated by email or website', () => {
  ws.ensureWorkspace(scope);
  assert.equal(appendLead(scope, { company: 'Smile Dental', website: 'https://www.smile.rw', email: 'info@smile.rw', why_fit: 'no booking', source_url: 'https://smile.rw' }).added, true);
  assert.equal(appendLead(scope, { company: 'Smile Dental Clinic', website: 'smile.rw', why_fit: 'dup', source_url: 'x' }).added, false);
  assert.equal(appendLead(scope, { company: 'Other, Ltd "K"', email: 'hello@other.rw', why_fit: 'has "quotes", commas', source_url: 'x' }).added, true);
  const rows = readLeads(scope);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].company, 'Other, Ltd "K"');
  assert.equal(rows[1].status, 'new');
});

test('missions: targets resolve to their leader, teams become subagents, missions are recorded with a definition of done', () => {
  assert.equal(leaderFor(scope, { type: 'team', id: team.id }).name, 'Atlas');
  assert.equal(leaderFor(scope, { type: 'department', id: team.department_id }).name, 'Nova');
  const subs = teamAsSubagents(atlas);
  assert.deepEqual(Object.keys(subs).sort(), ['echo', 'scout']);
  assert.equal(subs.scout.model, 'haiku');
  assert.ok(subs.scout.tools.includes('WebSearch'));
  assert.ok(!subs.echo.tools.includes('WebSearch'));
  const nova = one(`SELECT * FROM agents WHERE name = 'Nova'`);
  assert.deepEqual(Object.keys(teamAsSubagents(nova)).sort(), ['atlas', 'echo', 'scout'], 'a head gets the whole department');
  const id = createMission({ scope, target: 'team:outreach', title: 'Find 5 leads', instructions: 'Go', dod: 'crm/leads.csv has 5 rows', createdBy: 'test' });
  const m = one('SELECT * FROM tasks WHERE id = ?', id);
  assert.equal(m.agent_id, atlas.id);
  assert.equal(m.kind, 'mission');
  assert.equal(m.dod, 'crm/leads.csv has 5 rows');
  assert.equal(JSON.parse(m.target).type, 'team');
  assert.throws(() => createMission({ scope, target: 'team:nowhere', title: 'x' }), /No team named/);
});
