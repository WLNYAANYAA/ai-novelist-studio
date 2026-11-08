const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winAPI', {
  setAlwaysOnTop: (v) => ipcRenderer.send('always-on-top', !!v),
  getAlwaysOnTop: () => ipcRenderer.invoke('always-on-top:get'),
  setGlobalHotkeys: (list) => ipcRenderer.invoke('hotkeys:set', list),
  onHotkey: (cb) => ipcRenderer.on('hotkey:fire', (e, combo) => cb(combo))
});
