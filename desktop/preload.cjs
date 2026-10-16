const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tryonDesktop", Object.freeze({
  status: () => ipcRenderer.invoke("setup:status"),
  save: (key) => ipcRenderer.invoke("setup:save", key),
  clear: () => ipcRenderer.invoke("setup:clear"),
  enter: () => ipcRenderer.invoke("setup:enter"),
  openOfficial: (page) => ipcRenderer.invoke("setup:official", page),
  openSettings: () => ipcRenderer.invoke("desktop:settings"),
}));
