import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JARVIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-obs-'));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vault-'));
const { insert, one, now, setSetting } = await import('../service/db.js');
const obsidian = await import('../service/connectors/obsidian.js');
const { applyDraft } = await import('../service/structure.js');
const { ensureOrgJarvis } = await import('../service/agents.js');
const { workDir, mindText, addMemory } = await import('../service/mind.js');

const read = (rel) => fs.readFileSync(path.join(vault, rel), 'utf8');

const orgId = insert('INSERT INTO orgs (name, description, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'Acme: Digital', 'Web design', 'We build clinic sites.', now(), now());
ensureOrgJarvis(orgId);
applyDraft(orgId, {
  org_goals: [{ period: 'quarter', title: 'Sign 15 clinics' }],
  departments: [{ name: 'Sales', head: { name: 'Nova', role: 'Head of Sales' }, goals: [{ period: 'week', title: 'Send 6 proposals' }], kpis: [{ name: 'Proposals', target: 6 }], teams: [{ name: 'Outreach', leader: { name: 'Atlas', role: 'Lead' }, agents: [{ name: 'Echo', role: 'Writer' }] }] }],
});
addMemory({ orgId, content: 'Clinics prefer WhatsApp', pinned: true });
setSetting('obsidian_vault', vault);
obsidian.initVault(vault);

test('file names are safe for Obsidian', () => {
  assert.equal(obsidian.safeName('Acme: Digital / "Q3" #1?'), 'Acme Digital Q3 1');
  assert.equal(obsidian.safeName(''), 'Untitled');
});

test('each organisation gets a mind note, and unchanged notes are not rewritten', () => {
  assert.ok(obsidian.syncMinds() >= 1);
  const note = read('Organisations/Acme Digital/Acme Digital.md');
  assert.match(note, /We build clinic sites/);
  assert.match(note, /## Sales/);
  assert.match(note, /\*\*Leader\*\* Atlas/);
  assert.match(note, /📌 Clinics prefer WhatsApp/);
  assert.match(note, /\[\[Knowledge\/Acme Digital\]\]/);
  assert.ok(fs.existsSync(path.join(vault, 'Knowledge', 'Acme Digital')), 'a Knowledge folder is prepared for the owner');
  assert.equal(obsidian.syncMinds(), 0);
});

test('finished tasks become report notes filed by department and team', () => {
  const team = one('SELECT * FROM teams LIMIT 1');
  const echo = one(`SELECT * FROM agents WHERE name = 'Echo'`);
  const taskId = insert(
    `INSERT INTO tasks (org_id, department_id, team_id, agent_id, title, status, summary, result, created_at, finished_at) VALUES (?, ?, ?, ?, 'Draft intro: Smile?', 'done', 'Drafted one email', '## Email\nHello', ?, ?)`,
    orgId,
    team.department_id,
    team.id,
    echo.id,
    now(),
    now(),
  );
  obsidian.writeReport(one('SELECT * FROM tasks WHERE id = ?', taskId), echo);
  const dir = path.join(vault, 'Organisations', 'Acme Digital', 'Reports', 'Sales', 'Outreach');
  const [file] = fs.readdirSync(dir);
  assert.match(file, /Draft intro Smile\.md$/);
  const note = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.match(note, /^---\nagent: "Echo"/);
  assert.match(note, /> Drafted one email/);
});

test('the owner’s notes are read by that organisation’s agents (as read-only copies)', () => {
  fs.mkdirSync(path.join(vault, 'Knowledge', 'Acme Digital', 'Sales'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Knowledge', 'Acme Digital', 'Sales', 'Pricing.md'), 'Starter site: 450,000 RWF');
  fs.writeFileSync(path.join(vault, 'Knowledge', 'Acme Digital', 'photo.png'), 'x');
  const copied = obsidian.syncKnowledge({ orgId }, workDir({ orgId }));
  assert.deepEqual(copied, ['knowledge/obsidian/Sales/Pricing.md']);
  assert.match(mindText({ orgId }), /OBSIDIAN NOTES[\s\S]*knowledge\/obsidian\/Sales\/Pricing\.md/);
  fs.rmSync(path.join(vault, 'Knowledge', 'Acme Digital', 'Sales', 'Pricing.md'));
  assert.deepEqual(obsidian.syncKnowledge({ orgId }, workDir({ orgId })), [], 'deleted notes disappear from the copy');
});

test('the daily briefing is written once a day', () => {
  assert.equal(obsidian.writeBriefing(true), true);
  const [file] = fs.readdirSync(path.join(vault, 'Daily'));
  const note = fs.readFileSync(path.join(vault, 'Daily', file), 'utf8');
  assert.match(note, /# Briefing/);
  assert.match(note, /## Waiting for you/);
  assert.match(note, /\[\[Acme Digital\]\]/);
  assert.equal(obsidian.writeBriefing(false), false, 'not written twice on the same day');
});
