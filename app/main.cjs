// Jarvis for Windows. The window is only a control panel: the Jarvis service runs as its own
// background process, so agents keep working when the window is closed or the app quits.
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.JARVIS_PORT || 7777);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Jarvis');
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function healthy() {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN}/healthz`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => (req.destroy(), resolve(false)));
  });
}

// Starts the service with Electron's own Node, detached so it outlives the window.
async function ensureService() {
  if (await healthy()) return true;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'service', 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return true;
  }
  return false;
}

function stopService() {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA_DIR, 'service.pid'), 'utf8'));
    if (pid) process.kill(pid);
  } catch {
    // not running
  }
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: 'Jarvis',
    backgroundColor: '#020605',
    icon: path.join(__dirname, 'icons', 'icon.png'),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#020605', symbolColor: '#39e58c', height: 64 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL(ORIGIN);
  win.once('ready-to-show', () => !startHidden && win.show());
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
  // Links an agent put in a report open in the normal browser, never inside Jarvis.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icons', 'tray.png')));
  tray.setToolTip('Jarvis');
  tray.on('click', showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Jarvis', click: showWindow },
      { label: 'Talk to Jarvis (Ctrl+Space)', click: activateVoice },
      { type: 'separator' },
      { label: 'Close window (agents keep working)', click: () => ((quitting = true), app.quit()) },
      { label: 'Quit and stop all agents', click: () => ((quitting = true), stopService(), app.quit()) },
    ]),
  );
}

function activateVoice() {
  showWindow();
  win?.webContents.send('voice:activate');
}

ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (e, on) => {
  const args = app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'];
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args });
  return on;
});
ipcMain.on('theme:color', (e, color) => {
  if (win && /^#[0-9a-f]{6}$/i.test(color)) win.setTitleBarOverlay({ color: '#020605', symbolColor: color, height: 64 });
});

app.whenReady().then(async () => {
  // Microphone for the wake word; everything else is refused.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write');

  // First run: start with Windows so the agents keep working after a restart.
  const firstRunFlag = path.join(app.getPath('userData'), 'first-run-done');
  if (!fs.existsSync(firstRunFlag) && !process.env.JARVIS_SKIP_AUTOSTART) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'] });
    fs.mkdirSync(path.dirname(firstRunFlag), { recursive: true });
    fs.writeFileSync(firstRunFlag, new Date().toISOString());
  }

  createTray();
  const ok = await ensureService();
  if (!ok) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Jarvis', `The Jarvis service did not start. Check that port ${PORT} is free, then open Jarvis again.`);
  }
  createWindow();
  if (!globalShortcut.register('Control+Space', activateVoice)) console.warn('Ctrl+Space is used by another app');
});

app.on('window-all-closed', (e) => e.preventDefault()); // stay in the tray
app.on('will-quit', () => globalShortcut.unregisterAll());
