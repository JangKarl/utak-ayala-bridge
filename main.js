const {
  app,
  Tray,
  Menu,
  shell,
  Notification,
  dialog,
  clipboard,
  BrowserWindow,
  ipcMain,
  nativeTheme,
} = require("electron");
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
const FIX_TOOL = "Fix Bridge Connection.cmd";

const configPath = path.join(app.getPath("userData"), "config.json");
let userConfig = {};
try {
  userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (_) {
  // No config file yet — use defaults
}
// Ayala's folder. The old "uploadsDir" key was ignored from v2.50.0 (a load-
// order bug), so every PC has written to the default since; honoring it now
// could move files away from where the mall collects them. New picks use
// "ayalaFolder"; "uploadsDir" stays ignored and is only logged at startup.
if (userConfig.ayalaFolder) {
  process.env.UPLOADS_DIR = userConfig.ayalaFolder;
}
// Mall selector: unset means Ayala, so existing installs are unaffected.
const MALL = userConfig.mall === "acc" ? "acc" : "ayala";
// "acc" stays the setting; stores see the mall's name. ACC names the file.
const MALL_NAME = MALL === "acc" ? "Rockwell" : "Ayala";
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

// Required only now: constants/ayala.js reads UPLOADS_DIR and PORT once, at
// first load, so the .env and config.json values above must be set first.
const terminalRegistryService = require("./src/services/terminalRegistry.service");
const reprocessStateService = require("./src/services/reprocessState.service");
const { listAyalaDays, ayalaDayDetail } = require("./src/services/ayalaDays.service");
const { TEMP_DIR } = require("./src/constants/ayala");
const { nowTz } = require("./src/utils");
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `${APP_NAME} v${app.getVersion()}${userConfig.betaUpdates ? " (beta)" : ""} - Running`,
      enabled: false,
    },
    { label: `Open ${APP_NAME}`, click: openWindow },
    { label: `Mall: ${MALL_NAME}`, enabled: false },
    { type: "separator" },
    ...(MALL === "acc" ? accMenuItems() : ayalaMenuItems(localIP)),
    { label: "View Logs", click: openLogs },
    { label: "Fix Connection", click: launchFixConnection },
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

  tray.setToolTip(`${APP_NAME} (${MALL_NAME})`);
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
      label: userConfig.ayalaFolder
        ? `Dir: ${userConfig.ayalaFolder}`
        : "Dir: (default)",
      enabled: false,
    },
    { label: "Select Directory", click: () => chooseUploadsDir() },
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

// The mall is picked once, on a fresh install's setup screen. A wrong switch
// stops a store's files with the tray still saying Running, so only support
// changes it: delete "mall" from config.json and restart (see CLAUDE.md).
// PCs from before the selector have no "mall" and no welcome: Ayala, locked.
const mallLocked = () => !!userConfig.mall || !userConfig.welcome;

function selectMall(mall) {
  if (mall === MALL) return;
  userConfig.mall = mall;
  userConfig.mallSwitched = true; // confirmed by a notification after the restart
  saveUserConfig();
  log.info(`[Mall] switched to ${mall}; restarting`);
  app.relaunch();
  app.exit(0);
}

// The tray and the window share these: each returns { ok, message }, or null
// when the user cancelled, and the caller decides how to show it.
async function chooseAccFolder(parent) {
  try {
    const result = await dialog.showOpenDialog(parent, {
      title: "Select the ACC folder (local or \\\\server\\share)",
      defaultPath: accSender().folder(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const folder = result.filePaths[0];
    // Pollsys shares are often read-only for this PC; say so now, not at send time.
    const probe = path.join(folder, `.utak-write-test-${Date.now()}`);
    try {
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
    } catch (err) {
      log.warn(`[ACC] folder not writable: ${folder}: ${err.message}`);
      return { ok: false, message: `Can't save files to ${folder} (${err.message}). The ACC folder was not changed.` };
    }
    userConfig.acc = { ...userConfig.acc, folder };
    saveUserConfig();
    applyAccEnv();
    log.info(`[ACC] folder set to ${folder}`);
    buildAndSetTrayMenu(currentIP);
    return { ok: true, message: `ACC folder set to ${folder}` };
  } catch (err) {
    log.error("[ACC] folder select failed:", err);
    return { ok: false, message: `Selecting the ACC folder failed: ${err.message}` };
  }
}

async function selectAccFolder() {
  const r = await chooseAccFolder();
  if (!r) return;
  if (r.ok) accNotify(r.message);
  else dialog.showErrorBox(APP_NAME, r.message);
}

/**
 * The Admin's "Generate bridge key" gives a code: base64 of {"u": uid, "k": key}.
 * Saving it stores both, so nobody types a uid or a key by hand.
 */
function applyAccSetupCode(text) {
  try {
    const { u, k } = JSON.parse(Buffer.from(String(text).trim(), "base64").toString("utf8"));
    if (typeof u !== "string" || typeof k !== "string" || k.length < 32) {
      throw new Error("missing store or key");
    }
    userConfig.acc = { ...userConfig.acc, uid: u, key: k };
    saveUserConfig();
    applyAccEnv();
    log.info(`[ACC] setup code saved for ${u}`);
    buildAndSetTrayMenu(currentIP);
    return { ok: true, message: "ACC store set up." };
  } catch (err) {
    log.warn(`[ACC] invalid setup code: ${err.message}`);
    return {
      ok: false,
      message: "That is not a valid ACC setup code. Copy it again from the Admin (Mall Config → ACC → Generate Bridge Key), then try again.",
    };
  }
}

async function runAccSync() {
  if (!userConfig.acc?.uid) {
    return { ok: false, message: "Not set up yet. Copy the setup code from the Admin, then use Paste ACC Setup Code." };
  }
  try {
    const { body, isError } = describeSync(await accSender().sync());
    log.info(`[ACC] manual send: ${body}`);
    return { ok: !isError, message: body };
  } catch (err) {
    log.error("[ACC] manual send failed:", err);
    return { ok: false, message: `Send failed: ${err.message}` };
  } finally {
    buildAndSetTrayMenu(currentIP);
  }
}

function launchFixConnection() {
  // Shipped via extraResources, not files[]: inside app.asar it could not be
  // executed. In dev it sits next to main.js.
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
}

// Ayala's folder is read at require time, so a change restarts the bridge.
// Wrapped whole: a menu click doesn't catch a rejected promise.
async function chooseUploadsDir(parent) {
  try {
    const result = await dialog.showOpenDialog(parent, {
      title: "Select Uploads Directory",
      defaultPath: UPLOADS_DIR,
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedDir = result.filePaths[0];
    if (path.resolve(selectedDir) === path.resolve(UPLOADS_DIR)) {
      return { ok: true, message: "That is already the Ayala folder." };
    }
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...userConfig, ayalaFolder: selectedDir }, null, 2),
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
    return { ok: true, message: `Ayala folder set to ${selectedDir}. Restarting the bridge…` };
  } catch (err) {
    log.error("Failed to select/save directory config:", err);
    return { ok: false, message: `Changing the folder failed: ${err.message}` };
  }
}

// Last 7 business days per store, newest first, for the window.
function ayalaDays() {
  const ccodes = new Set(Object.keys(terminalRegistryService.registry || {}));
  try {
    for (const n of fs.readdirSync(UPLOADS_DIR)) {
      const m = /^EOD(\d+)\d{6}\.csv$/i.exec(n);
      if (m) ccodes.add(m[1]);
    }
  } catch {
    // No folder yet: only the registry's stores show.
  }
  const days = [...Array(7)].map((_, i) => nowTz().subtract(i, "day").format("MMDDYY"));
  return listAyalaDays({
    dir: UPLOADS_DIR,
    days,
    ccodes: [...ccodes].filter((c) => /^\d+$/.test(c)),
    pending: reprocessStateService.listPending(),
  });
}

const openLogs = () =>shell.openPath(path.dirname(log.transports.file.getFile().path));

function accNotify(body, isError = false) {
  new Notification({ icon: NOTIFY_ICON, title: isError ? `${APP_NAME}: ACC problem` : `${APP_NAME}: ACC`, body }).show();
}

// Every manual send from the tray ends with a notification saying what happened.
async function accSendNow(intro) {
  if (userConfig.acc?.uid) accNotify(intro);
  const r = await runAccSync();
  accNotify(r.message, !r.ok);
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
  return err ? { ok: false, message: `Can't open ${folder}: ${err}` } : { ok: true };
}

function pasteAccSetupCode() {
  const r = applyAccSetupCode(clipboard.readText());
  if (!r.ok) {
    dialog.showErrorBox(APP_NAME, r.message);
    return;
  }
  accSendNow("ACC store set up. Checking for files to send…");
}

// ---- Window: first-run setup + status. The tray stays the way to reach it.
let win = null;

function openWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  nativeTheme.themeSource = userConfig.theme || "system";
  win = new BrowserWindow({
    width: 880,
    height: 700,
    minWidth: 560,
    minHeight: 520,
    title: APP_NAME,
    icon: NOTIFY_ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#101a1d" : "#f4f7f7",
    webPreferences: {
      preload: path.join(__dirname, "ui", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.once("ready-to-show", () => win.show());
  // Closing hides to the tray; the bridge keeps running.
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => (win = null));
  // Windows shutdown closes windows without before-quit; don't hold it up.
  win.on("query-session-end", () => (app.isQuitting = true));
  win.on("session-end", () => (app.isQuitting = true));
}

function uiState() {
  const base = {
    appName: APP_NAME,
    version: app.getVersion(),
    beta: !!userConfig.betaUpdates,
    updateReady: downloadedUpdate?.version || null,
    mall: MALL,
    mallChosen: !!userConfig.mall,
    theme: userConfig.theme || "system",
    welcome: !!userConfig.welcome,
    bridgeIp: currentIP,
    pinnedIp: userConfig.bridgeIp || null,
    ips: listLocalIPv4Addresses(),
    port: PORT,
  };
  if (MALL === "acc") {
    const st = accSender().status();
    return {
      ...base,
      acc: {
        setUp: !!userConfig.acc?.uid,
        posCode: st.posCode,
        folder: st.folder,
        online: st.online,
        lastRunAt: st.lastRunAt,
        running: accSender().running,
        days: accSender().days(7),
      },
    };
  }
  return {
    ...base,
    ayala: {
      devices: terminalRegistryService.listDevices(),
      uploadsDir: UPLOADS_DIR,
      days: ayalaDays(),
      reprocessing: reprocessStateService.listPending().length,
    },
  };
}

const uiActions = {
  state: () => uiState(),
  chooseMall: (mall) => {
    if (mall !== "acc" && mall !== "ayala") return { ok: false, message: "Unknown mall." };
    if (mallLocked()) return { ok: false, message: "The mall is already set. Only UTAK support can change it." };
    if (mall === MALL) {
      userConfig.mall = mall;
      saveUserConfig();
      return { ok: true };
    }
    selectMall(mall); // restarts; the window reopens because welcome/mallSwitched is set
    return { ok: true };
  },
  readClipboard: () => clipboard.readText().trim().slice(0, 2000),
  setupCode: async (text) => {
    const r = applyAccSetupCode(text);
    if (!r.ok) return r;
    const s = await runAccSync();
    return { ok: s.ok, saved: true, message: `${r.message} ${s.message}` };
  },
  chooseFolder: () => (MALL === "acc" ? chooseAccFolder(win) : chooseUploadsDir(win)),
  dayDetail: ({ ccode, day } = {}) => {
    if (!/^\d+$/.test(String(ccode)) || !/^\d{6}$/.test(String(day))) return null;
    return ayalaDayDetail({ dir: UPLOADS_DIR, tempDir: TEMP_DIR, ccode, day });
  },
  // themeSource drives prefers-color-scheme in the page and the native frame.
  setTheme: (theme) => {
    if (!["system", "light", "dark"].includes(theme)) return { ok: false };
    nativeTheme.themeSource = theme;
    userConfig.theme = theme;
    saveUserConfig();
    return { ok: true };
  },
  copyAddress: () => {
    clipboard.writeText(`${currentIP}`);
    return { ok: true, message: `Copied ${currentIP}` };
  },
  sendNow: () => runAccSync(),
  openFolder: () => (MALL === "acc" ? openAccFolder() : shell.openPath(UPLOADS_DIR)),
  openLogs: () => openLogs(),
  fixConnection: () => launchFixConnection(),
  setBridgeIp: (ip) => {
    selectBridgeIp(ip || null);
    return { ok: true, message: `Tablets should connect to ${currentIP}:${PORT}` };
  },
  finishSetup: () => {
    delete userConfig.welcome;
    saveUserConfig();
    return { ok: true };
  },
};

ipcMain.handle("bridge", async (e, action, arg) => {
  if (!win || e.sender !== win.webContents) return null; // only our window
  const fn = uiActions[action];
  if (!fn) return { ok: false, message: `Unknown action ${action}` };
  return (await fn(arg)) ?? { ok: true };
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // Opening the shortcut again shows the window of the copy already running.
  app.on("second-instance", () => {
    if (app.isReady()) openWindow();
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
        tray.on("click", openWindow);
        buildAndSetTrayMenu(currentIP);
        if (userConfig.mallSwitched) {
          delete userConfig.mallSwitched;
          saveUserConfig();
          new Notification({ icon: NOTIFY_ICON,
            title: APP_NAME,
            body: `Now running for ${MALL_NAME}.`,
          }).show();
          openWindow();
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
    // A fresh install (no version recorded yet) starts with the setup screens.
    // Existing installs only open the window when ACC still needs its code.
    // lastVersion only exists since v2.51.0, so a tablet registry also marks
    // an existing Ayala PC: it must never get the mall picker on update.
    const hadTablets = fs.existsSync(path.join(TEMP_DIR, "terminal_registry.json"));
    if (!previousVersion && !hadTablets) {
      userConfig.welcome = true;
      saveUserConfig();
    }
    if (userConfig.uploadsDir && userConfig.uploadsDir !== UPLOADS_DIR) {
      log.warn(`[Config] old uploadsDir "${userConfig.uploadsDir}" ignored (as since v2.50.0); Ayala files stay in ${UPLOADS_DIR}`);
    }
    if (userConfig.welcome || (MALL === "acc" && !userConfig.acc?.uid)) openWindow();
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
  app.isQuitting = true; // lets the window really close (Windows shutdown, updates)
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
