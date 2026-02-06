const express = require("express");
const cors = require("cors");
const fs = require("fs");
const log = require("electron-log");
require("dotenv").config();

const { PORT, UPLOADS_DIR } = require("./src/constants/ayala");
const { getLocalIPAddress } = require("./src/utils");
const ayalaRoutes = require("./src/routes/ayala.routes");
const { initJobs } = require("./src/jobs/ayala.job");

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
  });
};

if (require.main === module) {
  startServer();
}

module.exports = { startServer, getLocalIPAddress, UPLOADS_DIR, PORT };
