import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'jarvis.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL, user_agent TEXT
);

-- Organisations: each has its own mind (profile + memories), structure, goals and files.
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#39e58c',
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  leader_can_approve INTEGER NOT NULL DEFAULT 0,  -- off until the owner trusts the team
  position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

-- tier: jarvis (chief of staff) | head (department) | leader (team) | worker
-- org_id NULL means a personal agent.
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'worker', model TEXT NOT NULL DEFAULT 'auto',
  web INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#3fb5ff',
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  root_id INTEGER, depth INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | waiting | done | failed | cancelled
  summary TEXT, result TEXT, error TEXT, provider TEXT, model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, priority DESC, id);
CREATE INDEX IF NOT EXISTS tasks_org ON tasks(org_id, status);

-- Goals cascade: quarter > month > week, at organisation, department or team level.
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, scope_id INTEGER NOT NULL, period TEXT NOT NULL,
  period_label TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- KPIs at department, team or agent level.
CREATE TABLE IF NOT EXISTS kpis (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, scope_id INTEGER NOT NULL, name TEXT NOT NULL,
  target REAL, actual REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT '',
  higher_is_better INTEGER NOT NULL DEFAULT 1, history TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
);

-- Anything that leaves the company waits here. Payments always need the owner.
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE, team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, note TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
);

-- The mind: memories per organisation or per personal project.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY, org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'owner', pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  rel_path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE (org_id, project_id, rel_path)
);

-- Draft organisation structures proposed by Jarvis, edited by the owner, then applied.
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  status TEXT NOT NULL, body TEXT, error TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, task_id INTEGER, provider TEXT NOT NULL, model TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_recent ON runs(provider, started_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, org_id INTEGER, message TEXT NOT NULL
);
`);

// Additive migrations for databases created by earlier versions.
function addColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('tasks', 'blocked_by', 'INTEGER REFERENCES tasks(id) ON DELETE SET NULL');

export const now = () => Date.now();

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

export const one = (sql, ...params) => db.prepare(sql).get(...params);
export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);
export const insert = (sql, ...params) => Number(db.prepare(sql).run(...params).lastInsertRowid);
