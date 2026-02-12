const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const moment = require("moment-timezone");
const {
  EOD_FIELDS,
  FILE_HEADER_FIELDS,
  TRANSACTION_FIELDS,
  ITEM_FIELDS,
  UPLOADS_DIR,
  TIMEZONE,
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

    const dt = moment.tz(trnDate, TIMEZONE);
    const mm = dt.format("MM");
    const dd = dt.format("DD");
    const yy = dt.format("YY");
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
    const now = moment.tz(TIMEZONE);
    const hour = now.format("H");
    const date = `${now.format("MM")}_${now.format("DD")}_${now.format("YY")}`;
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

    const dt = moment.tz(trnDate, TIMEZONE);
    if (!dt.isValid()) {
      throw new Error(
        `Invalid date pattern "${trnDate}" found in ${tempFilename}`,
      );
    }
    const mm = dt.format("MM");
    const dd = dt.format("DD");
    const yy = dt.format("YY");
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
