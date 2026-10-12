const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const log = require("electron-log");

// Use __dirname so .env resolves from the project root in both dev (standalone)
// and production (where main.js has already loaded it — this becomes a no-op
// since dotenv skips vars that are already set).
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { PORT, UPLOADS_DIR } = require("./src/constants/ayala");
const { getLocalIPAddress, listLocalIPv4Addresses } = require("./src/utils");
const { startTimeWatcher } = require("./src/jobs/timeWatcher");

// Which mall this PC serves; main.js sets it from config.json. Unset means
// Ayala, so every PC installed before the selector existed keeps working.
const MALL = process.env.BRIDGE_MALL === "acc" ? "acc" : "ayala";

// Only the selected mall's modules load: Ayala's services hydrate state and
// create C:\AYALA folders at require time, which an ACC PC has no use for.
let mall;
if (MALL === "acc") {
  const job = require("./src/jobs/acc.job");
  mall = {
    routes: require("./src/routes/acc.routes"),
    initJobs: job.initAccJobs,
    restartJobs: job.restartAccJobs,
  };
} else {
  const job = require("./src/jobs/ayala.job");
  mall = {
    routes: require("./src/routes/ayala.routes"),
    initJobs: job.initJobs,
    restartJobs: job.restartJobs,
  };
}

if (MALL === "ayala" && !fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Express App Setup
const app = express();
app.use(cors());
// A tablet back online drains its queued sales in one batch.
app.use(express.json(MALL === "acc" ? { limit: "5mb" } : undefined));

// Routes
app.use("/", mall.routes);

/**
 * Starts the Express server and initializes background jobs.
 */
const startServer = () => {
  app.listen(PORT, () => {
    log.info(
      `Bridge (${MALL}) server running on http://${getLocalIPAddress()}:${PORT}`,
    );

    // Initialize scheduled jobs
    mall.initJobs();

    // Watch for system clock changes (e.g., manual changes during demos)
    startTimeWatcher(() => {
      log.info(
        "[TimeWatcher] System clock change detected — restarting cron job.",
      );
      mall.restartJobs();
    });
  });
};

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  restartJobs: () => mall.restartJobs(),
  getLocalIPAddress,
  listLocalIPv4Addresses,
  UPLOADS_DIR,
  PORT,
  MALL,
};
