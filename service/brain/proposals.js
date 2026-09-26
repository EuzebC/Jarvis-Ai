// Policy-aware creation of outgoing actions. Agents never send anything themselves: every action goes
// through here, is routed by the policy (auto-send, team leader, or owner), and approved emails are
// handed to the Outbox, which sends them from Gmail and logs them in HubSpot.
import { one, insert, run, now, getSetting } from '../db.js';
import { log, notify } from '../events.js';
import { routeApproved } from '../outbox.js';
import { isBlocked } from '../optout.js';
import { routeAction, OUTGOING, hasPlaceholders } from './policy.js';
import { normalisePhone, hasWrittenToUs, whatsappConnected } from '../connectors/whatsapp.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function contactHasReplied(orgId, email) {
  if (!email) return false;
  if (!String(email).includes('@')) return hasWrittenToUs(orgId, normalisePhone(email));
  return Boolean(
    one(
      `SELECT r.id FROM replies r JOIN sent_emails s ON s.id = r.sent_email_id WHERE s.org_id IS ? AND lower(s.to_email) = lower(?) LIMIT 1`,
      orgId ?? null,
      email,
    ),
  );
}

/**
 * @returns {{ ok: boolean, route?: string, approvalId?: number, message: string }}
 */
export function proposeAction({ scope, task, kind, summary, details = {} }) {
  const orgId = scope.orgId ?? null;
  const to = String(details.to ?? '');
  const needsRecipient = OUTGOING.has(kind) && kind !== 'post';
  // WhatsApp messages are addressed to a phone number; everything else to an email address.
  const email = kind === 'whatsapp' ? normalisePhone(details.phone || to) : (to.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null);

  if (kind === 'whatsapp' && !email) return { ok: false, message: 'Refused: a WhatsApp message needs the phone number you actually found (international format).' };
  if (kind === 'whatsapp' && !whatsappConnected()) return { ok: false, message: 'Refused: WhatsApp is not connected yet. Propose it as kind "other" with the number in details.channel so the owner can send it from their phone, or use email.' };
  if (needsRecipient && !email && kind !== 'call') {
    return { ok: false, message: 'Refused: an email or proposal needs a real recipient address that you actually found. If there is none, add the lead to the CRM with the contact channel you did find and move on.' };
  }
  if (email && isBlocked(orgId, email)) return { ok: false, message: `Refused: ${email} is on the do-not-contact list. Skip this person.` };
  if (OUTGOING.has(kind) && hasPlaceholders(`${details.subject ?? ''}\n${details.body ?? ''}`)) {
    return { ok: false, message: 'Refused: the message still contains placeholders like [Client]. Fill in real details, then propose it again.' };
  }

  const team = task?.team_id ? one('SELECT leader_can_approve FROM teams WHERE id = ?', task.team_id) : null;
  const decision = routeAction({
    kind,
    summary,
    contactHasReplied: contactHasReplied(orgId, email),
    leaderCanApprove: Boolean(team?.leader_can_approve),
    hasRecipient: !needsRecipient || Boolean(email) || kind === 'call',
    level: getSetting('approval_level', 'payments'),
  });
  if (decision.route === 'decline') return { ok: false, route: 'decline', message: decision.reason };

  const auto = decision.route === 'auto';
  const id = insert(
    `INSERT INTO approvals (task_id, org_id, team_id, kind, summary, payload, status, decided_by, note, route, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task?.id ?? null,
    orgId,
    task?.team_id ?? null,
    kind,
    String(summary).slice(0, 500),
    JSON.stringify(kind === 'whatsapp' ? { ...details, to: email } : details),
    auto ? 'approved' : 'pending',
    auto ? 'policy' : null,
    auto ? decision.reason : null,
    decision.route,
    now(),
    auto ? now() : null,
  );
  let message;
  if (auto) {
    const note = routeApproved(one('SELECT * FROM approvals WHERE id = ?', id));
    message = `Sent for delivery automatically (${decision.reason}) ${note}`;
  } else if (decision.route === 'leader') {
    message = 'Submitted. Your team leader will review it before it goes out; carry on with the next item.';
  } else {
    message = 'Submitted to the owner for approval (this needs the owner because: ' + decision.reason + '). Do not wait for it; continue with your other work.';
  }
  log('info', `${auto ? '⚡' : '⏳'} ${kind}: ${String(summary).slice(0, 120)} (${decision.route})`, orgId);
  notify('approvals', { orgId });
  return { ok: true, route: decision.route, approvalId: id, message };
}

// A team leader (or a review session) decides an item that was routed to them.
export function leaderDecision(approvalId, approve, reason) {
  const a = one('SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!a || a.status !== 'pending' || a.route !== 'leader') return false;
  run('UPDATE approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'rejected', 'leader', reason ?? null, now(), approvalId);
  if (approve) routeApproved(one('SELECT * FROM approvals WHERE id = ?', approvalId));
  notify('approvals', { orgId: a.org_id });
  return true;
}
