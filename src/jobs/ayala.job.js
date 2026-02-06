const cron = require("node-cron");
const log = require("electron-log");
const fs = require("fs");
const path = require("path");
const ayalaService = require("../services/ayala.service");
const { UPLOADS_DIR } = require("../constants/ayala");

/**
 * Initializes and starts the background jobs.
 */
const initJobs = () => {
  log.info("[Cron] Initializing Ayala background jobs...");

  // Every hour at minute 0
  cron.schedule("0 * * * *", () => {
    const now = new Date();
    // Target the previous hour for finalization
    const targetTime = new Date(now.getTime() - 60 * 60 * 1000);
    const hour = targetTime.getHours();
    const date = `${(targetTime.getMonth() + 1).toString().padStart(2, "0")}_${targetTime
      .getDate()
      .toString()
      .padStart(2, "0")}_${targetTime.getFullYear().toString().slice(-2)}`;
    
    const tempFilename = `temp_${date}_hour_${hour}.csv`;
    const tempPath = path.join(UPLOADS_DIR, tempFilename);

    log.info(`[Cron] Starting hourly finalization for hour ${hour}:00 (File: ${tempFilename})`);

    try {
      if (fs.existsSync(tempPath)) {
        log.info(`[Cron] Processing draft: ${tempFilename}`);
        const officialFilename = ayalaService.finalizeHourlyDraft(tempFilename);
        
        if (officialFilename) {
          log.info(`[Cron] Success: Finalized ${officialFilename}`);
        } else {
          log.warn(`[Cron] Draft ${tempFilename} was empty or invalid and has been removed.`);
        }
      } else {
        log.info(`[Cron] No draft file found for hour ${hour}, skipping.`);
      }
    } catch (err) {
      log.error(`[Cron] Critical error during hourly finalization of ${tempFilename}:`, err);
    }
  });

  log.info("[Cron] Hourly finalization job scheduled.");
};

module.exports = { initJobs };
