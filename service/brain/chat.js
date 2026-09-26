// "Talk to Jarvis": one persistent, resumable conversation per workspace, so Jarvis remembers what you
// discussed and can act (create missions, answer from the live state). Typed or spoken.
import { one, run, insert, now, getSetting } from '../db.js';
import { log } from '../events.js';
import { runSession } from './runtime.js';
import { jarvisTools } from './tools.js';
import { writeClaudeMd } from './workspace.js';
import { createMission } from './missions.js';
import { situation } from './operator.js';

const sessionKey = (scope) => (scope.orgId ? `chat:org:${scope.orgId}` : 'chat:personal');

export function resetConversation(scope) {
  run('DELETE FROM sessions_sdk WHERE key = ?', sessionKey(scope));
}

export async function chat({ scope, text, spoken = false, signal }) {
  const orgId = scope.orgId ?? null;
  const jarvis = orgId ? one(`SELECT * FROM agents WHERE org_id = ? AND tier = 'jarvis'`, orgId) : one(`SELECT * FROM agents WHERE org_id IS NULL AND tier = 'jarvis'`);
  const root = writeClaudeMd(scope);
  const key = sessionKey(scope);
  const existing = one('SELECT session_id FROM sessions_sdk WHERE key = ?', key);
  const state = orgId ? situation(orgId) : `PERSONAL PROJECTS:\n${(one(`SELECT COUNT(*) AS n FROM projects WHERE org_id IS NULL AND status = 'active'`)?.n ?? 0)} active`;
  const tools = jarvisTools({ scope, task: null, agent: { ...(jarvis ?? { name: 'Jarvis', role: 'Chief of Staff', org_id: orgId }), tier: 'operator' }, hooks: { createMission: (spec) => createMission({ ...spec, createdBy: 'Jarvis (chat)' }) } });

  const prompt = `${existing ? '' : 'This is the start of an ongoing conversation with the owner.\n\n'}STATE NOW (for reference; do not read it aloud):\n${state}\n\nOWNER SAYS: ${text}`;
  const attempt = (resume) =>
    runSession({
      cwd: root,
      prompt,
      append: `You are Jarvis, the owner's AI chief of staff, in a live conversation. ${spoken ? 'Your reply will be read aloud: 1 to 4 natural sentences, no lists, no markdown.' : 'Reply briefly and naturally; short lists are fine.'} Use the real state; never invent numbers. When the owner asks for work to be done, create it with the delegate tool (department:<name> or team:<name>) and confirm in one sentence; do not describe a plan instead of creating it. You never ask the owner to make decisions for you; you may ask a single clarifying question only when the request is genuinely ambiguous.`,
      model: 'sonnet',
      maxTurns: 15,
      maxBudgetUsd: 1,
      timeoutMs: 4 * 60_000,
      mcpServers: { jarvis: tools },
      disallowedTools: ['Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'Bash'],
      resume,
      signal,
    });

  let res = await attempt(existing?.session_id);
  // A stale or unknown session id: start a fresh conversation rather than failing.
  if (!res.ok && existing && /session|resume|not found/i.test(res.error)) {
    resetConversation(scope);
    res = await attempt(undefined);
  }
  if (!res.ok) {
    log('warn', `Chat failed: ${res.error.slice(0, 160)}`, orgId);
    return { reply: res.limited ? 'My engines are at their usage limit right now; I will be back when it resets.' : 'I could not process that just now. Please try again.', ok: false };
  }
  if (res.sessionId) {
    run('INSERT INTO sessions_sdk (key, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at', key, res.sessionId, now());
  }
  insert('INSERT INTO activity (ts, org_id, task_id, agent, kind, text) VALUES (?, ?, NULL, ?, ?, ?)', now(), orgId, 'Jarvis', 'chat', `Owner: ${text.slice(0, 120)}`);
  return { reply: res.text.trim(), ok: true };
}
