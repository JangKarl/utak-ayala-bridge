const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("pairing", {
  list: () => ipcRenderer.invoke("ayala-pairing", "list"),
  invite: ccode => ipcRenderer.invoke("ayala-pairing", "invite", ccode),
  revoke: id => ipcRenderer.invoke("ayala-pairing", "revoke", id),
});
