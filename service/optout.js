// The do-not-contact list. Jarvis maintains it itself: opt-out replies are added automatically,
// every email is checked before sending, and agents are told about it so they don't have to ask.
import { one, all, run, now } from './db.js';
import { log, notify } from './events.js';

// Explicit opt-outs and clear refusals. Checked only against replies to Jarvis's own emails.
const OPT_OUT = /\b(unsubscribe|opt[\s-]?out|stop (?:emailing|contacting|messaging)|remove me|take me off|do not (?:contact|email)|don'?t (?:contact|email)|not interested|no,? thank(?:s| you)|stop)\b/i;
export const isOptOut = (text) => OPT_OUT.test(String(text ?? '').slice(0, 600));

// Entries are email addresses or phone numbers (digits only, international format).
const clean = (contact) => {
  const s = String(contact ?? '').trim().toLowerCase();
  return s.includes('@') ? s : s.replace(/[^\d]/g, '');
};

export function blockContact({ orgId = null, email, reason = '', source = 'owner' }) {
  const e = clean(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/^\d{8,15}$/.test(e)) throw new Error('That is not a valid email address or phone number');
  run(
    'INSERT INTO do_not_contact (org_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    orgId,
    e,
    String(reason).slice(0, 300),
    source,
    now(),
  );
  log('info', `Do-not-contact: ${e} added${reason ? ` (${reason})` : ''}`, orgId);
  notify('dnc', { orgId });
}

// An address is blocked if it is on this organisation's list or on the global one.
export function isBlocked(orgId, email) {
  return Boolean(one('SELECT id FROM do_not_contact WHERE email = ? AND (org_id IS ? OR org_id IS NULL)', clean(email), orgId ?? null));
}

export const listBlocked = (orgId) =>
  all('SELECT * FROM do_not_contact WHERE org_id IS ? OR org_id IS NULL ORDER BY created_at DESC', orgId ?? null);

export const unblock = (id) => {
  run('DELETE FROM do_not_contact WHERE id = ?', id);
  notify('dnc');
};

// What agents are told, so they stop asking the owner about opt-outs.
export function optOutText(orgId) {
  const rows = listBlocked(orgId);
  const shown = rows.slice(0, 100).map((r) => `- ${r.email}`);
  return `DO-NOT-CONTACT LIST: Jarvis keeps this list itself. Opt-out replies are added automatically and every email is checked before it is sent, so you never need to create, check or ask about an opt-out list. ${rows.length ? `Skip these people when finding leads:\n${shown.join('\n')}${rows.length > 100 ? `\n(and ${rows.length - 100} more)` : ''}` : 'It is currently empty.'}`;
}
