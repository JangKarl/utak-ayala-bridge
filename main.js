const {
  app,
  Tray,
  Menu,
  shell,
  Notification,
  dialog,
  clipboard,
} = require("electron");
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
const FIX_TOOL = "Fix Bridge Connection.cmd";

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
// Mall selector: unset means Ayala, so existing installs are unaffected.
const MALL = userConfig.mall === "acc" ? "acc" : "ayala";
process.env.BRIDGE_MALL = MALL;
applyAccEnv();

// The ACC services read these on every call, so a change applies without
// a restart.
function applyAccEnv() {
  const acc = userConfig.acc || {};
  for (const [env, val] of [
    ["ACC_UID", acc.uid],
    ["ACC_KEY", acc.key],
    ["ACC_FOLDER", acc.folder],
    ["ACC_DEADLINE_MIN", acc.deadlineMinutes],
  ]) {
    if (val) process.env[env] = String(val);
    else delete process.env[env];
  }
}

const {
  startServer,
  restartJobs,
  getLocalIPAddress,
  listLocalIPv4Addresses,
  UPLOADS_DIR,
  PORT,
} = require("./bridge");
const { accSender, describeSync } = require("./src/services/accSender.service");

const APP_NAME = "UTAK Mall Bridge";
// Windows names and badges notifications by this ID. It must equal build.appId
// so the installed Start-menu shortcut supplies the name and icon.
app.setAppUserModelId("com.ayala.bridge");
const NOTIFY_ICON = path.join(__dirname, "assets", "icon.ico");

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

function saveUserConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2), "utf8");
  } catch (err) {
    log.error("Failed to save config:", err.message);
  }
}

// The IP the bridge advertises to POS devices. On a dual-homed PC (store Wi-Fi
// + Ayala mall LAN), auto-detect can pick the wrong NIC, so the operator can
// pin the POS-facing IP via the tray ("Bridge IP"). The pin is only honored
// while that address is actually present; otherwise we fall back to auto-detect.
function getEffectiveIP() {
  const available = listLocalIPv4Addresses().map((a) => a.address);
  if (userConfig.bridgeIp && available.includes(userConfig.bridgeIp)) {
    return userConfig.bridgeIp;
  }
  return getLocalIPAddress();
}

function selectBridgeIp(address) {
  if (address) {
    userConfig.bridgeIp = address;
  } else {
    delete userConfig.bridgeIp; // back to auto-detect
  }
  saveUserConfig();
  currentIP = getEffectiveIP();
  buildAndSetTrayMenu(currentIP);
  new Notification({ icon: NOTIFY_ICON,
    title: `${APP_NAME} — Bridge IP Set`,
    body: `POS devices should connect to http://${currentIP}:${PORT}. Make sure the bridge IP in the POS mall settings matches.`,
  }).show();
}

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
// Pilot PCs opt in from the tray; they get pre-releases (e.g. 2.53.0-beta.1)
// first, then move to the stable 2.53.0 like everyone else.
autoUpdater.allowPrerelease = !!userConfig.betaUpdates;
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
  new Notification({ icon: NOTIFY_ICON,
    title: `${APP_NAME} — Update Ready`,
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
  if (MALL === "acc") return accSender().running; // never mid-write to the ACC folder
  try {
    return reprocessStateService.listPending().length > 0;
  } catch (err) {
    log.warn("[Updater] Could not read reprocess state:", err.message);
    return true;
  }
}

function onlineDeviceCount() {
  if (MALL === "acc") return 0; // tablets queue sales while the bridge restarts
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
      new Notification({ icon: NOTIFY_ICON,
        title: `${APP_NAME}`,
        body: "No update is ready to install yet.",
      }).show();
    }
    return false;
  }

  if (isReprocessBusy()) {
    log.info("[Updater] Install deferred — EOD reprocess in progress.");
    if (manual) {
      new Notification({ icon: NOTIFY_ICON,
        title: `${APP_NAME} — Update Deferred`,
        body:
          MALL === "acc"
            ? "A file is being sent to ACC. The update will apply once it finishes."
            : "An EOD reprocess is in progress. The update will apply once it finishes.",
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

  const mallItems = [
    { label: "Ayala", value: "ayala" },
    { label: "ACC (Alabang Town Center)", value: "acc" },
  ].map(({ label, value }) => ({
    label,
    type: "radio",
    checked: MALL === value,
    click: () => selectMall(value),
  }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `${APP_NAME} v${app.getVersion()}${userConfig.betaUpdates ? " (beta)" : ""} - Running`,
      enabled: false,
    },
    { label: `Mall: ${MALL === "acc" ? "ACC" : "Ayala"}`, submenu: mallItems },
    { type: "separator" },
    ...(MALL === "acc" ? accMenuItems() : ayalaMenuItems(localIP)),
    {
      label: "View Logs",
      click: () =>
        shell.openPath(path.dirname(log.transports.file.getFile().path)),
    },
    {
      label: "Fix Connection",
      click: () => {
        // Shipped via extraResources, not files[] — inside app.asar it could not
        // be executed. In dev it sits next to main.js.
        const tool = app.isPackaged
          ? path.join(process.resourcesPath, "tools", FIX_TOOL)
          : path.join(__dirname, "tools", FIX_TOOL);
        if (!fs.existsSync(tool)) {
          log.error(`[FixConnection] tool missing: ${tool}`);
          dialog.showErrorBox("Fix Connection", `Tool not found:\n${tool}`);
          return;
        }
        log.info(`[FixConnection] launching ${tool}`);
        // The .cmd self-elevates, so Windows raises the UAC prompt itself.
        shell.openPath(tool).then((err) => {
          if (err) dialog.showErrorBox("Fix Connection", err);
        });
      },
    },
    ...(MALL === "ayala"
      ? [
          {
            label: "Sync Time",
            click: () => {
              restartJobs();
              new Notification({ icon: NOTIFY_ICON,
                title: `${APP_NAME}`,
                body: "Time synced — cron job has been restarted.",
              }).show();
            },
          },
        ]
      : []),
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
    {
      label: "Beta updates (pilot stores only)",
      type: "checkbox",
      checked: !!userConfig.betaUpdates,
      click: (item) => {
        userConfig.betaUpdates = item.checked;
        saveUserConfig();
        autoUpdater.allowPrerelease = item.checked;
        buildAndSetTrayMenu(currentIP);
        autoUpdater.checkForUpdates().catch((err) => {
          log.warn("[Updater] Check after beta toggle failed:", err.message);
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

  tray.setToolTip(`${APP_NAME} (${MALL === "acc" ? "ACC" : "Ayala"})`);
  tray.setContextMenu(contextMenu);
}

function ayalaMenuItems(localIP) {
  const devices = terminalRegistryService.listDevices();
  const onlineCount = devices.filter((device) => device.online).length;
  const deviceItems = devices.length
    ? devices.slice(0, 12).map((device) => ({
        label: `${device.online ? "Online" : "Offline"} | TER ${device.terNo} | ${device.deviceName} | ${device.lastSeenAtIso || "never"}`,
        enabled: false,
      }))
    : [{ label: "No POS devices seen yet", enabled: false }];

  return [
    {
      label: `Bridge IP: ${localIP}`,
      submenu: bridgeIpItems(),
    },
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
        // Wrap the whole handler: an Electron menu click doesn't await/catch the
        // returned promise, so a rejection from showOpenDialog (or the write)
        // would become an unhandled rejection.
        try {
          const result = await dialog.showOpenDialog({
            title: "Select Uploads Directory",
            defaultPath: UPLOADS_DIR,
            properties: ["openDirectory"],
          });
          if (result.canceled || result.filePaths.length === 0) return;
          const selectedDir = result.filePaths[0];
          fs.writeFileSync(
            configPath,
            JSON.stringify({ ...userConfig, uploadsDir: selectedDir }, null, 2),
            "utf8",
          );
          new Notification({ icon: NOTIFY_ICON,
            title: `${APP_NAME}`,
            body: "Uploads directory updated. Restarting to apply changes...",
          }).show();
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 1500);
        } catch (err) {
          log.error("Failed to select/save directory config:", err);
        }
      },
    },
    {
      label: "Refresh IP",
      click: () => {
        const newIP = getEffectiveIP();
        if (newIP !== currentIP) {
          log.info(`IP changed (manual refresh): ${currentIP} → ${newIP}`);
          currentIP = newIP;
          buildAndSetTrayMenu(newIP);
          new Notification({ icon: NOTIFY_ICON,
            title: `${APP_NAME} — IP Updated`,
            body: `New IP: http://${newIP}:${PORT}\nUpdate your POS configuration.`,
          }).show();
        } else {
          new Notification({ icon: NOTIFY_ICON,
            title: `${APP_NAME}`,
            body: `IP unchanged: http://${newIP}:${PORT}`,
          }).show();
        }
      },
    },
    { type: "separator" },
  ];
}

// POS-facing IP picker. Radio list of every detected IPv4 so the operator
// can pin the store-network address (e.g. 192.168.0.171) on a dual-homed PC.
function bridgeIpItems() {
  return [
    {
      label: "Auto-detect",
      type: "radio",
      checked: !userConfig.bridgeIp,
      click: () => selectBridgeIp(null),
    },
    ...listLocalIPv4Addresses().map((a) => ({
      label: `${a.address}  (${a.name})`,
      type: "radio",
      checked: userConfig.bridgeIp === a.address,
      click: () => selectBridgeIp(a.address),
    })),
  ];
}

function accMenuItems() {
  const acc = userConfig.acc || {};
  const st = accSender().status();
  const sent = st.lastSent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : "never");
  return [
    {
      label: `Bridge IP: ${currentIP}`,
      submenu: bridgeIpItems(),
    },
    { label: `Port: ${PORT}`, enabled: false },
    { type: "separator" },
    {
      label: acc.uid ? `ACC store: ${acc.uid.slice(0, 8)}…` : "ACC store: NOT SET UP",
      enabled: false,
    },
    {
      label: sent
        ? `Last file sent: ${sent.filename} (${sent.via}${sent.verified === false ? ", awaiting check" : ""})`
        : "Last file sent: none yet",
      enabled: false,
    },
    {
      label: `Internet: ${st.online === null ? "checking…" : st.online ? "online" : "OFFLINE"} · last check ${when(st.lastRunAt)}`,
      enabled: false,
    },
    ...(st.lastError
      ? [{ label: `Last error: ${st.lastError.day} ${st.lastError.message}`.slice(0, 110), enabled: false }]
      : []),
    { type: "separator" },
    { label: "Send Now", click: () => accSendNow("Checking for files to send…") },
    { label: "Open ACC Folder", click: openAccFolder },
    { label: `ACC folder: ${accSender().folder()}`, enabled: false },
    { label: "Select ACC Folder", click: selectAccFolder },
    { label: "Paste ACC Setup Code", click: pasteAccSetupCode },
    { type: "separator" },
  ];
}

// Switching malls loads a different server and jobs, so restart.
function selectMall(mall) {
  if (mall === MALL) return;
  userConfig.mall = mall;
  userConfig.mallSwitched = true; // confirmed by a notification after the restart
  saveUserConfig();
  log.info(`[Mall] switched to ${mall}; restarting`);
  app.relaunch();
  app.exit(0);
}

async function selectAccFolder() {
  try {
    const result = await dialog.showOpenDialog({
      title: "Select the ACC folder (local or \\\\server\\share)",
      defaultPath: accSender().folder(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return;
    const folder = result.filePaths[0];
    // Pollsys shares are often read-only for this PC; say so now, not at send time.
    const probe = path.join(folder, `.utak-write-test-${Date.now()}`);
    try {
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
    } catch (err) {
      log.warn(`[ACC] folder not writable: ${folder}: ${err.message}`);
      dialog.showErrorBox(APP_NAME, `Can't save files to:\n${folder}\n\n${err.message}\n\nThe ACC folder was not changed.`);
      return;
    }
    userConfig.acc = { ...userConfig.acc, folder };
    saveUserConfig();
    applyAccEnv();
    log.info(`[ACC] folder set to ${folder}`);
    accNotify(`ACC folder set to ${folder}`);
    buildAndSetTrayMenu(currentIP);
  } catch (err) {
    log.error("[ACC] folder select failed:", err);
    dialog.showErrorBox(APP_NAME, `Selecting the ACC folder failed: ${err.message}`);
  }
}

function accNotify(body, isError = false) {
  new Notification({ icon: NOTIFY_ICON, title: isError ? `${APP_NAME}: ACC problem` : `${APP_NAME}: ACC`, body }).show();
}

// Every manual send ends with a notification saying what happened.
async function accSendNow(intro) {
  if (!userConfig.acc?.uid) {
    accNotify("Not set up yet. Copy the setup code from the Admin, then use Paste ACC Setup Code.", true);
    return;
  }
  accNotify(intro);
  try {
    const { body, isError } = describeSync(await accSender().sync());
    log.info(`[ACC] manual send: ${body}`);
    accNotify(body, isError);
  } catch (err) {
    log.error("[ACC] manual send failed:", err);
    accNotify(`Send failed: ${err.message}`, true);
  } finally {
    buildAndSetTrayMenu(currentIP);
  }
}

async function openAccFolder() {
  const folder = accSender().folder();
  try {
    fs.mkdirSync(folder, { recursive: true }); // nothing is sent until the first day closes
  } catch (_) {
    // openPath below reports the real problem
  }
  const err = await shell.openPath(folder);
  if (err) accNotify(`Can't open ${folder}: ${err}`, true);
}

/**
 * The Admin's "Generate bridge key" copies a code: base64 of {"u": uid, "k": key}.
 * Pasting it here saves both, so nobody types a uid or a key by hand.
 */
function pasteAccSetupCode() {
  try {
    const { u, k } = JSON.parse(
      Buffer.from(clipboard.readText().trim(), "base64").toString("utf8"),
    );
    if (typeof u !== "string" || typeof k !== "string" || k.length < 32) {
      throw new Error("missing store or key");
    }
    userConfig.acc = { ...userConfig.acc, uid: u, key: k };
    saveUserConfig();
    applyAccEnv();
    log.info(`[ACC] setup code saved for ${u}`);
    accSendNow("ACC store set up. Checking for files to send…");
  } catch (err) {
    log.warn(`[ACC] invalid setup code: ${err.message}`);
    dialog.showErrorBox(
      APP_NAME,
      "The clipboard does not hold a valid ACC setup code. Copy it again from the Admin (Mall Config → ACC → Generate bridge key), then try again.",
    );
  }
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (tray) {
      new Notification({ icon: NOTIFY_ICON,
        title: `${APP_NAME}`,
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

    // Check for updates silently on startup. checkForUpdates() returns a
    // promise, so a bare sync try/catch would miss an async rejection (e.g. no
    // internet on boot) and leave an unhandled promise rejection — attach
    // .catch like the periodic/manual checks do (outer try guards a sync throw).
    try {
      autoUpdater.checkForUpdates().catch((err) => {
        log.warn("[Updater] Startup update check failed:", err.message);
      });
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
    currentIP = getEffectiveIP();
    const iconPath = path.join(__dirname, "assets", "icon.ico");

    try {
      if (!fs.existsSync(iconPath)) {
        log.warn(`Tray icon not found at ${iconPath}. Skipping tray creation.`);
      } else {
        tray = new Tray(iconPath);
        buildAndSetTrayMenu(currentIP);
        if (userConfig.mallSwitched) {
          delete userConfig.mallSwitched;
          saveUserConfig();
          new Notification({ icon: NOTIFY_ICON,
            title: APP_NAME,
            body: `Now running for ${MALL === "acc" ? "ACC (Alabang Town Center)" : "Ayala"}.`,
          }).show();
        }

        // Background watcher — checks for IP changes every 30 seconds
        ipWatcherInterval = setInterval(() => {
          const newIP = getEffectiveIP();
          if (newIP !== currentIP) {
            log.info(`IP changed (auto-detected): ${currentIP} → ${newIP}`);
            currentIP = newIP;
            buildAndSetTrayMenu(newIP);
            new Notification({ icon: NOTIFY_ICON,
              title: `${APP_NAME} — IP Changed`,
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
      new Notification({ icon: NOTIFY_ICON,
        title: `${APP_NAME} — Updated`,
        body: `Updated to v${runningVersion} (was v${previousVersion}). Running on http://${currentIP}:${PORT}`,
      }).show();
    } else {
      new Notification({ icon: NOTIFY_ICON,
        title: `${APP_NAME} Started`,
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
