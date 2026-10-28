// The window's only door into the app: bridge(action, arg) → main.js uiActions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", (action, arg) =>
  ipcRenderer.invoke("bridge", action, arg),
);
