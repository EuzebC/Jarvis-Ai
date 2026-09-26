// The escalation policy: what agents may do alone, what a team leader may approve,
// and the few things that always come to the owner. Pure logic, no database access, so it is easy to test.
//
// Owner decisions were fixed by the owner: money (payments, purchases), contracts, deletions of data,
// and the FIRST outgoing message to a new contact. Later messages to a contact who has replied are
// sent automatically. Everything else is the agents' job to decide; asking the owner is refused.

export const OWNER_ONLY = new Set(['payment', 'purchase', 'contract', 'deletion']);
export const OUTGOING = new Set(['email', 'proposal', 'post', 'call']);
export const KINDS = [...OWNER_ONLY, ...OUTGOING, 'other'];

export const DECLINE_TEXT =
  'Jarvis does not forward questions to the owner. The owner only decides on money, contracts, deleting data, ' +
  'and the first message to a new contact. Decide this yourself using the organisation profile, the goals and your ' +
  'own judgement, write your assumption in your journal, and proceed. If a piece of information is missing, find it or make the safest reasonable assumption.';

/**
 * Routes a proposed action.
 * @param {object} p
 * @param {string} p.kind            one of KINDS
 * @param {boolean} p.contactHasReplied  the recipient has replied to us before (same organisation)
 * @param {boolean} p.leaderCanApprove   the team's leader-approval switch
 * @param {boolean} [p.hasRecipient]     the action names a real recipient
 * @returns {{ route: 'owner' | 'leader' | 'auto' | 'decline', reason: string }}
 */
export function routeAction({ kind, summary = '', contactHasReplied = false, leaderCanApprove = false, hasRecipient = true }) {
  if (OWNER_ONLY.has(kind)) return { route: 'owner', reason: 'Money, contracts and deletions are always the owner’s call.' };
  // "other" is for real actions Jarvis cannot carry out itself (a form to submit, a call to place), never for questions.
  if (kind === 'other') {
    if (looksLikeHandback(summary) || /\?\s*$/.test(summary)) return { route: 'decline', reason: DECLINE_TEXT };
    return { route: 'owner', reason: 'An action outside Jarvis’s tools; the owner carries it out.' };
  }
  if (OUTGOING.has(kind)) {
    if (!hasRecipient) return { route: 'decline', reason: 'An outgoing message needs a real recipient you actually found. Do not guess addresses.' };
    if (contactHasReplied) return { route: 'auto', reason: 'The contact has already replied, so the conversation continues without approval.' };
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
