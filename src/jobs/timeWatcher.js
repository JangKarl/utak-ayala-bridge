const log = require("electron-log");

// Poll every 15 seconds
const POLL_INTERVAL_MS = 15_000;
// Trigger if clock jumped more than 2 minutes from expected
const DRIFT_THRESHOLD_MS = 120_000;

let watcherInterval = null;

/**
 * Starts polling the system clock for manual time changes.
 * When a jump greater than DRIFT_THRESHOLD_MS is detected, calls onTimeChange().
 *
 * @param {() => void} onTimeChange - Callback invoked when a clock change is detected.
 */
const startTimeWatcher = (onTimeChange) => {
  if (watcherInterval) return; // already running

  let lastChecked = Date.now();

  watcherInterval = setInterval(() => {
    const now = Date.now();
    const actualElapsed = now - lastChecked;
    const drift = Math.abs(actualElapsed - POLL_INTERVAL_MS);

    if (drift > DRIFT_THRESHOLD_MS) {
      const direction = actualElapsed > POLL_INTERVAL_MS ? "forward" : "backward";
      log.info(
        `[TimeWatcher] Clock change detected (jumped ~${Math.round((actualElapsed - POLL_INTERVAL_MS) / 60000)} min ${direction}). Triggering sync.`,
      );
      onTimeChange();
    }

    lastChecked = now;
  }, POLL_INTERVAL_MS);

  log.info("[TimeWatcher] System clock watcher started (polling every 15s).");
};

/**
 * Stops the system clock watcher.
 */
const stopTimeWatcher = () => {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    log.info("[TimeWatcher] System clock watcher stopped.");
  }
};

module.exports = { startTimeWatcher, stopTimeWatcher };
