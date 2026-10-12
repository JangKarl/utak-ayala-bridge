const cron = require("node-cron");
const log = require("electron-log");
const { accSender } = require("../services/accSender.service");

let task = null;

const run = () =>
  accSender()
    .sync()
    .catch((err) => log.error(`[ACC] sync failed: ${err.message}`));

// Every 5 minutes: cheap when there is nothing to send, and keeps a file
// within minutes of the cloud seeing the close or the deadline passing.
const initAccJobs = () => {
  task = cron.schedule("*/5 * * * *", run);
  setTimeout(run, 10 * 1000);
  log.info("[ACC] sync job started (every 5 minutes)");
};

const restartAccJobs = () => {
  if (task) task.stop();
  initAccJobs();
};

module.exports = { initAccJobs, restartAccJobs };
