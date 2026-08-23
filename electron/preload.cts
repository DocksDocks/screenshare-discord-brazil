import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("golive", {
  status: () => ipcRenderer.invoke("golive:status"),
  install: () => ipcRenderer.invoke("golive:install"),
  repair: () => ipcRenderer.invoke("golive:repair"),
  uninstall: () => ipcRenderer.invoke("golive:uninstall"),
  license: () => ipcRenderer.invoke("golive:license"),
});
