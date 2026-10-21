const { contextBridge, ipcRenderer } = require('electron');
const names = ['settings', 'saveSettings', 'testModel', 'openExternal', 'copyText', 'discover', 'connect', 'sessions', 'statistics', 'messages', 'context', 'refreshChat', 'ask', 'import', 'demo', 'directory', 'exportReport', 'exportChat', 'cancel'];
contextBridge.exposeInMainWorld('scope', Object.fromEntries([
  ...names.map(name => [name, args => ipcRenderer.invoke('scope:' + name, args)]),
  ['onProgress', callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('progress', listener); return () => ipcRenderer.removeListener('progress', listener); }],
]));
