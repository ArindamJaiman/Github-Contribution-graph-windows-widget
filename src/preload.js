const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getData: () => ipcRenderer.invoke('get-data'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  fetchContributions: () => ipcRenderer.invoke('fetch-contributions'),
  closeApp: () => ipcRenderer.send('close-app'),
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
  onTriggerRefresh: (callback) => ipcRenderer.on('trigger-refresh', callback),
  onClickThroughChanged: (callback) => ipcRenderer.on('click-through-changed', (_, val) => callback(val))
});
