const { app, Tray, Menu, shell, Notification } = require("electron");
const path = require("path");
const log = require("electron-log");
const { startServer, getLocalIPAddress, UPLOADS_DIR, PORT } = require("./bridge");

let tray = null;

// Configure logging
log.transports.file.level = "info";
log.info("App starting...");

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (tray) {
      new Notification({
        title: "Ayala Bridge",
        body: "Bridge is already running in the taskbar."
      }).show();
    }
  });

  app.whenReady().then(() => {
    // Start the Express server
    try {
      startServer();
      log.info("Bridge server started successfully.");
    } catch (err) {
      log.error("Failed to start bridge server:", err);
      app.quit();
    }

    // Create system tray
    const localIP = getLocalIPAddress();
    const iconPath = path.join(__dirname, "assets", "icon.ico");
    
    try {
      if (!require("fs").existsSync(iconPath)) {
        log.warn(`Tray icon not found at ${iconPath}. Skipping tray creation.`);
      } else {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
          { label: `Ayala Bridge v${app.getVersion()} - Running`, enabled: false },
          { type: "separator" },
          { label: `IP: ${localIP}`, enabled: false },
          { label: `Port: ${PORT}`, enabled: false },
          { type: "separator" },
          { 
            label: "Open Uploads Folder", 
            click: () => shell.openPath(UPLOADS_DIR) 
          },
          { 
            label: "View Logs", 
            click: () => shell.openPath(path.dirname(log.transports.file.getFile().path)) 
          },
          { type: "separator" },
          { 
            label: "Quit Bridge", 
            click: () => {
              app.isQuitting = true;
              app.quit();
            } 
          }
        ]);

        tray.setToolTip("Ayala Bridge");
        tray.setContextMenu(contextMenu);
      }
    } catch (trayError) {
      log.error("Failed to initialize system tray:", trayError);
    }

    new Notification({
      title: "Ayala Bridge Started",
      body: `Bridge is running on http://${localIP}:${PORT}`
    }).show();
  });
}

// Keep the app running even if all windows are closed
app.on("window-all-closed", (e) => {
  e.preventDefault();
});
