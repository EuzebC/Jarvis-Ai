// Delivers approved outgoing work and follows up on replies.
// Approved email/proposal -> queued -> sent from Gmail (within the daily limit) -> logged in HubSpot.
// Replies -> logged in HubSpot, deal moved forward, a follow-up task for the team (still needs approval).
import { one, all, run, insert, now, getSetting } from './db.js';
import { log, notify } from './events.js';
import { gmailConnected, sendEmail, fetchReplies } from './connectors/gmail.js';
import { hubspotConnected, addLead, logEmail, advanceDeal } from './connectors/hubspot.js';
import { isBlocked, isOptOut, blockContact } from './optout.js';

const SENDABLE = ['email', 'proposal'];
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const dailyLimit = () => Number(getSetting('gmail_daily_limit', '20'));
export const sentToday = () => one('SELECT COUNT(*) AS n FROM sent_emails WHERE sent_at > ?', now() - 86_400_000).n;

// Called right after the owner (or a trusted leader) approves something.
export function routeApproved(approval) {
  const d = JSON.parse(approval.payload || '{}');
  let delivery = 'manual';
  let note;
  if (!SENDABLE.includes(approval.kind)) note = 'Approved. This kind of action is carried out by you.';
  else if (!EMAIL_RE.test(String(d.to ?? ''))) note = 'Approved, but there is no email address. Copy it and send it another way (contact form, WhatsApp).';
  else if (isBlocked(approval.org_id, String(d.to).match(EMAIL_RE)[0])) {
    delivery = 'blocked';
    note = 'Not sent: this address is on the do-not-contact list.';
  }
  else if (!gmailConnected()) note = 'Approved. Connect Gmail in Settings to send automatically, or copy and send it yourself.';
  else {
    delivery = 'queued';
    note = sentToday() >= dailyLimit() ? `Approved. Daily limit of ${dailyLimit()} reached; it will send when the limit resets.` : 'Approved. Sending now…';
  }
  run('UPDATE approvals SET delivery = ?, delivery_note = ? WHERE id = ?', delivery, note, approval.id);
  if (delivery === 'queued') setImmediate(() => deliverQueued().catch((err) => log('error', `Outbox: ${err.message}`)));
  return note;
}

const nameAndEmail = (to) => {
  const email = String(to).match(EMAIL_RE)?.[0]?.toLowerCase();
  const name = String(to).replace(/<[^>]*>/, '').replace(EMAIL_RE, '').replace(/["']/g, '').trim();
  return { email, name };
};

function compose(body) {
  const sig = getSetting('email_signature', '').trim();
  const footer = getSetting('email_footer', "If you'd rather not hear from me, just reply and let me know.").trim();
  return [String(body ?? '').trim(), sig, footer].filter(Boolean).join('\n\n');
}

let delivering = false;
export async function deliverQueued() {
  if (delivering || !gmailConnected()) return;
  delivering = true;
  try {
    const queue = all(`SELECT * FROM approvals WHERE delivery = 'queued' ORDER BY decided_at, id`);
    for (const a of queue) {
      if (sentToday() >= dailyLimit()) break;
      const d = JSON.parse(a.payload || '{}');
      const { email, name } = nameAndEmail(d.to);
      if (isBlocked(a.org_id, email)) {
        run(`UPDATE approvals SET delivery = 'blocked', delivery_note = 'Not sent: this address is on the do-not-contact list.' WHERE id = ?`, a.id);
        continue;
      }
      const subject = String(d.subject || a.summary).slice(0, 200);
      const text = compose(d.body || a.summary);
      let sent;
      try {
        sent = await sendEmail({ to: d.to, subject, text });
      } catch (err) {
        run(`UPDATE approvals SET delivery = 'failed', delivery_note = ? WHERE id = ?`, `Sending failed: ${err.message}`, a.id);
        log('error', `Email to ${email} failed: ${err.message}`, a.org_id);
        continue;
      }
      const sentId = insert(
        'INSERT INTO sent_emails (approval_id, org_id, team_id, message_id, to_email, subject, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        a.id,
        a.org_id,
        a.team_id,
        sent.messageId,
        email,
        subject,
        now(),
      );
      let note = `Sent to ${email} at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
      if (hubspotConnected()) {
        try {
          const { contactId, companyId } = await addLead({ company: d.company, website: d.website, email, name: d.to_name || name, phone: d.phone });
          const dealId =
            a.kind === 'proposal'
              ? await advanceDeal({ contactId, companyId, name: `${d.company || email} – ${a.summary}`, stage: 'presentationscheduled', amount: Number(d.amount) || null })
              : null;
          await logEmail({ contactId, companyId, dealId, subject, text, direction: 'EMAIL', from: sent.from, to: email });
          run('UPDATE sent_emails SET hs_contact_id = ?, hs_company_id = ?, hs_deal_id = ? WHERE id = ?', contactId, companyId, dealId, sentId);
          note += ' Logged in HubSpot.';
        } catch (err) {
          note += ` HubSpot logging failed: ${err.message}`;
          log('warn', `HubSpot: ${err.message}`, a.org_id);
        }
      }
      run(`UPDATE approvals SET delivery = 'sent', delivery_note = ?, sent_at = ? WHERE id = ?`, note, now(), a.id);
      log('info', `✉ ${note}`, a.org_id);
    }
  } finally {
    delivering = false;
    notify('approvals');
  }
}

let checking = false;
export async function checkReplies({ onReply }) {
  if (checking || !gmailConnected() || getSetting('gmail_read_replies', '1') !== '1') return;
  checking = true;
  try {
    const known = new Set(all('SELECT DISTINCT to_email FROM sent_emails').map((r) => r.to_email));
    const replies = await fetchReplies(known);
    for (const r of replies) {
      if (one('SELECT id FROM replies WHERE uid = ?', r.uid)) continue;
      const sentMail = one('SELECT * FROM sent_emails WHERE to_email = ? ORDER BY sent_at DESC LIMIT 1', r.from);
      if (!sentMail) continue;
      insert('INSERT INTO replies (sent_email_id, from_email, subject, body, received_at, uid) VALUES (?, ?, ?, ?, ?, ?)', sentMail.id, r.from, r.subject, r.text, now(), r.uid);
      log('info', `↩ Reply from ${r.from}: "${r.subject}"`, sentMail.org_id);
      if (isOptOut(r.text)) {
        blockContact({ orgId: sentMail.org_id, email: r.from, reason: 'Asked not to be contacted (reply)', source: 'reply' });
        continue; // no follow-up task, no deal movement
      }

      if (hubspotConnected()) {
        try {
          const dealId = await advanceDeal({
            contactId: sentMail.hs_contact_id,
            companyId: sentMail.hs_company_id,
            name: `${r.from.split('@')[1]} – replied to outreach`,
            stage: 'qualifiedtobuy',
          });
          await logEmail({ contactId: sentMail.hs_contact_id, companyId: sentMail.hs_company_id, dealId, subject: r.subject, text: r.text, direction: 'INCOMING_EMAIL', from: r.from, to: getSetting('gmail_address') });
          run('UPDATE sent_emails SET hs_deal_id = COALESCE(hs_deal_id, ?) WHERE id = ?', dealId, sentMail.id);
        } catch (err) {
          log('warn', `HubSpot reply logging failed: ${err.message}`, sentMail.org_id);
        }
      }

      // The team that wrote to them decides the next step (later messages to this contact send automatically).
      try {
        onReply?.(sentMail, r);
      } catch (err) {
        log('warn', `Reply handling failed: ${err.message}`, sentMail.org_id);
      }
    }
  } catch (err) {
    log('warn', `Checking Gmail replies failed: ${err.message}`);
  } finally {
    checking = false;
  }
}
