const log = require("electron-log");
const moment = require("moment-timezone");
const ayalaService = require("../services/ayala.service");
const { validationResult } = require("express-validator");

/**
 * Controller for handling Ayala API requests.
 */
class AyalaController {
  /**
   * Returns the status of the server.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  getStatus(req, res) {
    res.json({
      status: "Server is running",
      bridge: "ayala-bridge",
      version: "1.1.0",
    });
  }

  /**
   * Processes the End of Day report request.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  handleEndOfDay(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      log.error(`[EndOfDay] Validation failed:`, errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { data } = req.body;
      const ccode = data.CCCODE;
      const trnDate = data.TRN_DATE;

      if (!ccode || !trnDate) {
        log.error("[EndOfDay] Missing CCCODE or TRN_DATE");
        return res
          .status(400)
          .json({ error: "CCCODE and TRN_DATE are required" });
      }

      const dt = moment(trnDate);
      if (!dt.isValid()) {
        log.error(`[EndOfDay] Invalid TRN_DATE: ${trnDate}`);
        return res.status(400).json({ error: "Invalid TRN_DATE format" });
      }

      log.info(
        `[EndOfDay] Request received for CCCODE: ${ccode} Date: ${trnDate}`,
      );
      const filename = ayalaService.generateEodFile(data);
      log.info(`[EndOfDay] Success: Generated ${filename}`);

      res.status(200).json({
        message: "End of Day report generated",
        file: filename,
      });
    } catch (error) {
      log.error("[EndOfDay] Critical Error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }

  /**
   * Checks for previous EOD files.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  handleCheckPreviousEOD(req, res) {
    const { ccode, mmddyy } = req.body;

    if (!ccode || !mmddyy || mmddyy.length !== 6) {
      log.error("[CheckPreviousEOD] Missing or invalid CCCODE or MMDDYY");
      return res
        .status(400)
        .json({ error: "CCCODE and valid MMDDYY are required" });
    }

    try {
      log.info(
        `[CheckPreviousEOD] Checking for CCCODE: ${ccode} MMDDYY: ${mmddyy}`,
      );
      const matchingFiles = ayalaService.checkPreviousEOD(ccode, mmddyy);

      if (matchingFiles.length > 0) {
        log.info(`[CheckPreviousEOD] Found files: ${matchingFiles.join(", ")}`);
        return res.status(200).json({ exists: true, files: matchingFiles });
      } else {
        log.info(`[CheckPreviousEOD] No files found.`);
        return res.status(200).json({ exists: false, files: [] });
      }
    } catch (error) {
      log.error("[CheckPreviousEOD] Critical Error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }

  /**
   * Processes an individual transaction request.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  handleTransaction(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      log.error(`[Transaction] Validation failed:`, errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { data } = req.body;
      const trnNo = data.TRANSACTION_NO || "UNKNOWN_TRN";
      const grossSales = data.GROSS_SLS || "0.00";
      const itemsCount = data.items?.length || 0;

      log.info(
        `[Transaction] Processing TRN: ${trnNo} | Gross: ${grossSales} | Items: ${itemsCount}`,
      );

      const filename = ayalaService.appendTransaction(data);
      log.info(`[Transaction] Success: TRN ${trnNo} appended to ${filename}`);

      res.status(200).json({ message: "Transaction recorded", file: filename });
    } catch (error) {
      log.error("[Transaction] Critical Error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
}

module.exports = new AyalaController();
