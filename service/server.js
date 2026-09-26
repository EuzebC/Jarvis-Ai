import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { all, one } from './db.js';
import { log, pruneEvents } from './events.js';
import * as auth from './auth.js';
import { routes, send, HttpError } from './http.js';
import './routes.js';
import { scheduler, createMission } from './brain/missions.js';
import { operatorTick, wakeOperator } from './brain/operator.js';
import { ensurePersonalAgents, ensureOrgJarvis } from './agents.js';
import { deliverQueued, checkReplies, followUp, migratePendingActions } from './outbox.js';
import { adoptFolders } from './brain/workspace.js';
import { resumeTunnel, stopTunnel } from './remote.js';
import { attachLiveVoice } from './voice/live.js';
import { syncMinds, writeBriefing } from './connectors/obsidian.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function securityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(config.uiDir, rel);
  if (!file.startsWith(config.uiDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (!path.extname(rel) && fs.existsSync(path.join(config.uiDir, 'index.html'))) return serveStatic(req, res, '/');
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found. Build the app first: npm run build:ui');
    return;
  }
  const hashed = rel.startsWith('assets/');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, pathname);
  }
  const match = routes.map((r) => ({ r, m: r.method === req.method && pathname.match(r.regex) })).find((x) => x.m);
  if (!match) return send(res, 404, { error: 'Not found' });

  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
  const token = bearer || cookies(req).jarvis_session;
  const authed = auth.validSession(token);
  if (!match.r.open && !authed) return send(res, 401, { error: 'Sign in required' });
  // CSRF: cookie-authenticated writes must carry a header browsers never add cross-site.
  // Webhooks (signed by the sender) are the only writes allowed without it.
  if (!bearer && req.method !== 'GET' && !match.r.webhook && req.headers['x-jarvis'] !== '1') return send(res, 403, { error: 'Missing X-Jarvis header' });

  const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m[i + 1])]));
  try {
    await match.r.handler(req, res, { params, query: url.searchParams, token, authed });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) log('error', `API error ${req.method} ${pathname}: ${err.stack || err.message}`);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : err.message });
  }
}

ensurePersonalAgents();
for (const o of all('SELECT id FROM orgs')) ensureOrgJarvis(o.id);
for (const [name, folder] of adoptFolders()) log('info', `${name} now works in ${folder}`);
const migrated = migratePendingActions();
if (migrated) log('info', `${migrated} waiting item(s) brought in line with the current policy`);

const server = http.createServer((req, res) => handle(req, res).catch(() => !res.headersSent && send(res, 500, { error: 'Internal error' })));
attachLiveVoice(server);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is busy: Jarvis is probably already running.`);
    process.exit(0);
  }
  throw err;
});
server.listen(config.port, config.host, () => {
  log('info', `Jarvis service online at http://${config.host}:${config.port} (data: ${config.dataDir})`);
  fs.writeFileSync(path.join(config.dataDir, 'service.pid'), String(process.pid));
  scheduler.start();
  // Outbox: send queued emails every minute; check Gmail for replies every 5 minutes.
  setInterval(() => deliverQueued().catch((err) => log('error', `Outbox: ${err.message}`)), 60_000).unref();
  const onReply = (sentMail, reply) => followUp({ orgId: sentMail.org_id, teamId: sentMail.team_id, channel: 'email', from: reply.from, subject: sentMail.subject, text: reply.text }).catch((err) => log('warn', `Reply follow-up: ${err.message}`));
  setInterval(() => checkReplies({ onReply }), 5 * 60_000).unref();
  // The Operator: morning plan, mid-day check, end-of-day review, for every organisation.
  setInterval(() => operatorTick().catch((err) => log('warn', `Operator tick: ${err.message}`)), 5 * 60_000).unref();
  setTimeout(() => operatorTick().catch(() => {}), 20_000).unref();
  // Obsidian: refresh the mind notes and write the daily briefing (once a day, after 7:00).
  const obsidianTick = () => {
    try {
      syncMinds();
      writeBriefing();
    } catch (err) {
      log('warn', `Obsidian: ${err.message}`);
    }
  };
  obsidianTick();
  setInterval(obsidianTick, 5 * 60_000).unref();
  pruneEvents();
  setInterval(pruneEvents, 86_400_000).unref();
  resumeTunnel();
});

function shutdown() {
  scheduler.stop();
  stopTunnel();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
