const express = require("express");
const { body } = require("express-validator");
const accController = require("../controllers/acc.controller");

const router = express.Router();

// Health check for the tablets and support.
router.get("/status", accController.getStatus);
router.get("/acc/status", accController.getStatus);

/**
 * POST /acc/transaction { txns: [{ key, val }] }
 * The same records the tablet saves to the cloud; a re-send (refund, void)
 * replaces the earlier version of that transaction.
 */
router.post(
  "/acc/transaction",
  [
    body("txns").isArray({ min: 1 }),
    body("txns.*.key").matches(/^\d{9,11}$/),
    body("txns.*.val").isObject(),
  ],
  accController.handleTransactions,
);

/**
 * POST /acc/close { shiftKey: YYMMDD, terminal, count, lastReceiptNo? }
 * count = sales this terminal made that day; used for the completeness check.
 */
router.post(
  "/acc/close",
  [
    body("shiftKey").matches(/^\d{6}$/),
    body("terminal").isInt({ min: 1 }),
    body("count").isInt({ min: 0 }),
  ],
  accController.handleClose,
);

module.exports = router;
