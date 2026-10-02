const https = require("node:https");
const { createSecureApp } = require("./src/security/secureApp");
const { HTTPS_PORT } = require("./src/security/bridgeSecurity");
const fs = require("fs");
const path = require("path");
const log = require("electron-log");

// Use __dirname so .env resolves from the project root in both dev (standalone)
// and production (where main.js has already loaded it — this becomes a no-op
// since dotenv skips vars that are already set).
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { UPLOADS_DIR } = require("./src/constants/ayala");
const { getLocalIPAddress, listLocalIPv4Addresses } = require("./src/utils");
const ayalaRoutes = require("./src/routes/ayala.routes");
const { initJobs, restartJobs } = require("./src/jobs/ayala.job");
const { startTimeWatcher } = require("./src/jobs/timeWatcher");

// Ensure uploads directory exists in user's home (production friendly)
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Starts the Express server and initializes background jobs.
 */
const startServer = (security) => new Promise((resolve, reject) => {
  const server = https.createServer(security.tlsOptions(), createSecureApp(security, ayalaRoutes));
  server.once("error", reject);
  server.listen(HTTPS_PORT, () => {
    resolve(server);
    log.info(
      `Ayala Bridge server running on https://${getLocalIPAddress()}:${HTTPS_PORT}`,
    );

    // Initialize scheduled jobs
    initJobs();

    // Watch for system clock changes (e.g., manual changes during demos)
    startTimeWatcher(() => {
      log.info(
        "[TimeWatcher] System clock change detected — restarting cron job.",
      );
      restartJobs();
    });
  });
});

if (require.main === module) {
  throw new Error("Start the Electron app to access Windows secure storage and pairing.");
}

module.exports = {
  startServer,
  restartJobs,
  getLocalIPAddress,
  listLocalIPv4Addresses,
  UPLOADS_DIR,
  PORT: HTTPS_PORT,
};
