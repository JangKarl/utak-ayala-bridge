const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const ayalaService = require("../services/ayala.service");
const eodLockService = require("../services/eodLock.service");
const terminalRegistryService = require("../services/terminalRegistry.service");
const reprocessStateService = require("../services/reprocessState.service");
const eodConsolidationService = require("../services/eodConsolidation.service");
const { UPLOADS_DIR, STAGING_DIR } = require("../constants/ayala");
const { validationResult } = require("express-validator");
const { version: BRIDGE_VERSION } = require("../../package.json");

/** Live consolidated EOD file path for a store/day. */
function liveEodPath(ccode, mmddyy) {
  return path.join(UPLOADS_DIR, `EOD${ccode}${mmddyy}.csv`);
}

/**
 * Staging EOD path used while a clean rebuild is in progress. Kept under
 * STAGING_DIR (a TEMP_DIR subdir), NOT UPLOADS_DIR, so it is never seen by the
 * mall pickup or by listEodFilesForCcode.
 */
function stagingEodPath(ccode, mmddyy) {
  return path.join(STAGING_DIR, `EOD${ccode}${mmddyy}.csv`);
}

function readDeviceIdentity(req) {
  const src = req.method === "GET" ? req.query || {} : req.body || {};
  return {
    ccode: src.ccode,
    terNo: src.ter_no,
    deviceId: src.device_id,
    uid: src.uid || null,
    deviceName: src.device_name || null,
  };
}

function touchDevice(req, context) {
  const { ccode, terNo, deviceId, uid, deviceName } = readDeviceIdentity(req);
  if (!ccode || !terNo || !deviceId) return null;

  try {
    const result = terminalRegistryService.touch({
      ccode,
      terNo,
      deviceId,
      uid,
      deviceName,
    });
    if (!result.ok && result.conflict) {
      log.warn(
        `[${context}] TER_NO ${terNo} conflict on ccode=${ccode}: requested by device=${deviceId}, owned by device=${result.owner && result.owner.deviceId}.`,
      );
    }
    return result;
  } catch (err) {
    log.warn(`[${context}] Device presence update failed: ${err.message}`);
    return null;
  }
}

/**
 * Swaps a completed staging rebuild over the live EOD file (atomic) and
 * cascades each re-submitted terminal's grand-total chain forward. Terminals
 * that never re-submitted keep their carried-forward columns, because the
 * staging file started as a copy of the live file.
 */
function finalizeReprocess(ccode, mmddyy) {
  const state = reprocessStateService.getState({ ccode, mmddyy });
  const livePath = liveEodPath(ccode, mmddyy);
  const stagingPath = stagingEodPath(ccode, mmddyy);
  try {
    if (fs.existsSync(stagingPath)) {
      const content = fs.readFileSync(stagingPath, "utf-8");
      eodConsolidationService.atomicWriteFile(livePath, content);
      fs.rmSync(stagingPath, { force: true });
      log.info(`[Reprocess] Swapped staging -> live for ${ccode} ${mmddyy}`);
    } else {
      log.warn(
        `[Reprocess] No staging file to finalize for ${ccode} ${mmddyy}`,
      );
    }
    for (const ter of state.doneTerNos) {
      eodConsolidationService.normalizeTerminalGrandTotal({
        ccode,
        terNo: ter,
        mmddyy,
      });
      const { adjusted } = eodConsolidationService.cascadeTerminalForward({
        ccode,
        terNo: ter,
        afterMmddyy: mmddyy,
      });
      if (adjusted.length) {
        log.info(
          `[Reprocess] Cascaded TER ${ter}: ${adjusted.length} later day(s) adjusted`,
        );
      }
    }
    try {
      eodLockService.refresh({ ccode, mmddyy });
    } catch (_) {
      /* non-fatal */
    }
  } catch (err) {
    log.error(`[Reprocess] Finalize failed for ${ccode} ${mmddyy}:`, err);
  } finally {
    reprocessStateService.clear({ ccode, mmddyy });
  }
}

/**
 * Finalizes every pending reprocess whose carry-forward window has elapsed.
 * This covers offline terminals: staging was seeded from the live file, so
 * terminals that did not re-submit keep their existing day columns.
 */
function finalizeDueReprocesses() {
  const pending = reprocessStateService.listPending();
  const finalized = [];

  for (const entry of pending) {
    if (!reprocessStateService.shouldFinalize(entry)) continue;

    finalizeReprocess(entry.ccode, entry.mmddyy);
    finalized.push({
      ccode: entry.ccode,
      mmddyy: entry.mmddyy,
      doneTerNos: entry.doneTerNos,
      carriedForwardTerNos: entry.pendingTerNos,
    });
  }

  return finalized;
}

/**
 * Controller for handling Ayala API requests.
 */
class AyalaController {
  finalizeDueReprocesses() {
    return finalizeDueReprocesses();
  }

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
      version: BRIDGE_VERSION,
      devices: terminalRegistryService.listDevices(),
    });
  }

  /**
   * Returns registered POS devices with online state and latest connection time.
   */
  getDevices(req, res) {
    const { ccode } = req.query || {};
    res.json({
      devices: terminalRegistryService.listDevices({ ccode: ccode || null }),
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

    const stagedTransactionFiles = [];
    let finalizedFiles = [];

    try {
      const { data } = req.body;
      const incoming = Array.isArray(data) ? data : [data];
      const first = incoming[0];
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

      const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
      const dd = dt.getDate().toString().padStart(2, "0");
      const yy = dt.getFullYear().toString().slice(-2);
      const mmddyy = `${mm}${dd}${yy}`;
      const reproState = reprocessStateService.getState({ ccode, mmddyy });
      const incomingTerNos = incoming.map((t) =>
        String(t.TER_NO || "").padStart(3, "0"),
      );

      if (reproState.inProgress) {
        const pending = new Set(reproState.pendingTerNos);
        for (const ter of new Set(incomingTerNos)) {
          if (!pending.has(ter)) continue;
          stagedTransactionFiles.push(
            ayalaService.stageOfficialTransactionFilesForReprocess({
              ccode,
              mmddyy,
              terNo: ter,
            }),
          );
        }
      }

      // Finalize any pending temp files before generating EOD
      try {
        finalizedFiles = ayalaService.finalizeAllTempFilesForDate(trnDate);
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
        for (const staged of stagedTransactionFiles) {
          ayalaService.restoreStagedTransactionFiles(staged);
        }
        return res.status(500).json({
          error: "Failed to finalize pending transaction files",
          details: finalizationError.message,
        });
      }

      if (reproState.inProgress) {
        for (const terminalData of incoming) {
          const ter = String(terminalData.TER_NO || "").padStart(3, "0");
          const noTrn = Number(terminalData.NO_TRN || 0);
          const prefix = `${ccode}${mmddyy}${ter}_`;
          const hasRegeneratedHourly = finalizedFiles.some((file) =>
            file.startsWith(prefix),
          );

          if (noTrn > 0 && !hasRegeneratedHourly) {
            for (const staged of stagedTransactionFiles) {
              ayalaService.restoreStagedTransactionFiles(staged);
            }
            log.error(
              `[EndOfDay] Reprocess rejected for ${ccode} ${mmddyy} TER ${ter}: EOD has NO_TRN=${noTrn} but no regenerated hourly/per-transaction file was finalized.`,
            );
            return res.status(409).json({
              error:
                "Reprocess requires regenerated hourly/per-transaction files before EOD",
              ccode,
              mmddyy,
              ter_no: ter,
            });
          }
        }
      }

      let filename;

      if (reproState.inProgress) {
        // A cross-terminal reprocess is active for this day: write into the
        // staging rebuild (never the live file) and mark this terminal done.
        // The live file is only replaced once the rebuild finalizes.
        const stagingPath = stagingEodPath(ccode, mmddyy);
        filename = ayalaService.generateEodFile(data, {
          targetPath: stagingPath,
        });
        const doneNow = incomingTerNos;
        for (const ter of doneNow) {
          reprocessStateService.markTerminalDone({ ccode, mmddyy, terNo: ter });
        }
        log.info(
          `[EndOfDay] Reprocess staging: terminal(s) ${doneNow.join(
            ",",
          )} for ${ccode} ${mmddyy}`,
        );
        if (reprocessStateService.shouldFinalize({ ccode, mmddyy })) {
          finalizeReprocess(ccode, mmddyy);
        }
      } else {
        filename = ayalaService.generateEodFile(data);
        for (const ter of new Set(incomingTerNos)) {
          eodConsolidationService.normalizeTerminalGrandTotal({
            ccode,
            terNo: ter,
            mmddyy,
          });
          eodConsolidationService.cascadeTerminalForward({
            ccode,
            terNo: ter,
            afterMmddyy: mmddyy,
          });
        }
        log.info(`[EndOfDay] Success: Generated ${filename}`);

        // Refresh the cross-terminal lock so polling siblings continue to see
        // "EOD in progress" until the natural day rollover. The CSV file's
        // existence is the authoritative "EOD has happened" signal.
        try {
          eodLockService.refresh({ ccode, mmddyy });
        } catch (lockErr) {
          log.warn(`[EndOfDay] Lock refresh failed (non-fatal):`, lockErr);
        }
      }

      for (const staged of stagedTransactionFiles) {
        ayalaService.discardStagedTransactionFiles(staged);
      }

      res.status(200).json({
        message: "End of Day report generated",
        file: filename,
      });
    } catch (error) {
      for (const staged of stagedTransactionFiles) {
        ayalaService.restoreStagedTransactionFiles(staged);
      }
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
    touchDevice(req, "Heartbeat");
    res.json({
      status: "alive",
      timestamp: new Date().toISOString(),
      devices: terminalRegistryService.listDevices(),
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
      const { ccode, mmddyy, ter_no, device_id, uid, device_name } =
        req.body || {};
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
      const { ccode, mmddyy, ter_no, device_id, uid, device_name } =
        req.query || {};
      if (!ccode) {
        return res.status(400).json({ error: "ccode is required" });
      }
      if (device_id && ter_no) {
        try {
          terminalRegistryService.register({
            ccode,
            terNo: ter_no,
            deviceId: device_id,
            uid: uid || null,
            deviceName: device_name || null,
          });
        } catch (regErr) {
          log.warn(
            `[EodStatus] Registry backfill failed (non-fatal): ${regErr.message}`,
          );
        }
      }
      if (!mmddyy) {
        const ter = ter_no ? String(ter_no).trim().padStart(3, "0") : null;
        const reprocessPending = reprocessStateService
          .listPending()
          .filter((entry) => entry.ccode === ccode)
          .map((entry) => ({
            ...entry,
            selfPending: ter ? entry.pendingTerNos.includes(ter) : false,
          }))
          .filter((entry) => !ter || entry.selfPending);

        return res.status(200).json({ reprocessPending });
      }
      if (String(mmddyy).length !== 6) {
        return res.status(400).json({ error: "mmddyy must be 6 chars" });
      }
      const result = eodLockService.status({ ccode, mmddyy, terNo: ter_no });
      const reprocess = reprocessStateService.getState({
        ccode,
        mmddyy,
        terNo: ter_no,
      });
      return res.status(200).json({ ...result, reprocess });
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
      const { ccode, ter_no, device_id, uid, device_name, force } =
        req.body || {};
      const result = terminalRegistryService.register({
        ccode,
        terNo: ter_no,
        deviceId: device_id,
        uid: uid || null,
        deviceName: device_name || null,
        force: !!force,
      });

      if (!result.ok && result.conflict) {
        log.warn(
          `[TerminalRegister] CONFLICT ccode=${ccode} ter_no=${ter_no} requested by device=${device_id}, owned by device=${result.owner && result.owner.deviceId}`,
        );
        return res.status(409).json(result);
      }

      if (result.tookOverFrom) {
        log.warn(
          `[TerminalRegister] TAKEOVER ccode=${ccode} ter_no=${ter_no} device=${device_id} reassigned from device=${result.tookOverFrom.deviceId}`,
        );
      }

      log.info(
        `[TerminalRegister] ccode=${ccode} ter_no=${ter_no} device=${device_id} -> ok${
          result.tookOverFrom ? " (takeover)" : ""
        }`,
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

  /**
   * Raises a cross-terminal reprocess for (CCCODE, MMDDYY): snapshots the live
   * EOD file (so non-resubmitting terminals can be carried forward), opens a
   * staging rebuild, and records which terminals are expected to re-submit.
   * Terminals re-submit through /endOfDay; the bridge swaps the rebuild in and
   * cascades the per-terminal grand-total chain forward once all expected
   * terminals are done (or the finalize window elapses).
   *
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   */
  handleReprocess(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      log.error(`[Reprocess] Validation failed:`, errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { ccode, mmddyy, ter_no, device_id, uid, device_name } =
        req.body || {};

      if (device_id && ter_no) {
        try {
          terminalRegistryService.register({
            ccode,
            terNo: ter_no,
            deviceId: device_id,
            uid: uid || null,
            deviceName: device_name || null,
          });
        } catch (regErr) {
          log.warn(
            `[Reprocess] Registry backfill failed (non-fatal): ${regErr.message}`,
          );
        }
      }

      const livePath = liveEodPath(ccode, mmddyy);
      const expectedTerNos = new Set(terminalRegistryService.listTerNos(ccode));

      if (fs.existsSync(livePath)) {
        try {
          for (const ter of eodConsolidationService.parseEodColumns(livePath)
            .terNos) {
            expectedTerNos.add(ter);
          }
          // Seed the staging rebuild with a copy of the live file so terminals
          // that don't re-submit are carried forward unchanged.
          const stagingPath = stagingEodPath(ccode, mmddyy);
          fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
          fs.copyFileSync(livePath, stagingPath);
        } catch (snapErr) {
          log.warn(
            `[Reprocess] Could not snapshot live EOD for ${ccode} ${mmddyy}: ${snapErr.message}`,
          );
        }
      } else {
        log.warn(
          `[Reprocess] No existing EOD for ${ccode} ${mmddyy}; rebuild starts empty.`,
        );
      }

      const expected = Array.from(expectedTerNos).sort();
      const state = reprocessStateService.markDirty({
        ccode,
        mmddyy,
        byTerNo: ter_no,
        expectedTerNos: expected,
      });
      log.info(
        `[Reprocess] Raised for ${ccode} ${mmddyy} by TER ${ter_no}; expected=[${expected.join(
          ",",
        )}]`,
      );
      return res.status(200).json(state);
    } catch (error) {
      log.error("[Reprocess] Critical Error:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
}

module.exports = new AyalaController();
