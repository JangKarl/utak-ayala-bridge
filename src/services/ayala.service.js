const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const {
  EOD_FIELDS,
  FILE_HEADER_FIELDS,
  TRANSACTION_FIELDS,
  ITEM_FIELDS,
  UPLOADS_DIR,
} = require("../constants/ayala");
const { formatValue } = require("../utils");

/**
 * Service for handling Ayala-specific file generation and operations.
 */
class AyalaService {
  /**
   * Generates an End of Day (EOD) CSV file.
   *
   * @param {Object} data - The EOD data object.
   * @returns {string} The generated filename.
   */
  generateEodFile(data) {
    const ccode = data.CCCODE;
    const trnDate = data.TRN_DATE;

    const dt = new Date(trnDate);
    const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
    const dd = dt.getDate().toString().padStart(2, "0");
    const yy = dt.getFullYear().toString().slice(-2);
    const dateMMDDYY = `${mm}${dd}${yy}`;

    const filename = `EOD${ccode}${dateMMDDYY}.csv`;
    const filePath = path.join(UPLOADS_DIR, filename);

    let csvContent = "";
    EOD_FIELDS.forEach((field) => {
      const val = data[field] !== undefined ? data[field] : "";
      csvContent += `${field},${formatValue(field, val)}\n`;
    });

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
    const hour = now.getHours();
    const date = `${(now.getMonth() + 1).toString().padStart(2, "0")}_${now
      .getDate()
      .toString()
      .padStart(2, "0")}_${now.getFullYear().toString().slice(-2)}`;
    const tempFilename = `temp_${date}_hour_${hour}.csv`;
    const tempPath = path.join(UPLOADS_DIR, tempFilename);

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
    const tempFileRegex = new RegExp(`^temp_${datePattern}_hour_\\d+\\.csv$`);

    log.info(
      `[FinalizeTempFiles] Scanning for temp files matching date: ${datePattern}`,
    );

    const files = fs.readdirSync(UPLOADS_DIR);
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
    const tempPath = path.join(UPLOADS_DIR, tempFilename);
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
    const trnDate = extractValue("CDATE");
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
