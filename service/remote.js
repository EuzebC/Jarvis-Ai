// Remote access: Jarvis runs a tunnel (cloudflared or ngrok) so the HUD, and the WhatsApp webhook,
// are reachable from the owner's phone. The public URL is read from the tunnel's own output and kept
// in the settings; the tunnel is restarted if it dies.
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { log, notify } from './events.js';

let child = null;
let wanted = false;
let restartTimer = null;
let backoff = 5_000;
let lastError = '';
let lastOutput = [];

const URL_RE = /https:\/\/[a-z0-9.-]+\.(?:trycloudflare\.com|ngrok(?:-free)?\.(?:app|dev|io)|cfargotunnel\.com)[^\s"'|]*/i;
export const defaultCommand = () => `cloudflared tunnel --url http://127.0.0.1:${config.port}`;

export function remoteStatus() {
  return {
    enabled: getSetting('remote_enabled', '0') === '1',
    running: Boolean(child && child.exitCode === null),
    command: getSetting('tunnel_cmd', '') || defaultCommand(),
    publicUrl: getSetting('public_url', ''),
    lastError,
    output: lastOutput.slice(-6),
  };
}

function remember(line) {
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return;
  lastOutput.push(clean.slice(0, 200));
  if (lastOutput.length > 40) lastOutput.shift();
  const url = clean.match(URL_RE)?.[0]?.replace(/\/+$/, '');
  if (url && url !== getSetting('public_url', '')) {
    setSetting('public_url', url);
    log('info', `Remote access ready at ${url}`);
    notify('settings');
  }
}

export function startTunnel() {
  wanted = true;
  clearTimeout(restartTimer);
  if (child && child.exitCode === null) return remoteStatus();
  const command = getSetting('tunnel_cmd', '') || defaultCommand();
  lastError = '';
  try {
    child = spawn(command, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    lastError = err.message;
    return remoteStatus();
  }
  log('info', `Remote access: starting tunnel (${command})`);
  const onData = (buf) => String(buf).split(/\r?\n/).forEach(remember);
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    const failedFast = Date.now() - startedAt < 10_000;
    if (failedFast && (code === 1 || code === 9009 || code === 127)) lastError = /not recognized|not found|command not found|9009/i.test(lastOutput.join(' ')) || code === 9009 || code === 127 ? 'The tunnel program is not installed. Install cloudflared (button below) or paste another tunnel command.' : `The tunnel exited with code ${code}: ${lastOutput.slice(-2).join(' | ')}`;
    child = null;
    notify('settings');
    if (!wanted) return;
    restartTimer = setTimeout(() => startTunnel(), backoff);
    backoff = Math.min(backoff * 2, 120_000);
  });
  const startedAt = Date.now();
  setTimeout(() => {
    if (child && child.exitCode === null) backoff = 5_000;
  }, 30_000).unref();
  return remoteStatus();
}

export function stopTunnel() {
  wanted = false;
  clearTimeout(restartTimer);
  if (child && child.exitCode === null) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    } catch {
      // already gone
    }
  }
  child = null;
  log('info', 'Remote access: tunnel stopped');
  notify('settings');
  return remoteStatus();
}

// Installs cloudflared with winget (Windows). Resolves with the last lines of output.
export function installCloudflared() {
  return new Promise((resolve) => {
    const out = [];
    const p = spawn('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], { windowsHide: true, shell: true });
    const onData = (b) => out.push(...String(b).split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean));
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (err) => resolve({ ok: false, message: `winget is not available: ${err.message}` }));
    p.on('exit', (code) => resolve({ ok: code === 0, message: code === 0 ? 'cloudflared installed. Open a new terminal for the PATH change, or just switch remote access on: Jarvis finds it.' : `winget exited with code ${code}: ${out.slice(-3).join(' | ')}` }));
  });
}

// Called at start: resume the tunnel if the owner left it on.
export function resumeTunnel() {
  if (getSetting('remote_enabled', '0') === '1') startTunnel();
}
