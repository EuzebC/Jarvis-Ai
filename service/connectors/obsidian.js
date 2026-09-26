// Obsidian connector. A vault is just a folder of Markdown files, so Jarvis writes notes into it
// and reads the owner's notes back as knowledge. No plugin or account is needed.
//
// Vault layout
//   Daily/2026-09-25.md                          morning briefing
//   Organisations/<Org>/<Org>.md                 the organisation's mind (profile, structure, goals, KPIs, memories)
//   Organisations/<Org>/Reports/<Dept>/<Team>/   one note per finished task
//   Personal/<Project>/<Project>.md              a personal project's mind
//   Personal/<Project>/Reports/                  its task reports
//   Knowledge/<Org or Project>/                  YOUR notes: agents of that workspace read them
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { one, all, getSetting, setSetting, now } from '../db.js';
import { log } from '../events.js';

export const defaultVault = () => path.join(os.homedir(), 'OneDrive', 'Documents', 'Jarvis Vault');
export const vaultPath = () => getSetting('obsidian_vault', '');
export const obsidianOn = () => Boolean(vaultPath());
const feature = (name) => getSetting(`obsidian_${name}`, '1') === '1';

// Obsidian-safe file names (no \ / : * ? " < > | # ^ [ ]).
export const safeName = (s) =>
  String(s ?? '')
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Untitled';

const day = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Writes a file only when its content changed, so Obsidian and OneDrive aren't disturbed needlessly.
function write(rel, content) {
  const file = path.join(vaultPath(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

const yamlStr = (s) => JSON.stringify(String(s ?? ''));
const frontmatter = (obj) =>
  `---\n${Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(yamlStr).join(', ')}]` : typeof v === 'number' ? v : yamlStr(v)}`)
    .join('\n')}\n---\n\n`;

export function initVault(dir) {
  fs.mkdirSync(path.join(dir, 'Knowledge'), { recursive: true });
  const readme = path.join(dir, 'Jarvis.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# Jarvis\n\nThis vault is kept up to date by Jarvis.\n\n- **Daily/**: a briefing every morning.\n- **Organisations/** and **Personal/**: each workspace's mind, plus a report for every finished task.\n- **Knowledge/**: write your own notes here, in a folder named after an organisation or personal project (for example \`Knowledge/Acme Digital/Pricing.md\`). That workspace's agents read them.\n\nJarvis only writes inside Daily, Organisations and Personal. It never changes your notes in Knowledge.\n`,
    );
  }
}

// ---------- reports ----------
export function writeReport(task, agent) {
  if (!obsidianOn() || !feature('reports') || !task.result) return;
  try {
    let folder;
    const tags = ['jarvis/report'];
    if (task.org_id) {
      const org = one('SELECT name FROM orgs WHERE id = ?', task.org_id);
      const dept = task.department_id ? one('SELECT name FROM departments WHERE id = ?', task.department_id)?.name : null;
      const team = task.team_id ? one('SELECT name FROM teams WHERE id = ?', task.team_id)?.name : null;
      folder = path.join('Organisations', safeName(org.name), 'Reports', ...[dept, team].filter(Boolean).map(safeName));
      tags.push(`org/${safeName(org.name).replace(/\s+/g, '-')}`);
    } else {
      const project = task.project_id ? one('SELECT name FROM projects WHERE id = ?', task.project_id)?.name : null;
      folder = project ? path.join('Personal', safeName(project), 'Reports') : path.join('Personal', 'Reports');
    }
    const files = all(`SELECT rel_path FROM files WHERE task_id = ? AND rel_path NOT LIKE 'knowledge/%'`, task.id).map((f) => f.rel_path);
    const approvals = all('SELECT kind, summary, status FROM approvals WHERE task_id = ?', task.id);
    const body = [
      frontmatter({ agent: agent.name, role: agent.role, status: task.status, date: day(task.finished_at ?? now()), jarvis_task: task.id, tags }),
      `# ${task.title}\n`,
      `> ${task.summary ?? ''}\n`,
      task.result,
      files.length ? `\n## Files\n${files.map((f) => `- \`${f}\` (download in Jarvis → Mind)`).join('\n')}` : '',
      approvals.length ? `\n## Proposed actions\n${approvals.map((a) => `- **${a.kind}** (${a.status}): ${a.summary}`).join('\n')}` : '',
    ].join('\n');
    write(path.join(folder, `${day(task.finished_at ?? now())} ${safeName(task.title)}.md`), body);
  } catch (err) {
    log('warn', `Obsidian report not written: ${err.message}`, task.org_id);
  }
}

// ---------- minds ----------
const bar = (p) => `${'█'.repeat(Math.round(p / 10))}${'░'.repeat(10 - Math.round(p / 10))} ${p}%`;
const kpiLine = (k) => `| ${k.name} | ${k.actual}${k.unit ? ` ${k.unit}` : ''} | ${k.target ?? '—'}${k.unit ? ` ${k.unit}` : ''} |`;

function orgMind(org) {
  const lines = [frontmatter({ type: 'organisation', tags: ['jarvis/mind'] }), `# ${org.name}\n`];
  if (org.description) lines.push(`*${org.description}*\n`);
  lines.push('## Profile and standing instructions\n', org.profile?.trim() || '_Not written yet. Edit it in Jarvis → Mind._', '');
  const goals = all(`SELECT * FROM goals WHERE scope = 'org' AND scope_id = ? ORDER BY period`, org.id);
  if (goals.length) lines.push('## Company goals\n', ...goals.map((g) => `- **${g.period_label}** ${g.title}  \n  \`${bar(g.progress)}\``), '');
  for (const d of all('SELECT * FROM departments WHERE org_id = ? ORDER BY position', org.id)) {
    const head = one(`SELECT name, role FROM agents WHERE department_id = ? AND tier = 'head'`, d.id);
    lines.push(`## ${d.name}`, head ? `Head: **${head.name}** (${head.role})` : '', '');
    for (const g of all(`SELECT * FROM goals WHERE scope = 'department' AND scope_id = ? ORDER BY CASE period WHEN 'quarter' THEN 0 WHEN 'month' THEN 1 ELSE 2 END`, d.id)) {
      lines.push(`- **${g.period_label}** ${g.title}  \n  \`${bar(g.progress)}\``);
    }
    const kpis = all(`SELECT * FROM kpis WHERE scope = 'department' AND scope_id = ?`, d.id);
    if (kpis.length) lines.push('', '| KPI | Actual | Target |', '|---|---|---|', ...kpis.map(kpiLine));
    for (const t of all('SELECT * FROM teams WHERE department_id = ? ORDER BY position', d.id)) {
      const members = all(`SELECT name, role, tier FROM agents WHERE team_id = ? ORDER BY tier = 'leader' DESC`, t.id);
      lines.push('', `### ${t.name} team`, ...members.map((m) => `- ${m.tier === 'leader' ? '**Leader** ' : ''}${m.name}: ${m.role}`));
      const tk = all(`SELECT * FROM kpis WHERE scope = 'team' AND scope_id = ?`, t.id);
      if (tk.length) lines.push('', '| KPI | Actual | Target |', '|---|---|---|', ...tk.map(kpiLine));
    }
    lines.push('');
  }
  const mems = all('SELECT content, pinned, source FROM memories WHERE org_id = ? ORDER BY pinned DESC, id DESC LIMIT 100', org.id);
  if (mems.length) lines.push('## Memories\n', ...mems.map((m) => `- ${m.pinned ? '📌 ' : ''}${m.content}${m.source === 'agent' ? ' _(learned)_' : ''}`), '');
  lines.push(`\nYour notes for this organisation: [[Knowledge/${safeName(org.name)}]]`);
  return lines.join('\n');
}

function projectMind(p) {
  const tasks = all('SELECT title, status FROM tasks WHERE project_id = ? AND depth = 0 ORDER BY id DESC LIMIT 50', p.id);
  const mems = all('SELECT content FROM memories WHERE project_id = ? ORDER BY pinned DESC, id DESC LIMIT 50', p.id);
  return [
    frontmatter({ type: 'personal-project', status: p.status, tags: ['jarvis/mind'] }),
    `# ${p.name}\n`,
    p.description || '',
    '\n## Tasks\n',
    ...tasks.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`),
    mems.length ? `\n## Memories\n${mems.map((m) => `- ${m.content}`).join('\n')}` : '',
    `\nYour notes for this project: [[Knowledge/${safeName(p.name)}]]`,
  ].join('\n');
}

export function syncMinds() {
  if (!obsidianOn() || !feature('minds')) return 0;
  let changed = 0;
  for (const org of all('SELECT * FROM orgs WHERE archived = 0')) {
    if (write(path.join('Organisations', safeName(org.name), `${safeName(org.name)}.md`), orgMind(org))) changed++;
    fs.mkdirSync(path.join(vaultPath(), 'Knowledge', safeName(org.name)), { recursive: true });
  }
  for (const p of all(`SELECT * FROM projects WHERE org_id IS NULL AND status != 'archived'`)) {
    if (write(path.join('Personal', safeName(p.name), `${safeName(p.name)}.md`), projectMind(p))) changed++;
    fs.mkdirSync(path.join(vaultPath(), 'Knowledge', safeName(p.name)), { recursive: true });
  }
  return changed;
}

// ---------- daily briefing ----------
export function writeBriefing(force = false) {
  if (!obsidianOn() || !feature('briefing')) return false;
  const today = day();
  if (!force && (getSetting('obsidian_last_briefing') === today || new Date().getHours() < 7)) return false;
  const since = now() - 86_400_000;
  const lines = [frontmatter({ type: 'briefing', date: today, tags: ['jarvis/briefing'] }), `# Briefing · ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\n`];

  const pending = all(`SELECT a.kind, a.summary, o.name AS org FROM approvals a LEFT JOIN orgs o ON o.id = a.org_id WHERE a.status = 'pending' ORDER BY a.id`);
  lines.push(`## Waiting for you (${pending.length})\n`, ...(pending.length ? pending.map((a) => `- [ ] **${a.kind}**${a.org ? ` · ${a.org}` : ''}: ${a.summary}`) : ['Nothing is waiting for you.']), '');

  const sent = one('SELECT COUNT(*) AS n FROM sent_emails WHERE sent_at > ?', since).n;
  const replies = one('SELECT COUNT(*) AS n FROM replies WHERE received_at > ?', since).n;
  if (sent || replies) lines.push(`## Outreach\n\n- Emails sent: **${sent}**\n- Replies received: **${replies}**\n`);

  for (const org of all('SELECT * FROM orgs WHERE archived = 0')) {
    const done = all(`SELECT t.title, t.summary, a.name AS agent FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.org_id = ? AND t.status = 'done' AND t.finished_at > ? AND t.created_by NOT LIKE 'review:%' ORDER BY t.finished_at`, org.id, since);
    const failed = one(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND status = 'failed' AND finished_at > ?`, org.id, since).n;
    lines.push(`## [[${safeName(org.name)}]]\n`);
    lines.push(done.length ? `**Done in the last 24 hours (${done.length})**\n${done.map((t) => `- ${t.agent}: ${t.summary || t.title}`).join('\n')}` : '_No finished work in the last 24 hours._');
    if (failed) lines.push(`\n⚠️ ${failed} task(s) failed. See Jarvis → Tasks.`);
    const goals = all(`SELECT g.*, d.name AS dept FROM goals g JOIN departments d ON d.id = g.scope_id WHERE g.scope = 'department' AND d.org_id = ? AND g.period IN ('week', 'month') ORDER BY d.position, g.period`, org.id);
    if (goals.length) lines.push('\n**Goals**', ...goals.map((g) => `- ${g.dept} · ${g.period_label}: ${g.title} \`${bar(g.progress)}\``));
    lines.push('');
  }
  const personal = all(`SELECT t.title, t.summary FROM tasks t WHERE t.org_id IS NULL AND t.status = 'done' AND t.finished_at > ? AND t.depth = 0`, since);
  if (personal.length) lines.push('## Personal\n', ...personal.map((t) => `- ${t.summary || t.title}`), '');

  write(path.join('Daily', `${today}.md`), lines.join('\n'));
  setSetting('obsidian_last_briefing', today);
  log('info', `Obsidian: daily briefing written (Daily/${today}.md)`);
  return true;
}

// ---------- your notes as knowledge ----------
// Copies Knowledge/<workspace>/ notes (read-only copies) into that workspace's folder so its agents can read them.
export function syncKnowledge(scope, workspaceDir) {
  if (!obsidianOn() || !feature('knowledge')) return [];
  const name = scope.orgId ? one('SELECT name FROM orgs WHERE id = ?', scope.orgId)?.name : scope.projectId ? one('SELECT name FROM projects WHERE id = ?', scope.projectId)?.name : null;
  if (!name) return [];
  const src = path.join(vaultPath(), 'Knowledge', safeName(name));
  const dest = path.join(workspaceDir, 'knowledge', 'obsidian');
  fs.rmSync(dest, { recursive: true, force: true });
  if (!fs.existsSync(src)) return [];
  const copied = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) walk(abs, depth + 1);
      else if (e.isFile() && /\.(md|txt|csv)$/i.test(e.name) && fs.statSync(abs).size < 1_000_000) {
        const rel = path.relative(src, abs);
        fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
        fs.copyFileSync(abs, path.join(dest, rel));
        copied.push(`knowledge/obsidian/${rel.split(path.sep).join('/')}`);
      }
    }
  };
  walk(src, 0);
  return copied;
}
