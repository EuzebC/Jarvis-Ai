import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { one, all, run, insert, now, getSetting } from './db.js';
import { notify } from './events.js';

// Every organisation, and every personal project, has its own workspace folder.
// It is the only place its agents can read or write files.
export function workDir({ orgId, projectId }) {
  const name = orgId ? `org-${orgId}` : projectId ? `personal-${projectId}` : 'personal';
  const dir = path.join(config.dataDir, 'work', name);
  fs.mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  return dir;
}

// ---------- memories ----------
export function addMemory({ orgId = null, projectId = null, content, source = 'owner', pinned = false }) {
  const text = String(content ?? '').trim().slice(0, 1000);
  if (!text) return null;
  const dup = one(
    'SELECT id FROM memories WHERE org_id IS ? AND project_id IS ? AND content = ?',
    orgId,
    projectId,
    text,
  );
  if (dup) return dup.id;
  const id = insert(
    'INSERT INTO memories (org_id, project_id, content, source, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    orgId,
    projectId,
    text,
    source,
    pinned ? 1 : 0,
    now(),
  );
  notify('memories');
  return id;
}

export const listMemories = ({ orgId = null, projectId = null }) =>
  all('SELECT * FROM memories WHERE org_id IS ? AND project_id IS ? ORDER BY pinned DESC, id DESC LIMIT 300', orgId, projectId);

// ---------- files ----------
export function safeFileName(name) {
  const base = path
    .basename(String(name ?? ''))
    .replace(/[^\w.\- ()]+/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 120);
  return base || 'file';
}

export function saveKnowledge(scope, name, buffer) {
  const dir = workDir(scope);
  const fileName = safeFileName(name);
  fs.writeFileSync(path.join(dir, 'knowledge', fileName), buffer);
  upsertFile(scope, `knowledge/${fileName}`, buffer.length, null);
}

function upsertFile({ orgId = null, projectId = null }, relPath, size, taskId) {
  const existing = one('SELECT id FROM files WHERE org_id IS ? AND project_id IS ? AND rel_path = ?', orgId, projectId, relPath);
  if (existing) run('UPDATE files SET size = ?, task_id = COALESCE(?, task_id), created_at = ? WHERE id = ?', size, taskId, now(), existing.id);
  else insert('INSERT INTO files (org_id, project_id, task_id, rel_path, size, created_at) VALUES (?, ?, ?, ?, ?, ?)', orgId, projectId, taskId, relPath, size, now());
}

// Files an agent created or changed during a run become results the owner can download anywhere.
const SKIP = new Set(['knowledge', 'node_modules', '.git', '.venv', '__pycache__']);
export function registerOutputs(scope, taskId, sinceMs) {
  const root = workDir(scope);
  let found = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(abs, depth + 1);
      } else if (e.isFile()) {
        const st = fs.statSync(abs);
        if (st.mtimeMs >= sinceMs - 1000) {
          upsertFile(scope, path.relative(root, abs).split(path.sep).join('/'), st.size, taskId);
          found++;
        }
      }
    }
  };
  walk(root, 0);
  if (found) notify('files');
  return found;
}

export function resolveFile(id) {
  const row = one('SELECT * FROM files WHERE id = ?', id);
  if (!row) return null;
  const root = workDir({ orgId: row.org_id, projectId: row.project_id });
  const abs = path.resolve(root, row.rel_path);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return null;
  return { ...row, abs, name: path.basename(abs) };
}

// ---------- the mind an agent sees ----------
const MEMORY_BUDGET = 6000;

export function mindText({ orgId = null, projectId = null }) {
  const parts = [];
  const owner = getSetting('owner_profile', '').trim();
  if (owner) parts.push(`ABOUT THE OWNER:\n${owner}`);
  if (orgId) {
    const org = one('SELECT name, description, profile FROM orgs WHERE id = ?', orgId);
    parts.push(
      `ORGANISATION: ${org.name}${org.description ? ` (${org.description})` : ''}\n` +
        `PROFILE AND STANDING INSTRUCTIONS:\n${org.profile.trim() || '(not written yet; make reasonable, stated assumptions)'}`,
    );
  } else if (projectId) {
    const p = one('SELECT name, description FROM projects WHERE id = ?', projectId);
    parts.push(`PERSONAL PROJECT: ${p.name}\n${p.description || ''}`);
  } else {
    parts.push('PERSONAL WORKSPACE: helping the owner with their own life and projects.');
  }
  const mems = [];
  let used = 0;
  for (const m of all(
    'SELECT content FROM memories WHERE org_id IS ? AND project_id IS ? ORDER BY pinned DESC, id DESC LIMIT 200',
    orgId,
    projectId,
  )) {
    if (used + m.content.length > MEMORY_BUDGET) break;
    mems.push(`- ${m.content}`);
    used += m.content.length;
  }
  if (mems.length) parts.push(`WHAT JARVIS REMEMBERS HERE:\n${mems.join('\n')}`);
  const knowledge = all(
    `SELECT rel_path FROM files WHERE org_id IS ? AND project_id IS ? AND rel_path LIKE 'knowledge/%'`,
    orgId,
    projectId,
  ).map((f) => `- ./${f.rel_path}`);
  if (knowledge.length) parts.push(`KNOWLEDGE FILES (read when relevant):\n${knowledge.join('\n')}`);
  return parts.join('\n\n');
}
