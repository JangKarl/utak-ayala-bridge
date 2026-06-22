const express = require("express");
const { body } = require("express-validator");
const ayalaController = require("../controllers/ayala.controller");

const router = express.Router();

/**
 * Route for checking server status.
 * GET /status
 */
router.get("/status", ayalaController.getStatus);
router.get("/getStatus", ayalaController.getStatus);

/**
 * Route for listing registered/current POS devices.
 * GET /devices
 */
router.get("/devices", ayalaController.getDevices);

/**
 * Route for generating End of Day reports.
 * POST /endOfDay
 */
router.post(
  "/endOfDay",
  [body("data").notEmpty().withMessage("Data is required")],
  ayalaController.handleEndOfDay,
);

/**
 * Route for checking existing EOD files.
 * POST /checkPreviousEOD
 */
router.post("/checkPreviousEOD", ayalaController.handleCheckPreviousEOD);

/**
 * Route for processing individual transactions.
 * POST /transaction
 */
router.post(
  "/transaction",
  [body("data").notEmpty().withMessage("Data is required")],
  ayalaController.handleTransaction,
);

/**
 * Route for processing consolidated hourly transactions.
 * POST /hourly
 */
router.post(
  "/hourly",
  [
    body("date").notEmpty().withMessage("Date is required"),
    body("hour").notEmpty().withMessage("Hour is required"),
    body("data").isArray().withMessage("Data must be an array"),
  ],
  ayalaController.handleHourly,
);

/**
 * Route for heartbeat health check.
 * Devices should call this endpoint to verify connectivity to the bridge.
 * GET /heartbeat
 */
router.get("/heartbeat", ayalaController.heartbeat);

/**
 * Route for claiming the cross-terminal EOD lock.
 * Body: { ccode, mmddyy, ter_no }
 * POST /eod/start
 */
router.post(
  "/eod/start",
  [
    body("ccode").notEmpty().withMessage("ccode is required"),
    body("mmddyy")
      .isLength({ min: 6, max: 6 })
      .withMessage("mmddyy must be 6 characters"),
    body("ter_no").notEmpty().withMessage("ter_no is required"),
  ],
  ayalaController.startEod,
);

/**
 * Route for polling the cross-terminal EOD lock + upload state.
 * Query: ?ccode=X&mmddyy=Y&ter_no=Z
 * GET /eod/status
 */
router.get("/eod/status", ayalaController.getEodStatus);

/**
 * Route for raising a cross-terminal reprocess of a past day's EOD. All
 * terminals re-submit (silently, in the background) and the bridge clean-
 * rebuilds the consolidated file, then cascades the grand-total chain forward.
 * Body: { ccode, mmddyy, ter_no }
 * POST /eod/reprocess
 */
router.post(
  "/eod/reprocess",
  [
    body("ccode").notEmpty().withMessage("ccode is required"),
    body("mmddyy")
      .isLength({ min: 6, max: 6 })
      .withMessage("mmddyy must be 6 characters"),
  ],
  ayalaController.handleReprocess,
);

/**
 * Route for claiming a store-wide-unique terminal number. Hard-rejects (409)
 * when a different device already owns the requested TER_NO for the CCCODE.
 * Body: { ccode, ter_no, device_id, uid? }
 * POST /terminal/register
 */
router.post(
  "/terminal/register",
  [
    body("ccode").notEmpty().withMessage("ccode is required"),
    body("ter_no").notEmpty().withMessage("ter_no is required"),
    body("device_id").notEmpty().withMessage("device_id is required"),
  ],
  ayalaController.registerTerminal,
);

/**
 * Read-only check of whether a terminal number is free for a store. Used by
 * the POS setup modal to pre-validate before saving.
 * Query: ?ccode=X&ter_no=Y&device_id=Z
 * GET /terminal/check
 */
router.get("/terminal/check", ayalaController.checkTerminal);

module.exports = router;
