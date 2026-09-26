// Quick status of the running Jarvis service: engines, queue, latest events, pending approvals.
// Usage: node scripts/status.mjs [org name fragment] [--events N]
const auth = await import('../service/auth.js');
const token = auth.createSession('status-script');
const H = { Authorization: `Bearer ${token}`, 'X-Jarvis': '1' };
const B = `http://127.0.0.1:${process.env.JARVIS_PORT || 7777}`;
const orgArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const eventsN = Number(process.argv[process.argv.indexOf('--events') + 1]) || 8;
const get = async (p) => (await fetch(B + p, { headers: H })).json();
try {
  const orgs = await get('/api/orgs');
  const org = orgArg ? orgs.find((o) => o.name.toLowerCase().includes(orgArg.toLowerCase())) : orgs[0];
  const o = await get(`/api/overview${org ? `?org=${org.id}` : ''}`);
  console.log(`org: ${org?.name ?? '(personal)'} | paused: ${o.paused} | autonomy: ${o.autonomy} | queued: ${o.queued} | running: ${o.running} | pending approvals: ${o.pendingTotal}`);
  for (const e of o.engines) console.log(`  ${e.name.padEnd(6)} enabled=${e.enabled} running=${e.running}/${e.maxConcurrent} cooldown=${e.cooldownUntil ? new Date(e.cooldownUntil).toLocaleTimeString() : '-'} available=${e.available}`);
  if (o.plan) console.log(`plan (${o.plan.mode}, ${new Date(o.plan.at).toLocaleTimeString()}): ${o.plan.text.slice(0, 400)}`);
  if (org) {
    const tasks = await get(`/api/tasks?org=${org.id}&limit=40`);
    const open = tasks.filter((t) => ['queued', 'running'].includes(t.status));
    console.log(`missions: ${open.length} open`);
    for (const t of open.slice(0, 12)) console.log(`  #${t.id} ${t.status.padEnd(7)} ${(t.kind || '').padEnd(8)} ${(t.agent_name || '').padEnd(8)} ${t.title.slice(0, 60)}${t.live_status ? ` — ${t.live_status.slice(0, 60)}` : ''}`);
    const act = await get(`/api/activity?org=${org.id}&limit=${eventsN}`);
    console.log('activity:');
    for (const a of act) console.log(`  ${new Date(a.ts).toLocaleTimeString()} ${a.agent}: ${a.text.slice(0, 110)}`);
  }
  const ev = await get(`/api/events${org ? `?org=${org.id}` : ''}`);
  console.log('events:');
  for (const e of ev.slice(0, eventsN)) console.log(`  ${new Date(e.ts).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.message.slice(0, 120)}`);
} finally {
  await fetch(`${B}/api/logout`, { method: 'POST', headers: H });
}
