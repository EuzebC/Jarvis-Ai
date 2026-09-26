// WhatsApp Business Cloud API connector (Meta Graph API). Sends messages from the owner's WhatsApp
// Business number and receives replies through a webhook. Outside the 24-hour customer-service
// window WhatsApp only accepts approved message templates, so first contacts go out as the template
// chosen in Settings and free-form text is used once the person has written back.
import crypto from 'node:crypto';
import { one, all, insert, run, now, getSetting } from '../db.js';

const GRAPH = 'https://graph.facebook.com/v22.0';
const WINDOW_MS = 24 * 60 * 60_000;

export const whatsappConnected = () => Boolean(getSetting('whatsapp_phone_id') && getSetting('whatsapp_token'));
export const whatsappDailyLimit = () => Number(getSetting('whatsapp_daily_limit', '50'));
export const whatsappSentToday = () => one(`SELECT COUNT(*) AS n FROM wa_messages WHERE direction = 'out' AND ts > ?`, now() - 86_400_000).n;

// Phone numbers are stored as digits only (international format without the plus), which is what the API expects.
export function normalisePhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

async function graph(method, path, body, token = getSetting('whatsapp_token')) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    const err = new Error(friendly(e));
    err.code = e.code;
    throw err;
  }
  return data;
}

function friendly(e) {
  const code = Number(e.code);
  if (code === 190) return 'WhatsApp rejected the access token. Create a permanent System User token in Meta Business Settings and paste it again.';
  if (code === 131047) return 'More than 24 hours since this person last wrote to us: WhatsApp only allows an approved template now.';
  if (code === 131026 || code === 131030) return 'This number cannot receive messages from us (not on WhatsApp, or not in the allowed test list while the number is still in test mode).';
  if (code === 132001 || code === 132000) return 'The message template name or language does not match an approved template.';
  if (code === 100) return `WhatsApp did not accept the request (${e.message ?? 'bad parameter'}).`;
  return `WhatsApp error ${code || ''}: ${e.message ?? 'unknown'}`;
}

// Verifies the phone number id and token, returns the display number.
export async function testWhatsapp(phoneId, token) {
  const info = await graph('GET', `/${encodeURIComponent(phoneId)}?fields=display_phone_number,verified_name,quality_rating`, null, token);
  return {
    message: `Connected: ${info.verified_name ?? 'WhatsApp'} ${info.display_phone_number ?? ''} (quality ${info.quality_rating ?? 'unknown'})`,
    number: info.display_phone_number ?? '',
    name: info.verified_name ?? '',
  };
}

// The last time this person wrote to us decides whether free text is allowed.
export function lastInboundAt(phone) {
  return one(`SELECT ts FROM wa_messages WHERE direction = 'in' AND phone = ? ORDER BY ts DESC LIMIT 1`, phone)?.ts ?? 0;
}
export const inServiceWindow = (phone) => now() - lastInboundAt(phone) < WINDOW_MS;
export const hasWrittenToUs = (orgId, phone) => Boolean(phone && one(`SELECT id FROM wa_messages WHERE direction = 'in' AND phone = ? AND (org_id IS ? OR ? IS NULL) LIMIT 1`, phone, orgId ?? null, orgId ?? null));

/**
 * Sends one message. Free text inside the 24-hour window, otherwise the configured template.
 * @returns {Promise<{ waId: string, mode: 'text'|'template' }>}
 */
export async function sendWhatsapp({ to, text, name = '', company = '', hook = '' }) {
  const phone = normalisePhone(to);
  if (!phone) throw new Error('That is not a usable phone number (use the international format, e.g. +250 78x xxx xxx).');
  const phoneId = getSetting('whatsapp_phone_id');
  if (inServiceWindow(phone)) {
    const r = await graph('POST', `/${phoneId}/messages`, { messaging_product: 'whatsapp', to: phone, type: 'text', text: { preview_url: false, body: String(text).slice(0, 4000) } });
    return { waId: r.messages?.[0]?.id ?? '', mode: 'text' };
  }
  const template = getSetting('whatsapp_template', '');
  if (!template) throw new Error('First contact needs an approved WhatsApp template. Add its name in Settings → Connectors → WhatsApp.');
  const lang = getSetting('whatsapp_template_lang', 'en');
  const count = Math.max(0, Math.min(3, Number(getSetting('whatsapp_template_params', '2'))));
  const params = [name || 'there', company || '', hook || String(text).split(/\n/)[0]]
    .slice(0, count)
    .map((v) => ({ type: 'text', text: String(v).replace(/\s+/g, ' ').slice(0, 300) || '-' }));
  const body = { messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: template, language: { code: lang } } };
  if (params.length) body.template.components = [{ type: 'body', parameters: params }];
  const r = await graph('POST', `/${phoneId}/messages`, body);
  return { waId: r.messages?.[0]?.id ?? '', mode: 'template' };
}

export function recordOutbound({ orgId, teamId, approvalId, phone, body, waId, mode }) {
  return insert(
    'INSERT INTO wa_messages (org_id, team_id, approval_id, direction, phone, name, body, wa_id, mode, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    orgId ?? null,
    teamId ?? null,
    approvalId ?? null,
    'out',
    phone,
    '',
    String(body ?? ''),
    waId || null,
    mode,
    now(),
  );
}

// ---------- webhook ----------
export function verifyToken() {
  let t = getSetting('whatsapp_verify_token', '');
  if (!t) {
    t = crypto.randomBytes(12).toString('hex');
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'whatsapp_verify_token', t);
  }
  return t;
}

// Meta signs every delivery with the app secret; when the secret is set, unsigned or wrongly signed posts are ignored.
export function signatureValid(rawBody, header) {
  const secret = getSetting('whatsapp_app_secret', '');
  if (!secret) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = String(header ?? '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Extracts inbound text messages from a webhook payload.
 * @returns {Array<{ waId: string, phone: string, name: string, text: string, ts: number }>}
 */
export function parseInbound(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const names = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? '']));
      for (const m of v.messages ?? []) {
        const text =
          m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
        if (!text) continue;
        out.push({ waId: m.id, phone: normalisePhone(m.from) ?? String(m.from), name: names[m.from] ?? '', text: String(text).slice(0, 4000), ts: Number(m.timestamp) * 1000 || now() });
      }
    }
  }
  return out;
}

// Stores an inbound message once; returns the row plus the outbound message it answers, or null if already seen.
export function recordInbound(msg) {
  if (one('SELECT id FROM wa_messages WHERE wa_id = ?', msg.waId)) return null;
  const last = one(`SELECT * FROM wa_messages WHERE direction = 'out' AND phone = ? ORDER BY ts DESC LIMIT 1`, msg.phone);
  const id = insert(
    'INSERT INTO wa_messages (org_id, team_id, approval_id, direction, phone, name, body, wa_id, mode, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    last?.org_id ?? null,
    last?.team_id ?? null,
    null,
    'in',
    msg.phone,
    msg.name,
    msg.text,
    msg.waId,
    'text',
    msg.ts,
  );
  return { row: one('SELECT * FROM wa_messages WHERE id = ?', id), last };
}

export const recentWhatsapp = (orgId, limit = 10) => all(`SELECT * FROM wa_messages WHERE direction = 'in' AND org_id IS ? ORDER BY ts DESC LIMIT ?`, orgId ?? null, limit);
