const log = require("electron-log");
const ayalaService = require("../services/ayala.service");
const eodLockService = require("../services/eodLock.service");
const terminalRegistryService = require("../services/terminalRegistry.service");
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
      version: "1.0.0",
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
      const first = Array.isArray(data) ? data[0] : data;
      const ccode = first.CCCODE;
      const trnDate = first.TRN_DATE;

      if (!ccode || !trnDate) {
        log.error("[EndOfDay] Missing CCCODE or TRN_DATE");
        return res
          .status(400)
          .json({ error: "CCCODE and TRN_DATE are required" });
      }

      const dt = new Date(trnDate);
      if (isNaN(dt.getTime())) {
        log.error(`[EndOfDay] Invalid TRN_DATE: ${trnDate}`);
        return res.status(400).json({ error: "Invalid TRN_DATE format" });
      }

      log.info(
        `[EndOfDay] Request received for CCCODE: ${ccode} Date: ${trnDate}`,
      );

      // Finalize any pending temp files before generating EOD
      try {
        const finalizedFiles =
          ayalaService.finalizeAllTempFilesForDate(trnDate);
        if (finalizedFiles.length > 0) {
          log.info(
            `[EndOfDay] Finalized ${finalizedFiles.length} pending temp file(s)`,
          );
        }
      } catch (finalizationError) {
        log.error(
          `[EndOfDay] Temp file finalization failed:`,
          finalizationError,
        );
        return res.status(500).json({
          error: "Failed to finalize pending transaction files",
          details: finalizationError.message,
        });
      }

      const filename = ayalaService.generateEodFile(data);
      log.info(`[EndOfDay] Success: Generated ${filename}`);

      // Refresh the cross-terminal lock so polling siblings continue to see
      // "EOD in progress" until the natural day rollover. The CSV file's
      // existence is the authoritative "EOD has happened" signal.
      try {
        const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
        const dd = dt.getDate().toString().padStart(2, "0");
        const yy = dt.getFullYear().toString().slice(-2);
        const mmddyy = `${mm}${dd}${yy}`;
        eodLockService.refresh({ ccode, mmddyy });
      } catch (lockErr) {
        log.warn(`[EndOfDay] Lock refresh failed (non-fatal):`, lockErr);
      }

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

  /**
   * Processes consolidated hourly transactions.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  handleHourly(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      log.error(`[Hourly] Validation failed:`, errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { date, hour, data } = req.body;

      log.info(
        `[Hourly] Processing ${data.length} transactions for date: ${date}, hour: ${hour}`,
      );

      const filename = ayalaService.appendHourlyTransactions(date, hour, data);
      log.info(`[Hourly] Success: Appended to ${filename}`);

      res
        .status(200)
        .json({ message: "Hourly transactions recorded", file: filename });
    } catch (error) {
      log.error("[Hourly] Critical Error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }

  /**
   * Returns heartbeat response for passive health monitoring.
   * Devices should call this endpoint to verify connectivity to the bridge.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  heartbeat(req, res) {
    res.json({
      status: "alive",
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Claims the EOD lock for (CCCODE, MMDDYY). Idempotent for the same TER_NO.
   * If a different terminal already holds the lock, returns acquired:false
   * with that terminal's TER_NO so the caller can display "leader" info.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  startEod(req, res) {
    try {
      const { ccode, mmddyy, ter_no, device_id, uid } = req.body || {};
      if (!ccode || !mmddyy || mmddyy.length !== 6 || !ter_no) {
        log.error("[EodStart] Missing or invalid ccode/mmddyy/ter_no");
        return res
          .status(400)
          .json({ error: "ccode, mmddyy (6 chars), and ter_no are required" });
      }

      // Best-effort registry backfill so terminals provisioned before the
      // collision guard existed still get an owner recorded. A conflict is
      // logged but does NOT block the upload — rejecting /eod/start would
      // strand that terminal's sales. Hard enforcement lives at
      // /terminal/register (the POS setup modal).
      if (device_id) {
        try {
          const reg = terminalRegistryService.register({
            ccode,
            terNo: ter_no,
            deviceId: device_id,
            uid: uid || null,
          });
          if (!reg.ok && reg.conflict) {
            log.warn(
              `[EodStart] TER_NO ${ter_no} conflict on ccode=${ccode}: requested by device=${device_id}, owned by device=${reg.owner && reg.owner.deviceId}. Proceeding with upload anyway.`,
            );
          }
        } catch (regErr) {
          log.warn(
            `[EodStart] Registry backfill failed (non-fatal): ${regErr.message}`,
          );
        }
      }

      const result = eodLockService.claim({ ccode, mmddyy, terNo: ter_no });
      log.info(
        `[EodStart] ccode=${ccode} mmddyy=${mmddyy} terNo=${ter_no} -> acquired=${result.acquired} leader=${result.startedBy}`,
      );
      return res.status(200).json(result);
    } catch (error) {
      log.error("[EodStart] Critical Error:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  /**
   * Returns lock + upload state for (CCCODE, MMDDYY) as seen by the calling
   * TER_NO. Terminals poll this to decide whether to block transactions.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  getEodStatus(req, res) {
    try {
      const { ccode, mmddyy, ter_no } = req.query || {};
      if (!ccode || !mmddyy || String(mmddyy).length !== 6) {
        return res
          .status(400)
          .json({ error: "ccode and mmddyy (6 chars) are required" });
      }
      const result = eodLockService.status({ ccode, mmddyy, terNo: ter_no });
      return res.status(200).json(result);
    } catch (error) {
      log.error("[EodStatus] Critical Error:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  /**
   * Claims a store-wide-unique terminal number for a device. Hard-rejects with
   * HTTP 409 when a different device already owns the requested TER_NO for the
   * CCCODE, preventing the silent EOD-column overwrite that a duplicate TER_NO
   * would cause.
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  registerTerminal(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      log.error(`[TerminalRegister] Validation failed:`, errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { ccode, ter_no, device_id, uid } = req.body || {};
      const result = terminalRegistryService.register({
        ccode,
        terNo: ter_no,
        deviceId: device_id,
        uid: uid || null,
      });

      if (!result.ok && result.conflict) {
        log.warn(
          `[TerminalRegister] CONFLICT ccode=${ccode} ter_no=${ter_no} requested by device=${device_id}, owned by device=${result.owner && result.owner.deviceId}`,
        );
        return res.status(409).json(result);
      }

      log.info(
        `[TerminalRegister] ccode=${ccode} ter_no=${ter_no} device=${device_id} -> ok`,
      );
      return res.status(200).json(result);
    } catch (error) {
      log.error("[TerminalRegister] Critical Error:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  /**
   * Read-only check of whether a terminal number is free for a store. Used by
   * the POS setup modal to pre-validate before saving (no mutation).
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  checkTerminal(req, res) {
    try {
      const { ccode, ter_no, device_id } = req.query || {};
      if (!ccode || !ter_no) {
        return res.status(400).json({ error: "ccode and ter_no are required" });
      }
      const result = terminalRegistryService.check({
        ccode,
        terNo: ter_no,
        deviceId: device_id || null,
      });
      return res.status(200).json(result);
    } catch (error) {
      log.error("[TerminalCheck] Critical Error:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
}

module.exports = new AyalaController();
