const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const {
  EOD_FIELDS,
  FILE_HEADER_FIELDS,
  TRANSACTION_FIELDS,
  ITEM_FIELDS,
  UPLOADS_DIR,
  TEMP_DIR,
  STAGING_DIR,
} = require("../constants/ayala");
const {
  formatValue,
  atomicWriteFile,
  parseWireDate,
  mmddyy,
  mmddyyUnderscored,
  nowTz,
} = require("../utils");

// Ensure required directories exist on startup
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/**
 * Parses a single CSV line, respecting double-quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function _parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Thrown when an incoming record's TRANSACTION_NO already exists in the
 * target draft under a DIFFERENT SLS_FLAG (e.g. a sale and a refund sharing
 * the same identifier). This is distinct from a legitimate duplicate re-send
 * (same TRANSACTION_NO, same SLS_FLAG — a queue-drain retry or reprocess
 * re-run), which is still silently absorbed. A collision means the POS-side
 * TRANSACTION_NO allocation is broken and MUST be surfaced loudly rather
 * than resolved by silently keeping one side — Ayala's own validator
 * rejects a file with a repeated TRANSACTION_NO outright, so silently
 * dropping the second occurrence here would just convert a visible mall
 * rejection into an invisible dropped row (see task e5fad5f5 /
 * mamonaku_vermosa 2026-08-04).
 */
class TrnNoCollisionError extends Error {
  constructor(message) {
    super(message);
    this.name = "TrnNoCollisionError";
    this.code = "TRN_NO_COLLISION";
  }
}

/**
 * Moves a file, falling back to copy+unlink when source and destination are on
 * different volumes. fs.renameSync throws EXDEV across drives, which can happen
 * now that the staging area (TEMP_DIR) may sit on a different drive than an
 * overridden UPLOADS_DIR.
 */
function _safeMove(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    } else {
      throw err;
    }
  }
}

/**
 * Service for handling Ayala-specific file generation and operations.
 */
class AyalaService {
  /**
   * Generates an End of Day (EOD) CSV file.
   *
   * Supports both single-terminal (data is an object) and multi-terminal
   * (data is an array of objects). Multi-terminal output uses one column per
   * terminal: FIELD,VAL_TER1,VAL_TER2,...
   *
   * If an EOD file for the same CCCODE+DATE already exists on disk, incoming
   * terminals are **upserted by TER_NO**: a terminal that already appears in
   * the file is replaced; a new terminal is appended. This allows two Utak
   * accounts sharing one store (same CCCODE, different TER_NO) to each trigger
   * their own EOD and have the bridge consolidate them into a single file.
   *
   * @param {Object|Object[]} data - EOD data object or array of per-terminal objects.
   * @param {{ targetPath?: string }} [options] - When targetPath is supplied
   *   (e.g. a .staging rebuild file), write/upsert there instead of the live
   *   uploads path. The upsert baseline is read from the same target, so any
   *   carried-forward terminal columns are preserved.
   * @returns {string} The generated filename.
   */
  generateEodFile(data, options = {}) {
    const incoming = Array.isArray(data) ? data : [data];
    const first = incoming[0];

    const ccode = first.CCCODE;
    const trnDate = first.TRN_DATE;

    const dateMMDDYY = mmddyy(trnDate);
    if (!dateMMDDYY) {
      throw new Error(`Invalid TRN_DATE "${trnDate}" in EOD payload`);
    }

    const filename = `EOD${ccode}${dateMMDDYY}.csv`;
    const filePath = options.targetPath || path.join(UPLOADS_DIR, filename);

    // If a file already exists for this CCCODE+DATE, parse its terminal columns
    // so we can upsert rather than overwrite.
    const existingTerminals = [];
    if (fs.existsSync(filePath)) {
      try {
        const existingContent = fs.readFileSync(filePath, "utf-8");
        const lines = existingContent.split("\n").filter((l) => l.trim() !== "");
        if (lines.length > 0) {
          const colCount = _parseCsvLine(lines[0]).length - 1;
          if (colCount > 0) {
            // Build field -> [val_ter1, val_ter2, ...] map
            const fieldMap = {};
            for (const line of lines) {
              const parts = _parseCsvLine(line);
              fieldMap[parts[0]] = parts.slice(1);
            }
            for (let i = 0; i < colCount; i++) {
              const termObj = {};
              EOD_FIELDS.forEach((field) => {
                termObj[field] =
                  fieldMap[field] && fieldMap[field][i] !== undefined
                    ? fieldMap[field][i]
                    : "";
              });
              existingTerminals.push(termObj);
            }
            log.info(
              `[GenerateEodFile] Loaded ${colCount} existing terminal(s) from ${filename}`,
            );
          }
        }
      } catch (parseErr) {
        log.warn(
          `[GenerateEodFile] Could not parse existing file ${filename}, will overwrite: ${parseErr.message}`,
        );
      }
    }

    // Upsert incoming terminals by TER_NO into the existing set
    const merged = [...existingTerminals];
    for (const terminal of incoming) {
      const terNo = String(terminal.TER_NO || "").padStart(3, "0");
      const idx = merged.findIndex(
        (col) => String(col.TER_NO || "").padStart(3, "0") === terNo,
      );
      if (idx >= 0) {
        log.info(
          `[GenerateEodFile] Replacing existing terminal ${terNo} in ${filename}`,
        );
        merged[idx] = terminal;
      } else {
        log.info(
          `[GenerateEodFile] Adding terminal ${terNo} to ${filename} (total: ${merged.length + 1})`,
        );
        merged.push(terminal);
      }
    }

    // Keep terminals sorted by TER_NO ascending for deterministic output
    merged.sort((a, b) => {
      const aTer = String(a.TER_NO || "").padStart(3, "0");
      const bTer = String(b.TER_NO || "").padStart(3, "0");
      return aTer.localeCompare(bTer);
    });

    // Write CSV — always use the multi-column path (works for single terminal too)
    let csvContent = "";
    EOD_FIELDS.forEach((field) => {
      const vals = merged.map((d) =>
        formatValue(field, d[field] !== undefined ? d[field] : ""),
      );
      csvContent += `${field},${vals.join(",")}\n`;
    });

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Atomic write: the live EOD{ccode}{mmddyy}.csv is what the mall ingests —
    // a crash mid-write must never leave it half-written.
    atomicWriteFile(filePath, csvContent);
    return filename;
  }

  /**
   * Reads the TRANSACTION_NO -> SLS_FLAG map already present in an hourly
   * draft file. Used to make appends idempotent — a transaction re-sent by
   * the POS (queue drain retry, reprocess re-run) must not be appended
   * twice, or Ayala's validator rejects the finalized file with "There are
   * same TRANSACTION_NO" — AND to distinguish that legitimate re-send (same
   * TRANSACTION_NO, same SLS_FLAG) from a genuine collision (same
   * TRANSACTION_NO, a DIFFERENT SLS_FLAG — e.g. a sale and a refund sharing
   * one identifier), which callers should treat as an error rather than
   * silently absorb. See TrnNoCollisionError.
   *
   * @param {string} tempPath - Absolute path to the hourly draft temp file.
   * @returns {Map<string, string>} TRANSACTION_NO -> SLS_FLAG currently in the draft.
   */
  _readExistingTrnRecords(tempPath) {
    const map = new Map();
    if (!fs.existsSync(tempPath)) return map;
    const content = fs.readFileSync(tempPath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("TRANSACTION_NO,")) {
        const trnNo = lines[i].split(",")[1]?.replace(/"/g, "").trim() || "";
        if (!trnNo) continue;
        // SLS_FLAG is one of the fixed TRANSACTION_FIELDS rows within the
        // same per-transaction block; scan forward within this block (up to
        // the next TRANSACTION_NO line) rather than assuming a fixed offset.
        let slsFlag = "";
        for (let j = i + 1; j < lines.length && !lines[j].startsWith("TRANSACTION_NO,"); j++) {
          if (lines[j].startsWith("SLS_FLAG,")) {
            slsFlag = lines[j].split(",")[1]?.replace(/"/g, "").trim() || "";
            break;
          }
        }
        map.set(trnNo, slsFlag);
      }
    }
    return map;
  }

  /**
   * Reads the business date an hourly draft declares in its own header. Used to
   * tell a pre-fix draft whose FILENAME date is stale (but whose TRN_DATE is
   * correct) apart from a draft that genuinely belongs to another business day.
   *
   * @param {string} tempPath - Absolute path to the hourly draft temp file.
   * @returns {string|null} The draft's TRN_DATE, or null if unreadable.
   */
  _readDraftTrnDate(tempPath) {
    try {
      const content = fs.readFileSync(tempPath, "utf-8");
      const line = content
        .split("\n")
        .find((l) => l.startsWith("TRN_DATE,"));
      if (!line) return null;
      const value = line.split(",")[1];
      return value ? value.replace(/"/g, "").trim() : null;
    } catch (err) {
      log.warn(
        `[FinalizeTempFiles] Could not read TRN_DATE from ${tempPath}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Appends transaction data to a temporary hourly draft file.
   *
   * @param {Object} data - The transaction data object.
   * @returns {string} The temporary filename.
   */
  appendTransaction(data) {
    const now = nowTz();

    // Derive hour from TRN_TIME ("HH:MM") so the temp file bucket matches
    // the transaction time, not the server's wall-clock hour.
    let hour = now.hours();
    if (data.TRN_TIME) {
      const parsed = parseInt(data.TRN_TIME.split(":")[0], 10);
      if (!isNaN(parsed)) {
        hour = parsed;
      } else {
        log.warn(
          `[AppendTransaction] Invalid TRN_TIME "${data.TRN_TIME}", falling back to server hour`,
        );
      }
    } else {
      log.warn(
        "[AppendTransaction] TRN_TIME missing from payload, falling back to server hour",
      );
    }

    let dateSource = null;
    if (data.TRN_DATE) {
      const parsed = parseWireDate(data.TRN_DATE);
      if (parsed.isValid()) {
        dateSource = parsed;
      } else {
        log.warn(
          `[AppendTransaction] Invalid TRN_DATE "${data.TRN_DATE}", falling back to server date`,
        );
      }
    } else {
      log.warn(
        "[AppendTransaction] TRN_DATE missing from payload, falling back to server date",
      );
    }

    if (!dateSource) {
      dateSource = now;
    }

    const date = dateSource.format("MM_DD_YY");
    const terNo = String(data.TER_NO || "1").trim().padStart(3, "0");
    const tempFilename = `temp_${date}_hour_${hour}_ter_${terNo}.csv`;
    const tempPath = path.join(TEMP_DIR, tempFilename);

    // Idempotency: skip a transaction already present in the draft so a re-send
    // (queue drain retry / reprocess re-run) can't produce a duplicate column.
    // A DIFFERENT SLS_FLAG under the same TRANSACTION_NO is not a re-send —
    // it's a collision (the POS allocated the same identifier to two distinct
    // events) — and must be surfaced as an error, not silently dropped.
    const incomingTrnNo = String(data.TRANSACTION_NO ?? "").trim();
    if (incomingTrnNo) {
      const existingFlag = this._readExistingTrnRecords(tempPath).get(incomingTrnNo);
      if (existingFlag !== undefined) {
        const incomingFlag = String(data.SLS_FLAG ?? "").trim();
        if (existingFlag === incomingFlag) {
          log.warn(
            `[AppendTransaction] Skipping duplicate TRANSACTION_NO ${incomingTrnNo} for ter ${terNo} (already in ${tempFilename})`,
          );
          return tempFilename;
        }
        throw new TrnNoCollisionError(
          `TRANSACTION_NO ${incomingTrnNo} already exists in ${tempFilename} as SLS_FLAG=${existingFlag}, incoming SLS_FLAG=${incomingFlag}`,
        );
      }
    }

    let rowsToAppend = "";

    if (!fs.existsSync(tempPath)) {
      FILE_HEADER_FIELDS.forEach((field) => {
        const val = field === "NO_TRN" ? "0" : data[field] || "";
        rowsToAppend += `${field},${formatValue(field, val)}\n`;
      });
    }

    TRANSACTION_FIELDS.forEach((field) => {
      const val = data[field] !== undefined ? data[field] : "";
      rowsToAppend += `${field},${formatValue(field, val)}\n`;
    });

    (data.items || []).forEach((item) => {
      ITEM_FIELDS.forEach((field) => {
        const val = item[field] !== undefined ? item[field] : "";
        rowsToAppend += `${field},${formatValue(field, val)}\n`;
      });
    });

    fs.appendFileSync(tempPath, rowsToAppend);
    return tempFilename;
  }

  /**
   * Appends consolidated hourly transactions to a temporary hourly draft file.
   *
   * @param {string} dateStr - The date string in YYMMDD format.
   * @param {string} hour - The hour string.
   * @param {Array} transactions - Array of transaction data objects.
   * @returns {string} The temporary filename.
   */
  appendHourlyTransactions(dateStr, hour, transactions) {
    // Parse YYMMDD to MM_DD_YY
    const yy = dateStr.substring(0, 2);
    const mm = dateStr.substring(2, 4);
    const dd = dateStr.substring(4, 6);
    const date = `${mm}_${dd}_${yy}`;
    const terNo = String((transactions[0] && transactions[0].TER_NO) || "1").trim().padStart(3, "0");

    const tempFilename = `temp_${date}_hour_${hour}_ter_${terNo}.csv`;
    const tempPath = path.join(TEMP_DIR, tempFilename);

    // Idempotency: drop any transaction whose TRANSACTION_NO already exists in
    // the draft, or is duplicated within this batch (keep the first). A re-sent
    // batch would otherwise produce duplicate columns that Ayala's validator
    // rejects ("There are same TRANSACTION_NO"). A DIFFERENT SLS_FLAG under the
    // same TRANSACTION_NO (either against the existing draft, or between two
    // records in THIS batch) is a collision, not a re-send — abort the whole
    // batch rather than silently keep one side. See TrnNoCollisionError.
    const seenFlags = this._readExistingTrnRecords(tempPath);
    const uniqueTransactions = [];
    transactions.forEach((data) => {
      const trnNo = String(data.TRANSACTION_NO ?? "").trim();
      const incomingFlag = String(data.SLS_FLAG ?? "").trim();
      if (trnNo && seenFlags.has(trnNo)) {
        const existingFlag = seenFlags.get(trnNo);
        if (existingFlag === incomingFlag) {
          log.warn(
            `[AppendHourly] Skipping duplicate TRANSACTION_NO ${trnNo} for ter ${terNo} (already present)`,
          );
          return;
        }
        throw new TrnNoCollisionError(
          `TRANSACTION_NO ${trnNo} collides in hourly batch for ter ${terNo}: existing SLS_FLAG=${existingFlag}, incoming SLS_FLAG=${incomingFlag}`,
        );
      }
      if (trnNo) seenFlags.set(trnNo, incomingFlag);
      uniqueTransactions.push(data);
    });

    if (uniqueTransactions.length === 0) {
      return tempFilename;
    }

    let rowsToAppend = "";

    if (!fs.existsSync(tempPath)) {
      const firstData = uniqueTransactions[0];
      FILE_HEADER_FIELDS.forEach((field) => {
        const val = field === "NO_TRN" ? "0" : firstData[field] || "";
        rowsToAppend += `${field},${formatValue(field, val)}\n`;
      });
    }

    uniqueTransactions.forEach((data) => {
      TRANSACTION_FIELDS.forEach((field) => {
        const val = data[field] !== undefined ? data[field] : "";
        rowsToAppend += `${field},${formatValue(field, val)}\n`;
      });

      (data.items || []).forEach((item) => {
        ITEM_FIELDS.forEach((field) => {
          const val = item[field] !== undefined ? item[field] : "";
          rowsToAppend += `${field},${formatValue(field, val)}\n`;
        });
      });
    });

    fs.appendFileSync(tempPath, rowsToAppend);
    return tempFilename;
  }

  /**
   * Checks for previous EOD files matching the criteria.
   *
   * @param {string} ccode - Company code.
   * @param {string} mmddyy - Date string in MMDDYY format.
   * @returns {string[]} List of matching filenames.
   */
  checkPreviousEOD(ccode, mmddyy) {
    const files = fs.readdirSync(UPLOADS_DIR);
    return files.filter((file) => file.startsWith(ccode + mmddyy));
  }

  /**
   * Moves a terminal's official per-transaction files out of the pickup folder
   * before a reprocess writes regenerated replacements. Call restore on any
   * failure before the new EOD is accepted; call discard after success.
   *
   * @param {{ ccode: string, mmddyy: string, terNo: string }} params
   * @returns {{ backupDir: string, prefix: string, files: Array<{ name: string, from: string, to: string }> }}
   */
  stageOfficialTransactionFilesForReprocess({ ccode, mmddyy, terNo }) {
    const terminal = String(terNo || "").trim().padStart(3, "0");
    const prefix = `${ccode}${mmddyy}${terminal}_`;
    const backupDir = path.join(
      STAGING_DIR,
      `txn_${ccode}_${mmddyy}_${terminal}_${Date.now()}`,
    );
    const files = [];

    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      if (!name.startsWith(prefix) || !name.endsWith(".csv")) continue;

      const from = path.join(UPLOADS_DIR, name);
      const to = path.join(backupDir, name);
      fs.mkdirSync(backupDir, { recursive: true });
      _safeMove(from, to);
      files.push({ name, from, to });
    }

    if (files.length) {
      log.info(
        `[Reprocess] Staged ${files.length} transaction file(s) for ${ccode} ${mmddyy} TER ${terminal}`,
      );
    }

    return { backupDir, prefix, files };
  }

  restoreStagedTransactionFiles(staged) {
    if (!staged) return;

    if (staged.prefix) {
      for (const name of fs.readdirSync(UPLOADS_DIR)) {
        if (!name.startsWith(staged.prefix) || !name.endsWith(".csv")) {
          continue;
        }
        fs.rmSync(path.join(UPLOADS_DIR, name), { force: true });
      }
    }

    if (!staged.files || staged.files.length === 0) return;

    for (const file of staged.files) {
      if (!fs.existsSync(file.to)) continue;
      _safeMove(file.to, file.from);
    }
    fs.rmSync(staged.backupDir, { recursive: true, force: true });
    log.warn(
      `[Reprocess] Restored ${staged.files.length} staged transaction file(s) after failure`,
    );
  }

  discardStagedTransactionFiles(staged) {
    if (!staged || !staged.backupDir) return;
    fs.rmSync(staged.backupDir, { recursive: true, force: true });
  }

  /**
   * Finalizes all pending temporary files for a specific date.
   * Called by EOD endpoint to ensure all transactions are properly finalized.
   *
   * @param {string} trnDate - Transaction date (YYYY-MM-DD format).
   * @returns {string[]} Array of finalized filenames.
   * @throws {Error} If finalization of any temp file fails.
   */
  finalizeAllTempFilesForDate(trnDate) {
    const datePattern = mmddyyUnderscored(trnDate);
    if (!datePattern) {
      throw new Error(`Invalid TRN_DATE "${trnDate}" for temp-file scan`);
    }
    const dt = parseWireDate(trnDate);

    const exactRegex = new RegExp(
      `^temp_${datePattern}_hour_\\d+_ter_\\d+\\.csv$`,
    );

    // Transition scan. Before this fix the temp filename was derived from the
    // machine's local timezone, so on a POS PC with a negative UTC offset the
    // drafts on disk are stamped one day BEHIND their real business date. A
    // straight match on the corrected pattern would leave those drafts orphaned
    // — their transactions would never reach an official per-transaction file,
    // which is exactly the per-txn vs EOD cross-validation failure.
    //
    // An adjacent-day FILENAME is not sufficient grounds to finalize, though:
    // drafts for a genuinely different business day sit in the same directory
    // (EOD is routinely posted for a prior day — the POS back-fills missing
    // days — while today's drafts are still accumulating). Sweeping one of
    // those up would close the current hour early, so a re-sent transaction
    // would land in a fresh draft that can no longer see the already-emitted
    // TRANSACTION_NOs and Ayala rejects the pair with "There are same
    // TRANSACTION_NO". So an adjacent-day name only qualifies when the
    // TRN_DATE *inside* the file says it belongs to this business day, which
    // is exactly what distinguishes a mis-stamped legacy draft from a real
    // one. Self-expires once the pre-fix drafts are drained.
    const adjacentPatterns = [
      dt.clone().subtract(1, "day").format("MM_DD_YY"),
      dt.clone().add(1, "day").format("MM_DD_YY"),
    ];
    const adjacentRegex = new RegExp(
      `^temp_(?:${adjacentPatterns.join("|")})_hour_\\d+_ter_\\d+\\.csv$`,
    );

    log.info(
      `[FinalizeTempFiles] Scanning for temp files matching date: ${datePattern} (+/- 1 day for pre-fix drafts, gated on internal TRN_DATE)`,
    );

    const files = fs.readdirSync(TEMP_DIR);
    const tempFiles = files.filter((file) => {
      if (exactRegex.test(file)) return true;
      if (!adjacentRegex.test(file)) return false;

      const internalDate = this._readDraftTrnDate(path.join(TEMP_DIR, file));
      if (internalDate === trnDate) {
        log.warn(
          `[FinalizeTempFiles] Recovering pre-fix draft ${file}: filename date is stale but TRN_DATE inside is ${trnDate}.`,
        );
        return true;
      }
      log.info(
        `[FinalizeTempFiles] Leaving ${file} alone: TRN_DATE inside is ${
          internalDate || "unreadable"
        }, not ${trnDate}.`,
      );
      return false;
    });

    if (tempFiles.length === 0) {
      log.info(
        `[FinalizeTempFiles] No pending temp files found for ${trnDate}`,
      );
      return [];
    }

    log.info(
      `[FinalizeTempFiles] Found ${tempFiles.length} temp file(s) to finalize`,
    );
    const finalizedFiles = [];

    for (const tempFile of tempFiles) {
      try {
        log.info(`[FinalizeTempFiles] Processing: ${tempFile}`);
        const officialFilename = this.finalizeHourlyDraft(tempFile);

        if (officialFilename) {
          log.info(
            `[FinalizeTempFiles] Successfully finalized -> ${officialFilename}`,
          );
          finalizedFiles.push(officialFilename);
        } else {
          log.info(`[FinalizeTempFiles] Removed empty temp file: ${tempFile}`);
        }
      } catch (error) {
        log.error(`[FinalizeTempFiles] Failed to finalize ${tempFile}:`, error);
        throw new Error(
          `Failed to finalize temp file ${tempFile}: ${error.message}`,
        );
      }
    }

    return finalizedFiles;
  }

  /**
   * Finalizes an hourly draft file into an official Ayala format.
   * Used by the cron job.
   *
   * @param {string} tempFilename - The temporary filename to finalize.
   * @returns {string|null} The official filename or null if failed.
   */
  finalizeHourlyDraft(tempFilename) {
    const tempPath = path.join(TEMP_DIR, tempFilename);
    const content = fs.readFileSync(tempPath, "utf-8");
    const lines = content.split("\n");

    // Split into header lines + per-transaction blocks. A block starts at a
    // CDATE line (the first TRANSACTION_FIELD) and runs until the next CDATE.
    const headerLines = [];
    const blocks = [];
    let currentBlock = null;
    for (const line of lines) {
      if (line.startsWith("CDATE,")) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = [line];
      } else if (currentBlock) {
        currentBlock.push(line);
      } else {
        headerLines.push(line);
      }
    }
    if (currentBlock) blocks.push(currentBlock);

    // Defense-in-depth dedup: drop any transaction block whose TRANSACTION_NO
    // already appeared earlier in the draft (keep the first). Even if the
    // append guards are bypassed, a duplicate must never reach UPLOADS_DIR —
    // Ayala's validator rejects the whole file if a TRANSACTION_NO repeats.
    //
    // This runs off a cron job with no HTTP caller to hand a 409 to, so unlike
    // appendTransaction/appendHourlyTransactions it cannot abort loudly on a
    // genuine collision (different SLS_FLAG) without stranding the draft file
    // indefinitely. It still distinguishes the two cases IN THE LOG so a
    // collision that slipped past the append-time guards is visible at
    // log.error rather than blending into routine resend noise at log.warn.
    const seen = new Map();
    const uniqueBlocks = [];
    for (const block of blocks) {
      const trnLine = block.find((l) => l.startsWith("TRANSACTION_NO,"));
      const trnNo = trnLine
        ? trnLine.split(",")[1].replace(/"/g, "").trim()
        : "";
      const slsFlagLine = block.find((l) => l.startsWith("SLS_FLAG,"));
      const slsFlag = slsFlagLine
        ? slsFlagLine.split(",")[1].replace(/"/g, "").trim()
        : "";
      if (trnNo && seen.has(trnNo)) {
        const existingFlag = seen.get(trnNo);
        if (existingFlag === slsFlag) {
          log.warn(
            `[FinalizeHourlyDraft] Dropping duplicate TRANSACTION_NO ${trnNo} from ${tempFilename}`,
          );
        } else {
          log.error(
            `[FinalizeHourlyDraft] TRANSACTION_NO COLLISION in ${tempFilename}: ${trnNo} appears as SLS_FLAG=${existingFlag} AND SLS_FLAG=${slsFlag} — dropping the second occurrence, but this is a POS-side bug, not a re-send. Investigate the source transaction.`,
          );
        }
        continue;
      }
      if (trnNo) seen.set(trnNo, slsFlag);
      uniqueBlocks.push(block);
    }

    const transactionCount = uniqueBlocks.length;

    if (transactionCount === 0) {
      fs.unlinkSync(tempPath);
      return null;
    }

    // Update NO_TRN in the header from the deduped transaction count.
    const noTrnIdx = headerLines.findIndex((l) => l.startsWith("NO_TRN,"));
    if (noTrnIdx !== -1) {
      headerLines[noTrnIdx] = `NO_TRN,${transactionCount}`;
    }

    const rebuiltLines = [...headerLines, ...uniqueBlocks.flat()];

    const extractValue = (key) => {
      const line = rebuiltLines.find((l) => l.startsWith(`${key},`));
      return line ? line.split(",")[1].replace(/"/g, "") : "";
    };

    const ccode = extractValue("CCCODE");
    const trnDate = extractValue("TRN_DATE");
    const terNo = extractValue("TER_NO") || "001";
    const terminal = terNo.padStart(3, "0");

    const dateMMDDYY = mmddyy(trnDate);
    if (!dateMMDDYY) {
      throw new Error(
        `Invalid date pattern "${trnDate}" found in ${tempFilename}`,
      );
    }

    const lastTrnLine = [...rebuiltLines]
      .reverse()
      .find((l) => l.startsWith("TRANSACTION_NO,"));
    const sequence = lastTrnLine
      ? lastTrnLine.split(",")[1].replace(/"/g, "").padStart(6, "0")
      : "000001";

    const officialFilename = `${ccode}${dateMMDDYY}${terminal}_${sequence}.csv`;
    const officialPath = path.join(UPLOADS_DIR, officialFilename);

    // Publish atomically (tmp+rename, Windows-safe even if a prior official file
    // exists) and drop the working draft. The old writeFileSync(tempPath)+
    // renameSync(tempPath, officialPath) threw on Windows when officialPath
    // already existed (a re-finalize) and wrote the draft non-atomically.
    atomicWriteFile(officialPath, rebuiltLines.join("\n"));
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_) {
      /* draft cleanup is best-effort */
    }

    return officialFilename;
  }
}

module.exports = new AyalaService();
