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
const { formatValue } = require("../utils");

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

    const dt = new Date(trnDate);
    const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
    const dd = dt.getDate().toString().padStart(2, "0");
    const yy = dt.getFullYear().toString().slice(-2);
    const dateMMDDYY = `${mm}${dd}${yy}`;

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
    fs.writeFileSync(filePath, csvContent);
    return filename;
  }

  /**
   * Appends transaction data to a temporary hourly draft file.
   *
   * @param {Object} data - The transaction data object.
   * @returns {string} The temporary filename.
   */
  appendTransaction(data) {
    const now = new Date();

    // Derive hour from TRN_TIME ("HH:MM") so the temp file bucket matches
    // the transaction time, not the server's wall-clock hour.
    let hour = now.getHours();
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
      const parsed = new Date(data.TRN_DATE);
      if (!isNaN(parsed.getTime())) {
        dateSource = parsed;
        console.log("dateSource", dateSource);
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

    const date = `${(dateSource.getMonth() + 1).toString().padStart(2, "0")}_${dateSource
      .getDate()
      .toString()
      .padStart(2, "0")}_${dateSource.getFullYear().toString().slice(-2)}`;
    const terNo = String(data.TER_NO || "1").trim().padStart(3, "0");
    const tempFilename = `temp_${date}_hour_${hour}_ter_${terNo}.csv`;
    const tempPath = path.join(TEMP_DIR, tempFilename);

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

    let rowsToAppend = "";

    if (!fs.existsSync(tempPath) && transactions.length > 0) {
      const firstData = transactions[0];
      FILE_HEADER_FIELDS.forEach((field) => {
        const val = field === "NO_TRN" ? "0" : firstData[field] || "";
        rowsToAppend += `${field},${formatValue(field, val)}\n`;
      });
    }

    transactions.forEach((data) => {
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
    const dt = new Date(trnDate);
    const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
    const dd = dt.getDate().toString().padStart(2, "0");
    const yy = dt.getFullYear().toString().slice(-2);

    const datePattern = `${mm}_${dd}_${yy}`;
    const tempFileRegex = new RegExp(`^temp_${datePattern}_hour_\\d+_ter_\\d+\.csv$`);

    log.info(
      `[FinalizeTempFiles] Scanning for temp files matching date: ${datePattern}`,
    );

    const files = fs.readdirSync(TEMP_DIR);
    const tempFiles = files.filter((file) => tempFileRegex.test(file));

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
    const transactionCount = lines.filter((line) =>
      line.startsWith("CDATE,"),
    ).length;

    if (transactionCount === 0) {
      fs.unlinkSync(tempPath);
      return null;
    }

    // Update NO_TRN in the header (line index 3 based on bridge.js logic)
    lines[3] = `NO_TRN,${transactionCount}`;

    const extractValue = (key) => {
      const line = lines.find((l) => l.startsWith(`${key},`));
      return line ? line.split(",")[1].replace(/"/g, "") : "";
    };

    const ccode = extractValue("CCCODE");
    const trnDate = extractValue("TRN_DATE");
    const terNo = extractValue("TER_NO") || "001";
    const terminal = terNo.padStart(3, "0");

    const dt = new Date(trnDate);
    if (isNaN(dt.getTime())) {
      throw new Error(
        `Invalid date pattern "${trnDate}" found in ${tempFilename}`,
      );
    }
    const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
    const dd = dt.getDate().toString().padStart(2, "0");
    const yy = dt.getFullYear().toString().slice(-2);
    const dateMMDDYY = `${mm}${dd}${yy}`;

    const lastTrnLine = [...lines]
      .reverse()
      .find((l) => l.startsWith("TRANSACTION_NO,"));
    const sequence = lastTrnLine
      ? lastTrnLine.split(",")[1].replace(/"/g, "").padStart(6, "0")
      : "000001";

    const officialFilename = `${ccode}${dateMMDDYY}${terminal}_${sequence}.csv`;
    const officialPath = path.join(UPLOADS_DIR, officialFilename);

    fs.writeFileSync(tempPath, lines.join("\n"));
    fs.renameSync(tempPath, officialPath);

    return officialFilename;
  }
}

module.exports = new AyalaService();
