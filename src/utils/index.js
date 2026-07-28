const os = require("os");
const fs = require("fs");
const moment = require("moment-timezone");
const { EOD_FIELDS, TIMEZONE } = require("../constants/ayala");

/**
 * The wire format of every date the POS sends us (TRN_DATE, CDATE).
 * @type {string}
 */
const WIRE_DATE_FORMAT = "YYYY-MM-DD";

/**
 * Parses a POS-supplied date string in the store timezone.
 *
 * Do NOT use `new Date(str)` for this: the spec parses a bare "YYYY-MM-DD" as
 * UTC midnight, while getMonth()/getDate()/getFullYear() read it back in
 * MACHINE-local time. On a POS PC whose Windows timezone has a negative UTC
 * offset that rolls the date back a day, so the date baked into a filename
 * disagrees with the TRN_DATE inside the file and the mall rejects it.
 * Parsing is STRICT. The CSV records the raw TRN_DATE string while the filename
 * records the parsed one, so anything moment would merely guess at (e.g.
 * "07/27/2026") must be rejected outright — accepting it would put a date in
 * the filename that does not correspond to the string inside the file, which is
 * the exact defect this helper exists to prevent.
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD form.
 * @returns {import("moment-timezone").Moment} A moment in TIMEZONE; check
 *   `.isValid()` before use.
 */
const parseWireDate = (dateStr) =>
  moment.tz(dateStr, WIRE_DATE_FORMAT, true, TIMEZONE);

/**
 * Formats a POS-supplied date as the MMDDYY stamp used in official Ayala
 * filenames and in the CCCODE+MMDDYY EOD lock / reprocess-state keys.
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD form.
 * @returns {string|null} MMDDYY, or null when the input is not a valid date.
 */
const mmddyy = (dateStr) => {
  const m = parseWireDate(dateStr);
  return m.isValid() ? m.format("MMDDYY") : null;
};

/**
 * Formats a POS-supplied date as the MM_DD_YY stamp used in temp hourly draft
 * filenames (temp_MM_DD_YY_hour_H_ter_NNN.csv).
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD form.
 * @returns {string|null} MM_DD_YY, or null when the input is not a valid date.
 */
const mmddyyUnderscored = (dateStr) => {
  const m = parseWireDate(dateStr);
  return m.isValid() ? m.format("MM_DD_YY") : null;
};

/**
 * Current time in the store timezone. Used wherever "now" has to line up with
 * the POS's own clock — the hourly cron's target hour must match the Manila
 * TRN_TIME the temp files are bucketed by, not the PC's wall clock.
 *
 * @returns {import("moment-timezone").Moment}
 */
const nowTz = () => moment.tz(TIMEZONE);

/**
 * Atomic-ish file replace: write a sibling temp file then rename it over the
 * target. POSIX rename is atomic; Windows rename throws if the target already
 * exists, so fall back to remove-then-rename. This prevents a crash/power-loss
 * mid-write from leaving a truncated file — which the state services' _hydrate
 * would silently swallow (JSON.parse error) and reset to empty, losing an active
 * EOD lock / reprocess progress / the entire TER_NO ownership registry.
 *
 * @param {string} targetPath
 * @param {string} content
 */
const atomicWriteFile = (targetPath, content) => {
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.rmSync(targetPath, { force: true });
    } catch (_) {
      /* ignore */
    }
    fs.renameSync(tmp, targetPath);
  }
};

/**
 * Formats a value based on the field key for Ayala CSV compatibility.
 * 
 * @param {string} key - The field name/key.
 * @param {any} val - The value to format.
 * @returns {string} The formatted value.
 */
const formatValue = (key, val) => {
  const isEodField = EOD_FIELDS.includes(key);

  if (["QTY", "QTY_SLD"].includes(key)) {
    const num = parseFloat(val);
    return isNaN(num) ? "0.000" : num.toFixed(3);
  }

  if (["STRANS", "ETRANS"].includes(key)) {
    const num = parseInt(val);
    return isNaN(num) ? "00000000" : num.toString().padStart(8, "0");
  }

  if (key.startsWith("NO_") || ["EODCTR", "PREV_EODCTR"].includes(key)) {
    const num = parseInt(val);
    if (isNaN(num)) return "0";
    return num.toString();
  }

  const twoDecimalFields = [
    "GROSS_SLS",
    "VAT_AMNT",
    "VATABLE_SLS",
    "NONVAT_SLS",
    "VATEXEMPT_SLS",
    "VATEXEMPT_AMNT",
    "OLD_GRNTOT",
    "NEW_GRNTOT",
    "LOCAL_TAX",
    "VOID_AMNT",
    "DISCOUNTS",
    "REFUND_AMT",
    "SNRCIT_DISC",
    "PWD_DISC",
    "EMPLO_DISC",
    "AYALA_DISC",
    "STORE_DISC",
    "OTHER_DISC",
    "SCHRGE_AMT",
    "OTHER_SCHR",
    "CASH_SLS",
    "CARD_SLS",
    "EPAY_SLS",
    "DCARD_SLS",
    "OTHER_SLS",
    "OTHERSL_SLS",
    "CHECK_SLS",
    "GC_SLS",
    "MASTERCARD_SLS",
    "VISA_SLS",
    "AMEX_SLS",
    "DINERS_SLS",
    "JCB_SLS",
    "GCASH_SLS",
    "PAYMAYA_SLS",
    "ALIPAY_SLS",
    "WECHAT_SLS",
    "GRAB_SLS",
    "FOODPANDA_SLS",
    "MASTERDEBIT_SLS",
    "VISADEBIT_SLS",
    "PAYPAL_SLS",
    "ONLINE_SLS",
    "OPEN_SALES",
    "OPEN_SALES_2",
    "OPEN_SALES_3",
    "OPEN_SALES_4",
    "OPEN_SALES_5",
    "OPEN_SALES_6",
    "OPEN_SALES_7",
    "OPEN_SALES_8",
    "OPEN_SALES_9",
    "OPEN_SALES_10",
    "OPEN_SALES_11",
    "GC_EXCESS",
    "VAT_PCT",
    "PRICE",
    "LDISC",
  ];

  if (twoDecimalFields.includes(key)) {
    const num = parseFloat(val);
    if (isNaN(num)) return "0.00";
    return num.toFixed(2);
  }

  if (typeof val === "string" && val.includes(",")) {
    return `"${val}"`;
  }
  return val === null || val === undefined ? "" : val.toString();
};

/**
 * Retrieves the local IPv4 address of the machine.
 * 
 * @returns {string} The local IP address or "127.0.0.1" if not found.
 */
const getLocalIPAddress = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
};

/**
 * Lists every non-internal IPv4 address on this machine, with its interface
 * name. On a dual-homed POS PC (store Wi-Fi + mall LAN) this returns all
 * candidates so the operator can pick the POS-facing one in the tray.
 *
 * @returns {{ name: string, address: string }[]}
 */
const listLocalIPv4Addresses = () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses;
};

module.exports = {
  formatValue,
  getLocalIPAddress,
  listLocalIPv4Addresses,
  atomicWriteFile,
  parseWireDate,
  mmddyy,
  mmddyyUnderscored,
  nowTz,
};
