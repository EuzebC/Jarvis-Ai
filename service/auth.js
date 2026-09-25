import crypto from 'node:crypto';
import { getSetting, setSetting, one, run, now } from './db.js';
import { config } from './config.js';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const isSetUp = () => Boolean(getSetting('password_hash'));
export const checkPassword = (password) => verifyPassword(password, getSetting('password_hash'));

export function setPassword(password) {
  setSetting('password_hash', hashPassword(password));
  run('DELETE FROM sessions'); // a new password signs out every device
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function createSession(userAgent = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  run(
    'INSERT INTO sessions (token_hash, created_at, expires_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    t,
    t + config.sessionDays * 86_400_000,
    t,
    String(userAgent).slice(0, 200),
  );
  return token;
}

export function validSession(token) {
  if (!token) return false;
  const row = one('SELECT expires_at, last_seen FROM sessions WHERE token_hash = ?', sha256(token));
  if (!row || row.expires_at < now()) return false;
  if (now() - row.last_seen > 60_000) run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now(), sha256(token));
  return true;
}

export const destroySession = (token) => token && run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));

// 5 failed attempts lock an address for 15 minutes.
const failures = new Map();
export function loginAllowed(ip) {
  const f = failures.get(ip);
  return !(f && f.count >= 5 && now() - f.last < 15 * 60_000);
}
export function recordFailure(ip) {
  const f = failures.get(ip);
  const fresh = !f || now() - f.last >= 15 * 60_000;
  failures.set(ip, { count: fresh ? 1 : f.count + 1, last: now() });
}
export const clearFailures = (ip) => failures.delete(ip);
