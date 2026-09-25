// Pure helpers: parsing agent output and recognising subscription limits. No database imports.

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const clampPriority = (v, fallback = 50) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : fallback;
};

export const OUTGOING_KINDS = ['email', 'proposal', 'post', 'call', 'payment', 'contract', 'purchase', 'other'];

// Agents end their reply with one ```json block. Everything before it is the report.
export function parseAgentOutput(text) {
  const body = String(text ?? '');
  const fence = /```json\s*([\s\S]*?)```/gi;
  let last = null;
  for (let m = fence.exec(body); m; m = fence.exec(body)) last = m;
  let data = null;
  if (last) {
    try {
      data = JSON.parse(last[1]);
    } catch {
      data = null;
    }
  }
  const report = last ? (body.slice(0, last.index) + body.slice(last.index + last[0].length)).trim() : body.trim();
  const d = isObj(data) ? data : {};
  return {
    structured: isObj(data),
    report,
    summary: (str(d.summary) || report.split('\n').find((l) => l.trim()) || '').slice(0, 500),
    subtasks: arr(d.subtasks)
      .filter(isObj)
      .map((s) => ({
        assignee: str(s.assignee),
        title: str(s.title).slice(0, 200),
        instructions: str(s.instructions || s.prompt),
        priority: clampPriority(s.priority),
        // 1-based position of an earlier subtask in the same list that must finish first.
        after: Number.isInteger(Number(s.after)) && Number(s.after) > 0 ? Number(s.after) : null,
      }))
      .filter((s) => s.assignee && s.title && s.instructions),
    actions: arr(d.actions)
      .filter(isObj)
      .map((a) => ({
        kind: OUTGOING_KINDS.includes(str(a.kind || a.type)) ? str(a.kind || a.type) : 'other',
        summary: str(a.summary).slice(0, 500),
        details: isObj(a.details) ? a.details : {},
      }))
      .filter((a) => a.summary),
    memories: arr(d.memories).map(str).filter(Boolean).slice(0, 5).map((m) => m.slice(0, 500)),
    kpiUpdates: arr(d.kpi_updates || d.kpiUpdates)
      .filter(isObj)
      .map((k) => ({ name: str(k.name), add: Number(k.add), set: Number(k.set) }))
      .filter((k) => k.name && (Number.isFinite(k.add) || Number.isFinite(k.set))),
    goalUpdates: arr(d.goal_updates || d.goalUpdates)
      .filter(isObj)
      .map((g) => ({ title: str(g.title), progress: Math.min(100, Math.max(0, Math.round(Number(g.progress)))) }))
      .filter((g) => g.title && Number.isFinite(g.progress)),
  };
}

// Pulls the first JSON object out of a reply (used for structure proposals and leader decisions).
export function extractJson(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// Applied only to failed runs, so an agent writing about "rate limits" is never misread.
const LIMIT_RE =
  /usage limit|rate[ _-]?limit|limit (?:reached|exceeded)|quota|too many requests|\b429\b|overloaded|out of (?:credits|messages)/i;
export const looksLikeLimit = (text) => LIMIT_RE.test(String(text ?? ''));

export function parseResetTime(text, nowMs = Date.now()) {
  const s = String(text ?? '');
  const epoch = s.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const rel = s.match(/(?:try again|resets?|reset)\s+in\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (rel) return nowMs + Number(rel[1]) * (rel[2].toLowerCase().startsWith('h') ? 3_600_000 : 60_000);
  const clock = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === 'pm') hour += 12;
    const d = new Date(nowMs);
    d.setHours(hour, Number(clock[2] || 0), 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}
