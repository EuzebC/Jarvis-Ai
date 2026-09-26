import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JARVIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conn-'));
const { insert, one, now, setSetting } = await import('../service/db.js');
const { routeApproved } = await import('../service/outbox.js');
const hubspot = await import('../service/connectors/hubspot.js');
const { parseAgentOutput } = await import('../service/protocol.js');

const approval = (kind, details) => {
  const id = insert(`INSERT INTO approvals (kind, summary, payload, status, created_at) VALUES (?, 'x', ?, 'approved', ?)`, kind, JSON.stringify(details), now());
  return one('SELECT * FROM approvals WHERE id = ?', id);
};

test('approved items are routed: no address or no Gmail means manual, otherwise queued', () => {
  let a = approval('email', { to: '', body: 'hi' });
  routeApproved(a);
  assert.equal(one('SELECT delivery FROM approvals WHERE id = ?', a.id).delivery, 'manual');

  a = approval('email', { to: 'dr@clinic.rw', body: 'hi' });
  assert.match(routeApproved(a), /Connect Gmail/);
  assert.equal(one('SELECT delivery FROM approvals WHERE id = ?', a.id).delivery, 'manual');

  a = approval('payment', { to: 'bank@x.com' });
  routeApproved(a);
  assert.equal(one('SELECT delivery FROM approvals WHERE id = ?', a.id).delivery, 'manual', 'payments are never sent automatically');

  setSetting('gmail_address', 'me@gmail.com');
  setSetting('gmail_app_password', 'abcd efgh ijkl mnop');
  setSetting('gmail_daily_limit', '0'); // keeps the worker from actually sending in this test
  a = approval('proposal', { to: 'Dr Uwase <dr@clinic.rw>', body: 'Proposal' });
  assert.match(routeApproved(a), /Daily limit/);
  assert.equal(one('SELECT delivery FROM approvals WHERE id = ?', a.id).delivery, 'queued');
});

test('agents can hand over leads for the CRM', () => {
  const out = parseAgentOutput('Done\n```json\n{"summary":"ok","leads":[{"company":"Smile Dental","website":"smile.rw","email":"info@smile.rw"},{"notes":"no name"}]}\n```');
  assert.equal(out.leads.length, 1);
  assert.equal(out.leads[0].company, 'Smile Dental');
});

// A tiny fake HubSpot, so the CRM logic is tested without a real account.
function fakeHubspot() {
  const db = { companies: [], contacts: [], deals: [], emails: [], notes: [], links: [] };
  let seq = 100;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const m = u.pathname.match(/^\/crm\/v3\/objects\/(\w+)(?:\/(search|\d+))?$/);
    const assoc = u.pathname.match(/^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/(?:default\/)?(\w+)(?:\/(\d+))?$/);
    if (assoc && init.method === 'PUT') return db.links.push([assoc[1], assoc[3]]), ok({});
    if (assoc) return ok({ results: db.deals.filter((d) => d.contact === assoc[1]).map((d) => ({ toObjectId: d.id })) });
    if (!m) return ok({});
    const [, object, sub] = m;
    if (sub === 'search') {
      const f = body.filterGroups[0].filters[0];
      return ok({ results: db[object].filter((r) => r.properties[f.propertyName] === f.value) });
    }
    if (init.method === 'POST') {
      const rec = { id: String(seq++), properties: body.properties };
      if (object === 'deals') rec.contact = body.associations.find((x) => x.types[0].associationTypeId === 3)?.to.id;
      db[object].push(rec);
      return ok(rec);
    }
    if (init.method === 'PATCH') {
      const rec = db[object].find((r) => r.id === sub);
      Object.assign(rec.properties, body.properties);
      return ok(rec);
    }
    if (sub) return ok(db[object].find((r) => r.id === sub));
    return ok({ results: [] });
  };
  return db;
}

test('HubSpot: leads are de-duplicated and deals only move forward', async () => {
  const db = fakeHubspot();
  setSetting('hubspot_token', 'test');
  const a = await hubspot.addLead({ company: 'Smile Dental', website: 'https://www.smile.rw', email: 'Dr@Smile.rw', name: 'Aline Uwase' });
  const b = await hubspot.addLead({ company: 'Smile Dental Clinic', website: 'smile.rw', email: 'dr@smile.rw' });
  assert.equal(db.companies.length, 1, 'same domain means same company');
  assert.equal(db.contacts.length, 1, 'same email means same contact');
  assert.equal(a.contactId, b.contactId);
  assert.equal(db.contacts[0].properties.firstname, 'Aline');
  assert.deepEqual(db.links[0], [a.contactId, a.companyId]);

  const gmailLead = await hubspot.addLead({ company: 'Home Clinic', email: 'owner@gmail.com' });
  assert.equal(db.companies.find((c) => c.id === gmailLead.companyId).properties.domain, undefined, 'gmail.com is never used as a company domain');

  const dealId = await hubspot.advanceDeal({ contactId: a.contactId, companyId: a.companyId, name: 'Smile – website', stage: 'presentationscheduled', amount: 4500 });
  assert.equal(db.deals.length, 1);
  await hubspot.advanceDeal({ contactId: a.contactId, companyId: a.companyId, name: 'Smile – reply', stage: 'qualifiedtobuy' });
  assert.equal(db.deals.length, 1, 'no duplicate deal');
  assert.equal(db.deals[0].properties.dealstage, 'presentationscheduled', 'a reply never moves a deal backwards');
  await hubspot.advanceDeal({ contactId: a.contactId, companyId: a.companyId, name: 'x', stage: 'contractsent' });
  assert.equal(db.deals[0].properties.dealstage, 'contractsent');
  assert.equal(dealId, db.deals[0].id);

  await hubspot.logEmail({ contactId: a.contactId, companyId: a.companyId, dealId, subject: 'Hi', text: 'Hello', from: 'me@gmail.com', to: 'dr@smile.rw' });
  assert.equal(db.emails[0].properties.hs_email_direction, 'EMAIL');
});
