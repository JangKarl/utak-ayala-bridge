const path = require("path");
const os = require("os");

/**
 * Fields used in the header of the transaction CSV files.
 * @type {string[]}
 */
const FILE_HEADER_FIELDS = [
  "CCCODE",
  "MERCHANT_NAME",
  "TRN_DATE",
  "NO_TRN",
];

/**
 * Fields used for each transaction record.
 * @type {string[]}
 */
const TRANSACTION_FIELDS = [
  "CDATE",
  "TRN_TIME",
  "TER_NO",
  "TRANSACTION_NO",
  "GROSS_SLS",
  "VAT_AMNT",
  "VATABLE_SLS",
  "NONVAT_SLS",
  "VATEXEMPT_SLS",
  "VATEXEMPT_AMNT",
  "LOCAL_TAX",
  "PWD_DISC",
  "SNRCIT_DISC",
  "EMPLO_DISC",
  "AYALA_DISC",
  "STORE_DISC",
  "OTHER_DISC",
  "REFUND_AMT",
  "SCHRGE_AMT",
  "OTHER_SCHR",
  "CASH_SLS",
  "CARD_SLS",
  "EPAY_SLS",
  "DCARD_SLS",
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
  "MOBILE_NO",
  "NO_CUST",
  "TRN_TYPE",
  "SLS_FLAG",
  "VAT_PCT",
  "QTY_SLD",
];

/**
 * Fields used for individual line items in a transaction.
 * @type {string[]}
 */
const ITEM_FIELDS = ["QTY", "ITEMCODE", "PRICE", "LDISC"];

/**
 * Fields used in the End of Day (EOD) CSV files.
 * @type {string[]}
 */
const EOD_FIELDS = [
  "CCCODE",
  "MERCHANT_NAME",
  "TER_NO",
  "TRN_DATE",
  "STRANS",
  "ETRANS",
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
  "NO_VOID",
  "DISCOUNTS",
  "NO_DISC",
  "REFUND_AMT",
  "NO_REFUND",
  "SNRCIT_DISC",
  "NO_SNRCIT",
  "PWD_DISC",
  "NO_PWD",
  "EMPLO_DISC",
  "NO_EMPLO",
  "AYALA_DISC",
  "NO_AYALA",
  "STORE_DISC",
  "NO_STORE",
  "OTHER_DISC",
  "NO_OTHER_DISC",
  "SCHRGE_AMT",
  "OTHER_SCHR",
  "CASH_SLS",
  "CARD_SLS",
  "EPAY_SLS",
  "DCARD_SLS",
  "OTHER_SLS",
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
  "NO_VATEXEMT",
  "NO_SCHRGE",
  "NO_OTHER_SUR",
  "NO_CASH",
  "NO_CARD",
  "NO_EPAY",
  "NO_DCARD_SLS",
  "NO_OTHER_SLS",
  "NO_CHECK",
  "NO_GC",
  "NO_MASTERCARD_SLS",
  "NO_VISA_SLS",
  "NO_AMEX_SLS",
  "NO_DINERS_SLS",
  "NO_JCB_SLS",
  "NO_GCASH_SLS",
  "NO_PAYMAYA_SLS",
  "NO_ALIPAY_SLS",
  "NO_WECHAT_SLS",
  "NO_GRAB_SLS",
  "NO_FOODPANDA_SLS",
  "NO_MASTERDEBIT_SLS",
  "NO_VISADEBIT_SLS",
  "NO_PAYPAL_SLS",
  "NO_ONLINE_SLS",
  "NO_OPEN_SALES",
  "NO_OPEN_SALES_2",
  "NO_OPEN_SALES_3",
  "NO_OPEN_SALES_4",
  "NO_OPEN_SALES_5",
  "NO_OPEN_SALES_6",
  "NO_OPEN_SALES_7",
  "NO_OPEN_SALES_8",
  "NO_OPEN_SALES_9",
  "NO_OPEN_SALES_10",
  "NO_OPEN_SALES_11",
  "NO_NOSALE",
  "NO_CUST",
  "NO_TRN",
  "PREV_EODCTR",
  "EODCTR",
];

/**
 * Port number for the Express server.
 * @type {number}
 */
const PORT = process.env.PORT || 3800;

/**
 * Directory where uploaded and generated CSV files are stored.
 * @type {string}
 */
const UPLOADS_DIR = "C:\\AYALA\\tenant_api\\storage\\app\\OUTGOING";

module.exports = {
  FILE_HEADER_FIELDS,
  TRANSACTION_FIELDS,
  ITEM_FIELDS,
  EOD_FIELDS,
  PORT,
  UPLOADS_DIR,
};
