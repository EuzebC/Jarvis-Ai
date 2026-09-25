import { one, all } from './db.js';
import { log } from './events.js';
import { extractJson } from './protocol.js';
import { engine, createTask } from './engine.js';
import { workDir, mindText } from './mind.js';
import { ensureOrgJarvis, resolveAssignee, delegates } from './agents.js';

// A compact picture of the workspace so Jarvis can answer "how are we doing?" from real data.
function situation(orgId) {
  if (!orgId) {
    const projects = all(
      `SELECT p.name, SUM(t.status = 'done') AS done, COUNT(t.id) AS total FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.org_id IS NULL AND p.status = 'active' GROUP BY p.id`,
    );
    return `PERSONAL PROJECTS:\n${projects.map((p) => `- ${p.name}: ${p.done ?? 0}/${p.total} tasks done`).join('\n') || '(none yet)'}`;
  }
  const lines = [];
  for (const d of all('SELECT * FROM departments WHERE org_id = ? ORDER BY position', orgId)) {
    lines.push(`DEPARTMENT ${d.name}:`);
    for (const g of all(`SELECT * FROM goals WHERE scope = 'department' AND scope_id = ?`, d.id)) lines.push(`  goal [${g.period_label}] ${g.title}: ${g.progress}%`);
    for (const k of all(`SELECT * FROM kpis WHERE scope = 'department' AND scope_id = ?`, d.id)) lines.push(`  kpi ${k.name}: ${k.actual}${k.unit} / ${k.target ?? '-'}${k.unit}`);
    for (const t of all('SELECT * FROM teams WHERE department_id = ?', d.id)) {
      const open = one(`SELECT COUNT(*) AS n FROM tasks WHERE team_id = ? AND status IN ('queued','running')`, t.id).n;
      lines.push(`  team ${t.name}: ${open} open tasks`);
    }
  }
  const pending = all(`SELECT kind, summary FROM approvals WHERE org_id = ? AND status = 'pending' LIMIT 10`, orgId);
  if (pending.length) lines.push(`WAITING FOR THE OWNER:\n${pending.map((a) => `- ${a.kind}: ${a.summary}`).join('\n')}`);
  const recent = all(`SELECT title, summary FROM tasks WHERE org_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 8`, orgId);
  if (recent.length) lines.push(`RECENTLY DONE:\n${recent.map((t) => `- ${t.title}: ${t.summary ?? ''}`).join('\n')}`);
  return lines.join('\n') || '(no departments yet)';
}

export async function askJarvis({ text, orgId = null }) {
  const jarvis = orgId
    ? one('SELECT * FROM agents WHERE id = ?', ensureOrgJarvis(orgId))
    : one(`SELECT * FROM agents WHERE org_id IS NULL AND tier = 'jarvis'`);
  const team = delegates(jarvis).map((a) => {
    const dept = a.department_id && orgId ? one('SELECT name FROM departments WHERE id = ?', a.department_id)?.name : null;
    return dept ? `department:${dept}` : a.name;
  });
  const system = `You are Jarvis, the owner's AI chief of staff, speaking to the owner directly (your reply may be read aloud).
Answer in 1 to 4 short, natural sentences, like a capable assistant. Use the real data below; never invent numbers.
If the owner asks for work to be done, delegate it as tasks. Anything that leaves the company still needs approval.

${mindText({ orgId })}

CURRENT SITUATION:
${situation(orgId)}

Reply with only one json block: {"reply": "what you say to the owner", "tasks": [{"assignee": "${team[0] ?? 'Jarvis'}", "title": "", "instructions": "", "priority": 50}]}
Assignees you can use: ${[...team, 'Jarvis (yourself)'].join(', ')}. Use an empty tasks list when no work is needed.`;

  const res = await engine.ask({ ...jarvis, model: 'worker', web: 0 }, { prompt: text, system, cwd: workDir({ orgId }) });
  if (!res.ok) return { reply: res.error || 'I could not reach my engines just now.', tasks: [] };
  const data = extractJson(res.text) ?? { reply: res.text.trim(), tasks: [] };
  const created = [];
  for (const t of Array.isArray(data.tasks) ? data.tasks : []) {
    if (!t?.title) continue;
    const target = /^jarvis/i.test(String(t.assignee)) ? jarvis : resolveAssignee(jarvis, t.assignee) ?? jarvis;
    created.push(createTask({ agent: target, title: String(t.title), instructions: String(t.instructions ?? t.title), priority: t.priority, createdBy: 'Jarvis (voice)' }));
  }
  log('info', `Ask Jarvis: "${text.slice(0, 80)}"${created.length ? ` → ${created.length} task(s)` : ''}`, orgId);
  return { reply: String(data.reply ?? '').trim() || 'Done.', tasks: created };
}
