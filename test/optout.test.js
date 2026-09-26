import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JARVIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-optout-'));
const { insert, one, now, setSetting } = await import('../service/db.js');
const optout = await import('../service/optout.js');
const { routeApproved } = await import('../service/outbox.js');

const orgA = insert('INSERT INTO orgs (name, created_at, updated_at) VALUES (?, ?, ?)', 'A', now(), now());
const orgB = insert('INSERT INTO orgs (name, created_at, updated_at) VALUES (?, ?, ?)', 'B', now(), now());

test('opt-out replies are recognised, ordinary replies are not', () => {
  assert.equal(optout.isOptOut('Please unsubscribe me from this list.'), true);
  assert.equal(optout.isOptOut('STOP'), true);
  assert.equal(optout.isOptOut('Not interested, thanks.'), true);
  assert.equal(optout.isOptOut('Sounds good, can we talk on Thursday?'), false);
  assert.equal(optout.isOptOut('We stopped using our old site; send the proposal.'), false);
});

test('blocking is per organisation, with a global list on top', () => {
  optout.blockContact({ orgId: orgA, email: 'Dr@Clinic.rw', reason: 'asked' });
  assert.equal(optout.isBlocked(orgA, 'dr@clinic.rw'), true);
  assert.equal(optout.isBlocked(orgB, 'dr@clinic.rw'), false, 'another organisation may still contact them');
  optout.blockContact({ orgId: null, email: 'never@example.com' });
  assert.equal(optout.isBlocked(orgB, 'never@example.com'), true, 'the global list applies everywhere');
  optout.blockContact({ orgId: orgA, email: 'dr@clinic.rw' }); // duplicate is ignored
  assert.equal(optout.listBlocked(orgA).length, 2);
  assert.throws(() => optout.blockContact({ orgId: orgA, email: 'not-an-email' }), /valid email/);
  assert.match(optout.optOutText(orgA), /dr@clinic\.rw/);
  assert.match(optout.optOutText(orgB), /currently empty|never@example\.com/);
});

test('an approved email to a blocked address is never sent', () => {
  setSetting('gmail_address', 'me@gmail.com');
  setSetting('gmail_app_password', 'abcd efgh ijkl mnop');
  const id = insert(`INSERT INTO approvals (org_id, kind, summary, payload, status, created_at) VALUES (?, 'email', 'x', ?, 'approved', ?)`, orgA, JSON.stringify({ to: 'dr@clinic.rw', body: 'hi' }), now());
  const note = routeApproved(one('SELECT * FROM approvals WHERE id = ?', id));
  assert.match(note, /do-not-contact/);
  assert.equal(one('SELECT delivery FROM approvals WHERE id = ?', id).delivery, 'blocked');
});
