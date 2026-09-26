// The escalation policy: what agents may do alone, what a team leader may approve,
// and the few things that always come to the owner. Pure logic, no database access, so it is easy to test.
//
// Owner decisions were fixed by the owner: money (payments, purchases), contracts, deletions of data,
// and the FIRST outgoing message to a new contact. Later messages to a contact who has replied are
// sent automatically. Everything else is the agents' job to decide; asking the owner is refused.

export const OWNER_ONLY = new Set(['payment', 'purchase', 'contract', 'deletion']);
export const OUTGOING = new Set(['email', 'proposal', 'post', 'call', 'whatsapp']);
export const KINDS = [...OWNER_ONLY, ...OUTGOING, 'other'];

export const DECLINE_TEXT =
  'Jarvis does not forward questions to the owner. The owner only decides on money (and, depending on the settings, contracts, deletions ' +
  'and first contacts). Decide this yourself using the organisation profile, the goals and your ' +
  'own judgement, write your assumption in your journal, and proceed. If a piece of information is missing, find it or make the safest reasonable assumption.';

export const OTHER_TEXT =
  'There is no to-do list for the owner. Actions you can perform with your own tools (a web form, a directory listing, a document) you perform yourself, ' +
  'for example with the browser. If it needs a service Jarvis is not connected to, write it under "Needs a connector" in your journal and move on. ' +
  'Messages to people go through kind email, proposal or whatsapp, never "other".';
export const CALL_TEXT = 'Jarvis cannot place phone calls. Reach the person on WhatsApp or by email instead.';

// One sentence for prompts and the HUD describing what the owner currently approves.
export function approvalSentence(level = 'payments') {
  if (level === 'first_contact') return 'The owner approves money, contracts, deleting data and the first message to a new contact; everything else is automatic.';
  if (level === 'money') return 'The owner approves money, contracts and deleting data; every message is sent automatically.';
  return 'The owner approves payments and purchases only; every message is reviewed by Jarvis when the mission is delivered and then sent automatically.';
}

/**
 * Routes a proposed action.
 * @param {object} p
 * @param {string} p.kind            one of KINDS
 * @param {boolean} p.contactHasReplied  the recipient has replied to us before (same organisation)
 * @param {boolean} p.leaderCanApprove   the team's leader-approval switch
 * @param {boolean} [p.hasRecipient]     the action names a real recipient
 * @returns {{ route: 'owner' | 'leader' | 'auto' | 'decline', reason: string }}
 */
// Approval levels, chosen by the owner in Settings:
//   payments      only money comes to the owner; everything else is sent or done automatically (the owner's choice)
//   money         money, contracts and deletions come to the owner
//   first_contact money, contracts, deletions and the first message to a new contact
export const LEVELS = ['payments', 'money', 'first_contact'];

export function routeAction({ kind, summary = '', contactHasReplied = false, leaderCanApprove = false, hasRecipient = true, level = 'payments' }) {
  if (kind === 'payment' || kind === 'purchase') return { route: 'owner', reason: 'Money is always the owner’s call.' };
  if (OWNER_ONLY.has(kind)) {
    if (level === 'payments') return { route: 'auto', reason: 'The owner lets Jarvis handle contracts and deletions itself.' };
    return { route: 'owner', reason: 'Contracts and deletions come to the owner.' };
  }
  // Nothing is queued for the owner to do by hand: agents act with their own tools, and Jarvis has no phone.
  if (kind === 'other') return { route: 'decline', reason: looksLikeHandback(summary) || /\?\s*$/.test(summary) ? DECLINE_TEXT : OTHER_TEXT };
  if (kind === 'call') return { route: 'decline', reason: CALL_TEXT };
  if (OUTGOING.has(kind)) {
    if (!hasRecipient) return { route: 'decline', reason: 'An outgoing message needs a real recipient you actually found. Do not guess addresses.' };
    if (contactHasReplied) return { route: 'auto', reason: 'The contact has already replied, so the conversation continues without approval.' };
    if (level !== 'first_contact') return { route: 'auto', reason: 'The owner lets Jarvis send first contacts itself.' };
    if (leaderCanApprove) return { route: 'leader', reason: 'First contact: the team leader reviews it.' };
    return { route: 'owner', reason: 'First message to a new contact: the owner approves it.' };
  }
  return { route: 'decline', reason: DECLINE_TEXT };
}

// Deliverable sanity checks shared by the verifier: obvious placeholders mean the work is not finished.
const PLACEHOLDER = /\[(?:client|name|company|amount|owner name|your name|insert|tbd|placeholder)[^\]]*\]|lorem ipsum|xxx+|<insert/i;
export const hasPlaceholders = (text) => PLACEHOLDER.test(String(text ?? ''));

// Requests that are really the agent trying to hand its own work back ("confirm the list is complete", "allow file writes").
const HANDBACK = /\b(confirm|clarify|approve (?:the|this) (?:plan|approach)|allow (?:file )?writes|unblock|which (?:option|approach)|should (?:i|we)\b|please (?:advise|decide)|permission to)\b/i;
export const looksLikeHandback = (summary) => HANDBACK.test(String(summary ?? ''));
