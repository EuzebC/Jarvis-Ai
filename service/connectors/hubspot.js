// HubSpot CRM connector. Authenticates with a Service Key (or a legacy private-app token)
// sent as a Bearer token. Needs these scopes: crm.objects.contacts.read/write,
// crm.objects.companies.read/write, crm.objects.deals.read/write.
import { getSetting } from '../db.js';

const BASE = 'https://api.hubapi.com';

// HubSpot-defined association type IDs.
const ASSOC = {
  emailToContact: 198,
  emailToCompany: 186,
  emailToDeal: 210,
  contactToCompany: 279,
  dealToContact: 3,
  dealToCompany: 5,
};

// Default sales pipeline stages, in order.
export const STAGES = ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon', 'closedlost'];

export const hubspotConnected = () => Boolean(getSetting('hubspot_token'));

async function hs(method, path, body, token = getSetting('hubspot_token')) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'HubSpot rejected the key. Create a Service Key and paste it in Settings.' : res.status === 403 ? `HubSpot key is missing a permission (${data.message ?? 'scope'})` : `HubSpot error ${res.status}: ${data.message ?? ''}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('HubSpot is rate-limiting requests; try again shortly');
}

// Checks the key can read contacts, companies and deals. Returns a short description.
export async function testHubspot(token) {
  await hs('GET', '/crm/v3/objects/contacts?limit=1', null, token);
  await hs('GET', '/crm/v3/objects/companies?limit=1', null, token);
  await hs('GET', '/crm/v3/objects/deals?limit=1', null, token);
  return 'Connected: contacts, companies and deals are accessible';
}

async function findOne(object, property, value) {
  if (!value) return null;
  const r = await hs('POST', `/crm/v3/objects/${object}/search`, {
    filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value }] }],
    limit: 1,
  });
  return r.results?.[0] ?? null;
}

const domainOf = (s) => {
  if (!s) return null;
  const m = String(s).toLowerCase().match(/@([^>\s]+)|(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/);
  const d = m?.[1] ?? m?.[2] ?? null;
  return d && !/^(gmail|yahoo|hotmail|outlook|icloud|live|proton)\./.test(d) ? d : null;
};

export async function upsertCompany({ name, website, email }) {
  const domain = domainOf(website) ?? domainOf(email);
  const existing = (domain && (await findOne('companies', 'domain', domain))) || (name && (await findOne('companies', 'name', name)));
  if (existing) return existing.id;
  if (!name && !domain) return null;
  const created = await hs('POST', '/crm/v3/objects/companies', { properties: { name: name || domain, ...(domain ? { domain } : {}) } });
  return created.id;
}

export async function upsertContact({ email, name, phone, companyId }) {
  if (!email) return null;
  const existing = await findOne('contacts', 'email', email.toLowerCase());
  let id = existing?.id;
  if (!id) {
    const [firstname, ...rest] = String(name || '').trim().split(/\s+/);
    const created = await hs('POST', '/crm/v3/objects/contacts', {
      properties: { email: email.toLowerCase(), ...(firstname ? { firstname } : {}), ...(rest.length ? { lastname: rest.join(' ') } : {}), ...(phone ? { phone } : {}) },
    });
    id = created.id;
  }
  if (companyId) {
    await hs('PUT', `/crm/v4/objects/contacts/${id}/associations/default/companies/${companyId}`).catch(() => {});
  }
  return id;
}

// Adds leads found by agents (no approval needed: nothing leaves the company).
export async function addLead(lead) {
  const companyId = await upsertCompany({ name: lead.company, website: lead.website, email: lead.email });
  const contactId = await upsertContact({ email: lead.email, name: lead.name, phone: lead.phone, companyId });
  if (lead.notes && (contactId || companyId)) {
    await hs('POST', '/crm/v3/objects/notes', {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: `Found by Jarvis: ${lead.notes}` },
      associations: [
        ...(contactId ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }] : []),
        ...(companyId ? [{ to: { id: companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }] }] : []),
      ],
    }).catch(() => {});
  }
  return { contactId, companyId };
}

export async function logEmail({ contactId, companyId, dealId, subject, text, direction = 'EMAIL', from, to }) {
  const assoc = (id, typeId) => (id ? [{ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] }] : []);
  return hs('POST', '/crm/v3/objects/emails', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_email_direction: direction,
      hs_email_status: 'SENT',
      hs_email_subject: subject,
      hs_email_text: text,
      hs_email_headers: JSON.stringify({ from: { email: from }, to: [{ email: to }], cc: [], bcc: [] }),
    },
    associations: [...assoc(contactId, ASSOC.emailToContact), ...assoc(companyId, ASSOC.emailToCompany), ...assoc(dealId, ASSOC.emailToDeal)],
  });
}

async function openDealFor(contactId) {
  if (!contactId) return null;
  const r = await hs('GET', `/crm/v4/objects/contacts/${contactId}/associations/deals`).catch(() => null);
  for (const d of r?.results ?? []) {
    const deal = await hs('GET', `/crm/v3/objects/deals/${d.toObjectId}?properties=dealstage,dealname,amount`).catch(() => null);
    if (deal && !['closedwon', 'closedlost'].includes(deal.properties.dealstage)) return deal;
  }
  return null;
}

// Moves a deal forward (never backwards) or creates it at that stage.
export async function advanceDeal({ contactId, companyId, name, stage, amount }) {
  const deal = await openDealFor(contactId);
  if (deal) {
    const current = STAGES.indexOf(deal.properties.dealstage);
    const props = {};
    if (STAGES.indexOf(stage) > current) props.dealstage = stage;
    if (amount && !deal.properties.amount) props.amount = String(amount);
    if (Object.keys(props).length) await hs('PATCH', `/crm/v3/objects/deals/${deal.id}`, { properties: props });
    return deal.id;
  }
  const assoc = (id, typeId) => (id ? [{ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] }] : []);
  const created = await hs('POST', '/crm/v3/objects/deals', {
    properties: { dealname: name.slice(0, 200), pipeline: 'default', dealstage: stage, ...(amount ? { amount: String(amount) } : {}) },
    associations: [...assoc(contactId, ASSOC.dealToContact), ...assoc(companyId, ASSOC.dealToCompany)],
  });
  return created.id;
}
