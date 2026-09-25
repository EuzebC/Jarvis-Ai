import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

// Data lives in the user's profile so reinstalling the app never loses organisations or history.
const defaultData = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Jarvis');

export const config = {
  root,
  host: '127.0.0.1', // local only; remote access comes later through a tunnel
  port: num(process.env.JARVIS_PORT, 7777),
  dataDir: path.resolve(process.env.JARVIS_DATA_DIR || defaultData),
  uiDir: path.join(root, 'ui', 'dist'),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  codexBin: process.env.CODEX_BIN || 'codex',
  runTimeoutMs: num(process.env.JARVIS_RUN_TIMEOUT_MIN, 15) * 60_000,
  limitCooldownMs: 30 * 60_000,
  maxAttempts: 3,
  maxDepth: 4,
  maxTasksPerRoot: 30,
  sessionDays: 30,
};
