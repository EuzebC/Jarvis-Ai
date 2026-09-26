// Checks the running service: approval level, organisation folders, WhatsApp webhook. Usage: node scripts/check-connectors.mjs
const auth = await import('../service/auth.js');
const token = auth.createSession('probe-script');
const H = { Authorization: `Bearer ${token}`, 'X-Jarvis': '1', 'Content-Type': 'application/json' };
const B = `http://127.0.0.1:${process.env.JARVIS_PORT || 7777}`;
const get = async (p) => (await fetch(B + p, { headers: H })).json();
try {
  const settings = await get('/api/settings');
  console.log('approval_level:', settings.approval_level, '|', settings.approval_sentence);
  const orgs = await get('/api/orgs');
  for (const o of orgs) {
    const full = await get(`/api/orgs/${o.id}`);
    console.log(`org ${o.id} ${o.name}: folder = ${full.folder} | workspace_path = ${full.workspace_path}`);
  }
  const conn = await get('/api/connectors');
  console.log('whatsapp:', JSON.stringify({ connected: conn.whatsapp.connected, webhook: conn.whatsapp.webhookPath, verifyToken: conn.whatsapp.verifyToken ? 'set' : 'missing', template: conn.whatsapp.template }));
  const hook = await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${conn.whatsapp.verifyToken}&hub.challenge=12345`);
  console.log('webhook verify:', hook.status, await hook.text());
  const bad = await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  console.log('webhook wrong token:', bad.status);
  const post = await fetch(`${B}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: [] }) });
  console.log('webhook empty post:', post.status);
  const sug = await get('/api/orgs/folder-suggestion?name=Test%20Org');
  console.log('suggestion:', sug.folder);
  const ev = await get('/api/events');
  for (const e of ev.slice(0, 6)) console.log(`  ${new Date(e.ts).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.message.slice(0, 140)}`);
} finally {
  await fetch(`${B}/api/logout`, { method: 'POST', headers: H });
}
