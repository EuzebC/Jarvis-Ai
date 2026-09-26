// Gmail connector using a Google App Password: SMTP to send, IMAP to read replies.
// Only replies from people Jarvis emailed are read; everything else in the inbox is ignored.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { getSetting, setSetting } from '../db.js';

const creds = () => ({ user: getSetting('gmail_address'), pass: getSetting('gmail_app_password') });
export const gmailConnected = () => Boolean(getSetting('gmail_address') && getSetting('gmail_app_password'));

const transport = ({ user, pass }) =>
  nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: pass.replace(/\s+/g, '') } });

const imap = ({ user, pass }) =>
  new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass: pass.replace(/\s+/g, '') }, logger: false });

function friendly(err) {
  const m = String(err?.message || err);
  if (/Invalid login|Username and Password not accepted|AUTHENTICATIONFAILED|535/i.test(m)) {
    return 'Google rejected the login. Use a 16-character App Password (not your normal password), with 2-Step Verification turned on.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(m)) return 'Could not reach Gmail. Check the internet connection.';
  return m;
}

// Verifies both sending (SMTP) and reading (IMAP) before saving.
export async function testGmail(user, pass) {
  try {
    await transport({ user, pass }).verify();
    const client = imap({ user, pass });
    await client.connect();
    await client.logout();
    return 'Connected: Jarvis can send from this address and read replies';
  } catch (err) {
    throw new Error(friendly(err));
  }
}

export async function sendEmail({ to, subject, text }) {
  const { user, pass } = creds();
  const name = getSetting('gmail_sender_name', '');
  try {
    const info = await transport({ user, pass }).sendMail({ from: name ? `"${name}" <${user}>` : user, to, subject, text });
    return { messageId: info.messageId, from: user };
  } catch (err) {
    throw new Error(friendly(err));
  }
}

// Fetches new messages from addresses Jarvis has emailed. Returns [{uid, from, subject, text, date}].
export async function fetchReplies(knownSenders) {
  if (!knownSenders.size) return [];
  const client = imap(creds());
  await client.connect();
  const out = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const lastUid = Number(getSetting('gmail_last_uid', '0'));
    let maxUid = lastUid;
    const since = new Date(Date.now() - 14 * 86_400_000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    for (const uid of uids.filter((u) => u > lastUid)) {
      maxUid = Math.max(maxUid, uid);
      const msg = await client.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
      const from = msg?.envelope?.from?.[0]?.address?.toLowerCase();
      if (!from || !knownSenders.has(from)) continue;
      out.push({ uid: String(uid), from, subject: msg.envelope.subject ?? '', date: msg.envelope.date, text: plainText(msg.source?.toString('utf8') ?? '') });
    }
    setSetting('gmail_last_uid', maxUid);
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

// Rough plain-text extraction from a raw message, dropping the quoted history.
function plainText(raw) {
  const body = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n');
  const plainPart = body.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--)/i)?.[1] ?? body;
  let text = plainPart.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  text = text.split(/\r?\nOn .{5,120}wrote:\r?\n/)[0].split(/\r?\n>/)[0];
  return text.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 4000);
}
