const cron = require("node-cron");
const log = require("electron-log");
const fs = require("fs");
const path = require("path");
const ayalaService = require("../services/ayala.service");
const { TEMP_DIR } = require("../constants/ayala");

let cronTask = null;

const startCronJob = () => {
  cronTask = cron.schedule("0 * * * *", () => {
    const now = new Date();
    // Target the previous hour for finalization
    const targetTime = new Date(now.getTime() - 60 * 60 * 1000);
    const hour = targetTime.getHours();
    const date = `${(targetTime.getMonth() + 1).toString().padStart(2, "0")}_${targetTime
      .getDate()
      .toString()
      .padStart(2, "0")}_${targetTime.getFullYear().toString().slice(-2)}`;

    const tempFilePrefix = `temp_${date}_hour_${hour}_ter_`;

    log.info(
      `[Cron] Starting hourly finalization for hour ${hour}:00 (prefix: ${tempFilePrefix}*)`,
    );

    try {
      const allFiles = fs.readdirSync(TEMP_DIR);
      const terminalDrafts = allFiles.filter(
        (f) => f.startsWith(tempFilePrefix) && f.endsWith(".csv"),
      );

      if (terminalDrafts.length === 0) {
        log.info(`[Cron] No draft files found for hour ${hour}, skipping.`);
      } else {
        for (const tempFilename of terminalDrafts) {
          try {
            log.info(`[Cron] Processing draft: ${tempFilename}`);
            const officialFilename =
              ayalaService.finalizeHourlyDraft(tempFilename);

            if (officialFilename) {
              log.info(`[Cron] Success: Finalized ${officialFilename}`);
            } else {
              log.warn(
                `[Cron] Draft ${tempFilename} was empty or invalid and has been removed.`,
              );
            }
          } catch (err) {
            log.error(
              `[Cron] Critical error during hourly finalization of ${tempFilename}:`,
              err,
            );
          }
        }
      }
    } catch (err) {
      log.error(
        `[Cron] Critical error scanning temp directory for hour ${hour}:`,
        err,
      );
    }
  });

  log.info("[Cron] Hourly finalization job scheduled.");
};

/**
 * Initializes and starts the background jobs.
 */
const initJobs = () => {
  log.info("[Cron] Initializing Ayala background jobs...");
  startCronJob();
};

/**
 * Stops and restarts the cron job. Called when a system clock change is detected.
 */
const restartJobs = () => {
  log.info("[Cron] Restarting cron job due to clock change...");
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  startCronJob();
  log.info("[Cron] Cron job restarted successfully.");
};

/**
 * Stops all background jobs.
 */
const stopJobs = () => {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    log.info("[Cron] All jobs stopped.");
  }
};

module.exports = { initJobs, restartJobs, stopJobs };
