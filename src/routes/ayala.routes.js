const express = require("express");
const { body } = require("express-validator");
const ayalaController = require("../controllers/ayala.controller");

const router = express.Router();

/**
 * Route for checking server status.
 * GET /status
 */
router.get("/status", ayalaController.getStatus);

/**
 * Route for generating End of Day reports.
 * POST /endOfDay
 */
router.post(
  "/endOfDay",
  [body("data").notEmpty().withMessage("Data is required")],
  ayalaController.handleEndOfDay
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
  ayalaController.handleTransaction
);

module.exports = router;
