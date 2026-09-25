// The only bridge between the Jarvis UI and Windows. Exposes a few narrow functions, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  onVoiceActivate(cb) {
    const handler = () => cb();
    ipcRenderer.on('voice:activate', handler);
    return () => ipcRenderer.removeListener('voice:activate', handler);
  },
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  setAutoStart: (on) => ipcRenderer.invoke('autostart:set', Boolean(on)),
  setThemeColor: (color) => ipcRenderer.send('theme:color', String(color)),
});
