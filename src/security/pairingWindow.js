const { BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const QRCode = require("qrcode");
let window;

function showPairingWindow(security, getIP) {
  if (window) { window.focus(); return; }
  window = new BrowserWindow({
    width: 620, height: 800, useContentSize: true, autoHideMenuBar: true, backgroundColor: "#fafafa", title: "Pair a POS",
    webPreferences: { preload: path.join(__dirname, "pairingPreload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  ipcMain.handle("ayala-pairing", async (event, action, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Invalid pairing window.");
    if (action === "list") return security.devices();
    if (action === "invite") {
      const { code, ...invitation } = security.invite(value, getIP());
      return { qr: await QRCode.toDataURL(JSON.stringify(invitation)), code, expiresAt: invitation.expiresAt };
    }
    if (action === "revoke" && typeof value === "string") { security.revoke(value); return security.devices(); }
    throw new Error("Invalid pairing action.");
  });
  window.on("closed", () => { security.cancelInvitation(); ipcMain.removeHandler("ayala-pairing"); window = null; });
  window.loadFile(path.join(__dirname, "pairing.html"));
}
module.exports = { showPairingWindow };
