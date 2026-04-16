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
const { getLocalIPAddress } = require("./src/utils");
const ayalaRoutes = require("./src/routes/ayala.routes");
const { initJobs, restartJobs } = require("./src/jobs/ayala.job");
const { startTimeWatcher } = require("./src/jobs/timeWatcher");

// Ensure uploads directory exists in user's home (production friendly)
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Express App Setup
const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use("/", ayalaRoutes);

/**
 * Starts the Express server and initializes background jobs.
 */
const startServer = () => {
  app.listen(PORT, () => {
    log.info(
      `Ayala Bridge server running on http://${getLocalIPAddress()}:${PORT}`,
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
};

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  restartJobs,
  getLocalIPAddress,
  UPLOADS_DIR,
  PORT,
};
