const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['settings', 'note-saved'];

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  setText: (text) => ipcRenderer.send('note-text', text),
  flush: () => ipcRenderer.send('note-flush'),
  widgetMenu: () => ipcRenderer.send('widget-menu'),
  resizeStart: () => ipcRenderer.send('widget-resize-start'),
  resizeMove: (edge, dx, dy) => ipcRenderer.send('widget-resize-move', { edge, dx, dy }),
  resizeEnd: () => ipcRenderer.send('widget-resize-end'),
  on: (channel, callback) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => callback(data));
  },
});
