const { app, Tray, Menu, shell, Notification, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const log = require("electron-log");
const terminalRegistryService = require("./src/services/terminalRegistry.service");
const reprocessStateService = require("./src/services/reprocessState.service");

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
let updateCheckInterval = null;
let autoInstallInterval = null;
let downloadedUpdate = null;

// How often a long-running bridge polls GitHub for a new release. It only
// checks on startup otherwise, so a 24/7 bridge would never see an update.
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000; // 6 hours
// Once an update is downloaded, how often we re-check for a safe window to
// apply it automatically (no reprocess in flight, no terminal online).
const AUTO_INSTALL_RETRY_MS = 15 * 60 * 1000; // 15 minutes

// Configure logging
log.transports.file.level = "info";
log.info("App starting...");

// Auto-updater configuration
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
// We control WHEN the update is applied (see applyUpdateIfSafe) so an install
// can never fire mid-EOD/reprocess. Leaving this true would let a downloaded
// update install on ANY app quit — possibly mid-day or mid-reprocess.
autoUpdater.autoInstallOnAppQuit = false;
// The OTA repo (utak-ayala-bridge) is PUBLIC, so electron-updater needs no
// credentials to read releases. We deliberately do NOT ship a GH_TOKEN with
// the client — a publish-time token (electron-builder.env) is enough.

autoUpdater.on("update-available", (info) => {
  log.info(`[Updater] Update available: v${info.version}`);
});
autoUpdater.on("update-not-available", () => {
  log.info("[Updater] App is up to date.");
});
autoUpdater.on("update-downloaded", (info) => {
  downloadedUpdate = info;
  log.info(
    `[Updater] v${info.version} downloaded — will apply when the bridge is idle (no reprocess, no terminal online) or via the tray "Restart & Update".`,
  );
  if (tray) buildAndSetTrayMenu(currentIP);
  new Notification({
    title: "Ayala Bridge — Update Ready",
    body: `v${info.version} downloaded. It will install automatically when idle, or choose "Restart & Update" from the tray menu.`,
  }).show();
  // Poll for a safe window so a continuously-running bridge applies it without
  // needing a manual restart.
  if (!autoInstallInterval) {
    autoInstallInterval = setInterval(
      () => applyUpdateIfSafe({ manual: false }),
      AUTO_INSTALL_RETRY_MS,
    );
  }
});
autoUpdater.on("error", (err) => {
  log.error("[Updater] Error:", err.message);
});

// True while any EOD reprocess window is still open (terminals may still be
// re-submitting; restarting now could interrupt the staged rebuild). Fails
// safe: if the state can't be read, treat it as busy and never install blindly.
function isReprocessBusy() {
  try {
    return reprocessStateService.listPending().length > 0;
  } catch (err) {
    log.warn("[Updater] Could not read reprocess state:", err.message);
    return true;
  }
}

function onlineDeviceCount() {
  try {
    return terminalRegistryService.listDevices().filter((d) => d.online).length;
  } catch (_) {
    return 0;
  }
}

// Applies a downloaded update ONLY when it is safe to restart the bridge.
// Guard order matters: an install never fires while an EOD reprocess is in
// flight. Automatic (non-manual) installs additionally wait until no POS
// terminal is online, so the restart is invisible to active registers; a
// manual tray click skips the online check (the operator chose to restart).
function applyUpdateIfSafe({ manual }) {
  if (!downloadedUpdate) {
    if (manual) {
      new Notification({
        title: "Ayala Bridge",
        body: "No update is ready to install yet.",
      }).show();
    }
    return false;
  }

  if (isReprocessBusy()) {
    log.info("[Updater] Install deferred — EOD reprocess in progress.");
    if (manual) {
      new Notification({
        title: "Ayala Bridge — Update Deferred",
        body: "An EOD reprocess is in progress. The update will apply once it finishes.",
      }).show();
    }
    return false;
  }

  if (!manual && onlineDeviceCount() > 0) {
    log.info(
      "[Updater] Auto-install deferred — terminal(s) still online; will retry.",
    );
    return false;
  }

  log.info(
    `[Updater] Applying v${downloadedUpdate.version} (${manual ? "manual" : "auto"}) — restarting bridge.`,
  );
  if (autoInstallInterval) {
    clearInterval(autoInstallInterval);
    autoInstallInterval = null;
  }
  app.isQuitting = true;
  // isSilent=true (no installer UI), isForceRunAfter=true (relaunch after).
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

// Builds and applies the tray context menu using the provided IP address.
function buildAndSetTrayMenu(localIP) {
  if (!tray) return;
  const devices = terminalRegistryService.listDevices();
  const onlineCount = devices.filter((device) => device.online).length;
  const deviceItems = devices.length
    ? devices.slice(0, 12).map((device) => ({
        label: `${device.online ? "Online" : "Offline"} | TER ${device.terNo} | ${device.deviceName} | ${device.lastSeenAtIso || "never"}`,
        enabled: false,
      }))
    : [{ label: "No POS devices seen yet", enabled: false }];

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Ayala Bridge v${app.getVersion()} - Running`,
      enabled: false,
    },
    { type: "separator" },
    { label: `IP: ${localIP}`, enabled: false },
    { label: `Port: ${PORT}`, enabled: false },
    {
      label: `Connected Devices (${onlineCount}/${devices.length})`,
      submenu: deviceItems,
    },
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
    ...(downloadedUpdate
      ? [
          {
            label: `Restart & Update to v${downloadedUpdate.version}`,
            click: () => applyUpdateIfSafe({ manual: true }),
          },
        ]
      : []),
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

    // A 24/7 bridge restarts rarely, so poll periodically — otherwise a
    // published release is only picked up on the next manual restart.
    updateCheckInterval = setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.warn("[Updater] Periodic update check failed:", err.message);
      });
    }, UPDATE_CHECK_MS);

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
          } else {
            buildAndSetTrayMenu(currentIP);
          }
        }, 30000);
      }
    } catch (trayError) {
      log.error("Failed to initialize system tray:", trayError);
    }

    // Post-update confirmation: if the running version differs from the one we
    // last recorded, the auto-updater applied an update since the last launch.
    // Skipped on first run / fresh install (no version recorded yet) so a new
    // install never shows a spurious "Updated" toast.
    const runningVersion = app.getVersion();
    const previousVersion = userConfig.lastVersion;
    if (previousVersion && previousVersion !== runningVersion) {
      new Notification({
        title: "Ayala Bridge — Updated",
        body: `Updated to v${runningVersion} (was v${previousVersion}). Running on http://${currentIP}:${PORT}`,
      }).show();
    } else {
      new Notification({
        title: "Ayala Bridge Started",
        body: `Bridge is running on http://${currentIP}:${PORT}`,
      }).show();
    }
    if (previousVersion !== runningVersion) {
      try {
        userConfig.lastVersion = runningVersion;
        fs.writeFileSync(
          configPath,
          JSON.stringify(userConfig, null, 2),
          "utf8",
        );
      } catch (err) {
        log.warn("[Updater] Could not persist version to config:", err.message);
      }
    }
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
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
  if (autoInstallInterval) {
    clearInterval(autoInstallInterval);
    autoInstallInterval = null;
  }
});
