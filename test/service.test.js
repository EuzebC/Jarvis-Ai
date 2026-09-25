import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JARVIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
const { parseAgentOutput, extractJson, looksLikeLimit, parseResetTime } = await import('../service/protocol.js');
const { one, all, insert, now } = await import('../service/db.js');
const agents = await import('../service/agents.js');
const { normaliseDraft, applyDraft } = await import('../service/structure.js');
const { createTask, decideApproval } = await import('../service/engine.js');
const auth = await import('../service/auth.js');
const { addMemory, mindText, safeFileName } = await import('../service/mind.js');

function makeOrg(name = 'Acme') {
  const orgId = insert('INSERT INTO orgs (name, created_at, updated_at) VALUES (?, ?, ?)', name, now(), now());
  agents.ensureOrgJarvis(orgId);
  applyDraft(orgId, {
    org_goals: [{ period: 'quarter', title: 'Grow revenue' }],
    departments: [
      {
        name: 'Sales',
        head: { name: 'Nova', role: 'Head of Sales' },
        goals: [{ period: 'month', title: 'Send 30 proposals' }],
        kpis: [{ name: 'Proposals sent', target: 30, unit: '' }],
        teams: [
          {
            name: 'Outreach',
            leader: { name: 'Atlas', role: 'Outreach leader' },
            kpis: [{ name: 'Emails sent', target: 100, unit: 'emails' }],
            agents: [
              { name: 'Echo', role: 'Email writer', grade: 'worker' },
              { name: 'Scout', role: 'Lead finder', grade: 'bulk', web: true },
            ],
          },
        ],
      },
    ],
  });
  return orgId;
}

test('agent output: report, delegation with ordering, actions, memories, KPI and goal updates', () => {
  const out = parseAgentOutput(`# Plan\nDone.\n\`\`\`json
{"summary":"Planned","subtasks":[{"assignee":"Scout","title":"Find leads","instructions":"Find 3"},{"assignee":"Echo","title":"Write","instructions":"Draft","after":1}],
 "actions":[{"kind":"proposal","summary":"Send proposal","details":{"to":"a@b.c"}},{"kind":"weird","summary":"x"}],
 "memories":["Client prefers WhatsApp"],"kpi_updates":[{"name":"Emails sent","add":20}],"goal_updates":[{"title":"Send 30 proposals","progress":40}]}
\`\`\``);
  assert.equal(out.report, '# Plan\nDone.');
  assert.equal(out.subtasks[1].after, 1);
  assert.equal(out.subtasks[0].after, null);
  assert.deepEqual(out.actions.map((a) => a.kind), ['proposal', 'other']);
  assert.deepEqual(out.kpiUpdates, [{ name: 'Emails sent', add: 20, set: NaN }]);
  assert.equal(out.goalUpdates[0].progress, 40);
  assert.deepEqual(extractJson('Sure:\n```json\n{"decision":"approve"}\n```'), { decision: 'approve' });
});

test('usage limits and reset times are recognised', () => {
  assert.equal(looksLikeLimit('5-hour limit reached · resets 3am'), true);
  assert.equal(looksLikeLimit('ENOENT'), false);
  const base = new Date(2026, 8, 25, 22, 0).getTime();
  assert.equal(new Date(parseResetTime('resets 3am', base)).getHours(), 3);
  assert.equal(parseResetTime('try again in 30 minutes', base), base + 30 * 60_000);
});

test('an applied structure creates the hierarchy, goals and KPIs', () => {
  const orgId = makeOrg('Structure Co');
  const dept = one('SELECT * FROM departments WHERE org_id = ?', orgId);
  assert.equal(dept.name, 'Sales');
  assert.equal(one(`SELECT name FROM agents WHERE department_id = ? AND tier = 'head'`, dept.id).name, 'Nova');
  const team = one('SELECT * FROM teams WHERE department_id = ?', dept.id);
  const leader = one(`SELECT * FROM agents WHERE team_id = ? AND tier = 'leader'`, team.id);
  assert.equal(leader.name, 'Atlas');
  assert.equal(leader.web, 1, 'leaders can check work on the web');
  assert.equal(team.leader_can_approve, 0, 'leader approval starts off');
  assert.equal(all(`SELECT * FROM agents WHERE team_id = ? AND tier = 'worker'`, team.id).length, 2);
  assert.equal(one(`SELECT model FROM agents WHERE name = 'Scout' AND org_id = ?`, orgId).model, 'bulk');
  assert.equal(all('SELECT * FROM goals WHERE org_id = ?', orgId).length, 2);
  assert.equal(all('SELECT * FROM kpis WHERE org_id = ?', orgId).length, 2);
});

test('a sloppy proposal is cleaned up instead of creating broken records', () => {
  const d = normaliseDraft({ departments: [{ name: '', head: {} }, { name: 'Ops', head: { name: 'Vault' }, teams: [{ name: 'X' }], goals: [{ period: 'decade', title: 'Hmm' }] }], junk: 1 });
  assert.equal(d.departments.length, 1);
  assert.equal(d.departments[0].teams.length, 0, 'a team without a leader is dropped');
  assert.equal(d.departments[0].goals[0].period, 'month');
});

test('work sent to a department or team reaches its head or leader; names are matched tolerantly', () => {
  const orgId = makeOrg('Routing Co');
  const dept = one('SELECT * FROM departments WHERE org_id = ?', orgId);
  const team = one('SELECT * FROM teams WHERE department_id = ?', dept.id);
  assert.equal(agents.agentForTarget({ type: 'department', id: dept.id }).name, 'Nova');
  assert.equal(agents.agentForTarget({ type: 'team', id: team.id }).name, 'Atlas');
  const jarvis = agents.agentForTarget({ type: 'org', id: orgId });
  assert.equal(jarvis.tier, 'jarvis');
  assert.equal(agents.resolveAssignee(jarvis, 'department:Sales').name, 'Nova');
  const nova = one(`SELECT * FROM agents WHERE org_id = ? AND name = 'Nova'`, orgId);
  assert.equal(agents.resolveAssignee(nova, 'team: outreach').name, 'Atlas');
  const atlas = one(`SELECT * FROM agents WHERE org_id = ? AND name = 'Atlas'`, orgId);
  assert.equal(agents.resolveAssignee(atlas, 'Echo (Email writer)').name, 'Echo');
  assert.equal(agents.resolveAssignee(atlas, 'agent: scout').name, 'Scout');
  assert.equal(agents.resolveAssignee(atlas, 'Nova'), null, 'a leader cannot assign work upwards');
});

test('tasks record their dependency, and payments can only be approved by the owner', () => {
  const orgId = makeOrg('Money Co');
  const echo = one(`SELECT * FROM agents WHERE org_id = ? AND name = 'Echo'`, orgId);
  const first = createTask({ agent: echo, title: 'Research' });
  const second = createTask({ agent: echo, title: 'Write', blockedBy: first });
  assert.equal(one('SELECT blocked_by FROM tasks WHERE id = ?', second).blocked_by, first);
  assert.equal(one('SELECT team_id FROM tasks WHERE id = ?', first).team_id, echo.team_id);

  const pay = insert(`INSERT INTO approvals (task_id, org_id, kind, summary, created_at) VALUES (?, ?, 'payment', 'Pay invoice', ?)`, first, orgId, now());
  assert.throws(() => decideApproval(pay, true, 'leader'), /owner/);
  assert.equal(decideApproval(pay, true, 'owner').status, 'approved');
  assert.throws(() => decideApproval(pay, false, 'owner'), /Already/);
});

test('each organisation has its own mind', () => {
  const a = makeOrg('Mind A');
  const b = makeOrg('Mind B');
  addMemory({ orgId: a, content: 'Only A knows this' });
  addMemory({ orgId: a, content: 'Only A knows this' });
  assert.equal(all('SELECT * FROM memories WHERE org_id = ?', a).length, 1);
  assert.match(mindText({ orgId: a }), /Only A knows this/);
  assert.doesNotMatch(mindText({ orgId: b }), /Only A knows this/);
  assert.equal(safeFileName('../../evil.txt'), 'evil.txt');
});

test('passwords and sessions', () => {
  auth.setPassword('correct horse');
  assert.equal(auth.checkPassword('correct horse'), true);
  assert.equal(auth.checkPassword('wrong'), false);
  const token = auth.createSession('test');
  assert.equal(auth.validSession(token), true);
  auth.setPassword('another one');
  assert.equal(auth.validSession(token), false, 'changing the password signs everyone out');
});
