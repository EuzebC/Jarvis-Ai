import { EventEmitter } from 'node:events';
import { insert, run, now } from './db.js';

// Live updates for every open app window (Server-Sent Events subscribe to this bus).
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export function log(level, message, orgId = null) {
  const ts = now();
  const id = insert('INSERT INTO events (ts, level, org_id, message) VALUES (?, ?, ?, ?)', ts, level, orgId, message);
  (level === 'error' ? console.error : console.log)(`[${new Date(ts).toISOString()}] ${level.toUpperCase()} ${message}`);
  bus.emit('event', { type: 'log', id, ts, level, orgId, message });
}

export const notify = (type, payload = {}) => bus.emit('event', { type, ...payload });

export const pruneEvents = (days = 30) => run('DELETE FROM events WHERE ts < ?', now() - days * 86_400_000);
