const { app, Tray, Menu, shell, Notification, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const https = require("https");
const log = require("electron-log");

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

const CLOUD_FUNCTION_URL =
  "https://us-central1-posfire-8d2cb.cloudfunctions.net/mall-ayala-updateBridgeIP";

/**
 * Pushes the current IP address to Firebase RTDB via the Cloud Function.
 * Silently no-ops if email/eodPin are not yet configured.
 */
async function pushIPToFirebase(newIP) {
  const { firebaseEmail, firebaseEodPin } = userConfig;
  if (!firebaseEmail || !firebaseEodPin) return;

  const payload = JSON.stringify({
    email: firebaseEmail,
    newIP,
    eodPin: firebaseEodPin,
  });

  return new Promise((resolve) => {
    const req = https.request(
      CLOUD_FUNCTION_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            log.info(`[Firebase Sync] IP pushed: ${newIP}`);
          } else {
            log.warn(`[Firebase Sync] Failed (${res.statusCode}): ${body}`);
          }
          resolve();
        });
      },
    );
    req.on("error", (err) => {
      log.warn(`[Firebase Sync] Network error: ${err.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// Configure logging
log.transports.file.level = "info";
log.info("App starting...");

// Auto-updater configuration
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

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
  const { clipboard } = require("electron");

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
    // Firebase account sync — status label
    {
      label: userConfig.firebaseEmail
        ? `Account: ${userConfig.firebaseEmail}`
        : "Account: (not configured)",
      enabled: false,
    },
    {
      // Clipboard-paste flow: user copies email → pastes, then copies eodPin → pastes.
      // Electron has no native text input dialog; this is the standard lightweight approach.
      label: "Set Account…",
      click: async () => {
        const step1 = await dialog.showMessageBox({
          type: "question",
          title: "Set Account — Step 1 of 2",
          message:
            "Copy your UTAK account email to the clipboard, then click Paste.",
          detail: `Current: ${userConfig.firebaseEmail || "(not set)"}`,
          buttons: ["Paste from Clipboard", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (step1.response !== 0) return;

        const email = clipboard.readText().trim();
        if (!email || !email.includes("@")) {
          await dialog.showMessageBox({
            type: "error",
            title: "Invalid Email",
            message: `"${email}" is not a valid email address.\nCopy your email to the clipboard and try again.`,
            buttons: ["OK"],
          });
          return;
        }

        const step2 = await dialog.showMessageBox({
          type: "question",
          title: "Set Account — Step 2 of 2",
          message:
            "Copy your EOD PIN to the clipboard, then click Paste.\n\n(This is the PIN set in the Ayala Settings screen of the mobile app.)",
          buttons: ["Paste from Clipboard", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (step2.response !== 0) return;

        const eodPin = clipboard.readText().trim();
        if (!eodPin || !/^\d{4,8}$/.test(eodPin)) {
          await dialog.showMessageBox({
            type: "error",
            title: "Invalid EOD PIN",
            message: `"${eodPin}" is not a valid EOD PIN. It must be 4–8 digits.\nCopy your PIN to the clipboard and try again.`,
            buttons: ["OK"],
          });
          return;
        }

        const confirm = await dialog.showMessageBox({
          type: "question",
          title: "Confirm Account",
          message: `Save these credentials?\n\nEmail: ${email}\nEOD PIN: ${"•".repeat(eodPin.length)}`,
          buttons: ["Save", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (confirm.response !== 0) return;

        try {
          userConfig = {
            ...userConfig,
            firebaseEmail: email,
            firebaseEodPin: eodPin,
          };
          fs.writeFileSync(
            configPath,
            JSON.stringify(userConfig, null, 2),
            "utf8",
          );
          log.info(`[Firebase Sync] Account configured: ${email}`);
          buildAndSetTrayMenu(currentIP);
          // Push the current IP immediately to confirm credentials work
          await pushIPToFirebase(currentIP);
          new Notification({
            title: "Ayala Bridge — Account Saved",
            body: `Linked to ${email}. The mobile app will now receive IP updates automatically.`,
          }).show();
        } catch (err) {
          log.error("Failed to save account config:", err);
        }
      },
    },
    { type: "separator" },
    {
      label: "Refresh IP",
      click: async () => {
        const newIP = getLocalIPAddress();
        if (newIP !== currentIP) {
          log.info(`IP changed (manual refresh): ${currentIP} → ${newIP}`);
          currentIP = newIP;
          buildAndSetTrayMenu(newIP);
          await pushIPToFirebase(newIP);
          new Notification({
            title: "Ayala Bridge — IP Updated",
            body: `New IP: http://${newIP}:${PORT}\nThe mobile app has been notified.`,
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
        ipWatcherInterval = setInterval(async () => {
          const newIP = getLocalIPAddress();
          if (newIP !== currentIP) {
            log.info(`IP changed (auto-detected): ${currentIP} → ${newIP}`);
            currentIP = newIP;
            buildAndSetTrayMenu(newIP);
            await pushIPToFirebase(newIP);
            new Notification({
              title: "Ayala Bridge — IP Changed",
              body: `New IP: http://${newIP}:${PORT}\nThe mobile app has been notified.`,
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
