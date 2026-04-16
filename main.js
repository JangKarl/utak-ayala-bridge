const { app, Tray, Menu, shell, Notification, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const log = require("electron-log");

// Resolve .env path explicitly — avoids process.cwd() issues when launched
// via auto-start, scheduler, or shortcuts (CWD may be C:\Windows\System32).
const envPath = app.isPackaged
  ? path.join(path.dirname(process.execPath), ".env")
  : path.join(__dirname, ".env");
const dotenvResult = require("dotenv").config({ path: envPath });
if (dotenvResult.error) {
  log.warn(
    `[Config] .env not loaded from ${envPath}: ${dotenvResult.error.message}`,
  );
}

// Load persisted user config before requiring bridge (so env vars are set first)
const configPath = path.join(app.getPath("userData"), "config.json");
let userConfig = {};
try {
  userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (_) {
  // No config file yet — use defaults
}
if (userConfig.uploadsDir) {
  process.env.UPLOADS_DIR = userConfig.uploadsDir;
}

const {
  startServer,
  restartJobs,
  getLocalIPAddress,
  UPLOADS_DIR,
  PORT,
} = require("./bridge");

let tray = null;
let currentIP = null;
let ipWatcherInterval = null;

// Configure logging
log.transports.file.level = "info";
log.info("App starting...");

// Auto-updater configuration
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.requestHeaders = {
  Authorization: `token ${process.env.GH_TOKEN || "REMOVED_GH_TOKEN"}`,
};

autoUpdater.on("update-available", (info) => {
  log.info(`[Updater] Update available: v${info.version}`);
});
autoUpdater.on("update-not-available", () => {
  log.info("[Updater] App is up to date.");
});
autoUpdater.on("update-downloaded", (info) => {
  log.info(
    `[Updater] v${info.version} downloaded — will install on next quit.`,
  );
});
autoUpdater.on("error", (err) => {
  log.error("[Updater] Error:", err.message);
});

// Builds and applies the tray context menu using the provided IP address.
function buildAndSetTrayMenu(localIP) {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Ayala Bridge v${app.getVersion()} - Running`,
      enabled: false,
    },
    { type: "separator" },
    { label: `IP: ${localIP}`, enabled: false },
    { label: `Port: ${PORT}`, enabled: false },
    { type: "separator" },
    {
      label: "Open Uploads Folder",
      click: () => shell.openPath(UPLOADS_DIR),
    },
    {
      label: userConfig.uploadsDir
        ? `Dir: ${userConfig.uploadsDir}`
        : "Dir: (default)",
      enabled: false,
    },
    {
      label: "Select Directory",
      click: async () => {
        const result = await dialog.showOpenDialog({
          title: "Select Uploads Directory",
          defaultPath: UPLOADS_DIR,
          properties: ["openDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return;
        const selectedDir = result.filePaths[0];
        try {
          fs.writeFileSync(
            configPath,
            JSON.stringify({ ...userConfig, uploadsDir: selectedDir }, null, 2),
            "utf8",
          );
          new Notification({
            title: "Ayala Bridge",
            body: "Uploads directory updated. Restarting to apply changes...",
          }).show();
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 1500);
        } catch (err) {
          log.error("Failed to save directory config:", err);
        }
      },
    },
    {
      label: "View Logs",
      click: () =>
        shell.openPath(path.dirname(log.transports.file.getFile().path)),
    },
    { type: "separator" },
    {
      label: "Refresh IP",
      click: () => {
        const newIP = getLocalIPAddress();
        if (newIP !== currentIP) {
          log.info(`IP changed (manual refresh): ${currentIP} → ${newIP}`);
          currentIP = newIP;
          buildAndSetTrayMenu(newIP);
          new Notification({
            title: "Ayala Bridge — IP Updated",
            body: `New IP: http://${newIP}:${PORT}\nUpdate your POS configuration.`,
          }).show();
        } else {
          new Notification({
            title: "Ayala Bridge",
            body: `IP unchanged: http://${newIP}:${PORT}`,
          }).show();
        }
      },
    },
    {
      label: "Sync Time",
      click: () => {
        restartJobs();
        new Notification({
          title: "Ayala Bridge",
          body: "Time synced — cron job has been restarted.",
        }).show();
      },
    },
    {
      label: "Check for Updates",
      click: () => {
        autoUpdater.checkForUpdates().catch((err) => {
          log.error("[Updater] Manual update check failed:", err.message);
        });
      },
    },
    { type: "separator" },
    {
      label: "Quit Bridge",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Ayala Bridge");
  tray.setContextMenu(contextMenu);
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (tray) {
      new Notification({
        title: "Ayala Bridge",
        body: "Bridge is already running in the taskbar.",
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

    // Check for updates silently on startup
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      log.warn("[Updater] Update check skipped:", err.message);
    }

    // Create system tray
    currentIP = getLocalIPAddress();
    const iconPath = path.join(__dirname, "assets", "icon.ico");

    try {
      if (!fs.existsSync(iconPath)) {
        log.warn(`Tray icon not found at ${iconPath}. Skipping tray creation.`);
      } else {
        tray = new Tray(iconPath);
        buildAndSetTrayMenu(currentIP);

        // Background watcher — checks for IP changes every 30 seconds
        ipWatcherInterval = setInterval(() => {
          const newIP = getLocalIPAddress();
          if (newIP !== currentIP) {
            log.info(`IP changed (auto-detected): ${currentIP} → ${newIP}`);
            currentIP = newIP;
            buildAndSetTrayMenu(newIP);
            new Notification({
              title: "Ayala Bridge — IP Changed",
              body: `New IP: http://${newIP}:${PORT}\nUpdate your POS configuration.`,
            }).show();
          }
        }, 30000);
      }
    } catch (trayError) {
      log.error("Failed to initialize system tray:", trayError);
    }

    new Notification({
      title: "Ayala Bridge Started",
      body: `Bridge is running on http://${currentIP}:${PORT}`,
    }).show();
  });
}

// Keep the app running even if all windows are closed
app.on("window-all-closed", (e) => {
  e.preventDefault();
});

// Clean up IP watcher on quit
app.on("before-quit", () => {
  if (ipWatcherInterval) {
    clearInterval(ipWatcherInterval);
    ipWatcherInterval = null;
  }
});
