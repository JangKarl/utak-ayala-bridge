const os = require("os");
const { EOD_FIELDS } = require("../constants/ayala");

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
};
