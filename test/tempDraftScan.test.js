const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// finalizeAllTempFilesForDate scans TEMP_DIR, which is a module constant. Swap
// the constants module in the require cache before the service loads it so the
// suite never touches the real C:\UTAK\Temp or the mall pickup directory.
const constPath = require.resolve("../src/constants/ayala");
const realConstants = require(constPath);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ayala-draftscan-"));
const TEMP_DIR = path.join(ROOT, "temp");
const UPLOADS_DIR = path.join(ROOT, "uploads");
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

require.cache[constPath].exports = {
  ...realConstants,
  TEMP_DIR,
  UPLOADS_DIR,
  STAGING_DIR: path.join(TEMP_DIR, ".staging"),
};

const ayalaService = require("../src/services/ayala.service");

const CCCODE = "790060000000007588";

/** Writes a minimal but structurally valid hourly draft. */
function writeDraft(filename, trnDate, trnNo) {
  const lines = [
    `CCCODE,${CCCODE}`,
    `MERCHANT_NAME,THE ALLEY`,
    `TRN_DATE,${trnDate}`,
    `NO_TRN,1`,
    `CDATE,${trnDate}`,
    `TRN_TIME,20:07`,
    `TER_NO,001`,
    `TRANSACTION_NO,${trnNo}`,
    `GROSS_SLS,100.00`,
  ];
  fs.writeFileSync(path.join(TEMP_DIR, filename), lines.join("\n") + "\n");
}

function clearTemp() {
  for (const f of fs.readdirSync(TEMP_DIR)) {
    const p = path.join(TEMP_DIR, f);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }
}

test("finalizes the draft whose filename matches the target business date", () => {
  clearTemp();
  writeDraft("temp_07_27_26_hour_20_ter_001.csv", "2026-07-27", "000468");

  const finalized = ayalaService.finalizeAllTempFilesForDate("2026-07-27");

  assert.strictEqual(finalized.length, 1);
  assert.ok(finalized[0].includes("072726"), finalized[0]);
});

test("recovers a PRE-FIX draft: stale filename date, correct TRN_DATE inside", () => {
  clearTemp();
  // What the old machine-local derivation left on a UTC-8 POS PC: the filename
  // is a day behind, the TRN_DATE inside is right.
  writeDraft("temp_07_26_26_hour_21_ter_001.csv", "2026-07-27", "000469");

  const finalized = ayalaService.finalizeAllTempFilesForDate("2026-07-27");

  assert.strictEqual(finalized.length, 1, "pre-fix draft must not be orphaned");
  assert.ok(
    finalized[0].includes("072726"),
    `expected the corrected date stamp, got ${finalized[0]}`,
  );
  assert.strictEqual(
    fs.existsSync(path.join(TEMP_DIR, "temp_07_26_26_hour_21_ter_001.csv")),
    false,
    "the recovered draft should have been consumed",
  );
});

test("REGRESSION: a draft that genuinely belongs to the NEXT business day is left alone", () => {
  clearTemp();
  // Real flow: the POS back-fills a missing day's EOD (or the merchant runs
  // yesterday's EOD in the morning) while today's drafts are still
  // accumulating. Sweeping today's draft up would close the current hour
  // early; a re-sent transaction would then land in a fresh draft that cannot
  // see the already-emitted TRANSACTION_NOs, and Ayala rejects the resulting
  // pair with "There are same TRANSACTION_NO".
  writeDraft("temp_07_28_26_hour_09_ter_001.csv", "2026-07-28", "000470");

  const finalized = ayalaService.finalizeAllTempFilesForDate("2026-07-27");

  assert.deepStrictEqual(finalized, [], "next day's draft must not be finalized");
  assert.strictEqual(
    fs.existsSync(path.join(TEMP_DIR, "temp_07_28_26_hour_09_ter_001.csv")),
    true,
    "next day's draft must still be on disk, still accumulating",
  );
});

test("REGRESSION: a draft that genuinely belongs to the PREVIOUS business day is left alone", () => {
  clearTemp();
  writeDraft("temp_07_26_26_hour_22_ter_001.csv", "2026-07-26", "000467");

  const finalized = ayalaService.finalizeAllTempFilesForDate("2026-07-27");

  assert.deepStrictEqual(finalized, []);
  assert.strictEqual(
    fs.existsSync(path.join(TEMP_DIR, "temp_07_26_26_hour_22_ter_001.csv")),
    true,
  );
});

test("mixed directory: recovers only the mis-stamped draft, leaves the real ones", () => {
  clearTemp();
  writeDraft("temp_07_27_26_hour_20_ter_001.csv", "2026-07-27", "000468"); // exact
  writeDraft("temp_07_26_26_hour_21_ter_001.csv", "2026-07-27", "000469"); // pre-fix
  writeDraft("temp_07_28_26_hour_09_ter_001.csv", "2026-07-28", "000470"); // tomorrow
  writeDraft("temp_07_26_26_hour_22_ter_002.csv", "2026-07-26", "000467"); // yesterday

  const finalized = ayalaService.finalizeAllTempFilesForDate("2026-07-27");

  assert.strictEqual(finalized.length, 2, finalized.join(", "));
  assert.ok(finalized.every((f) => f.includes("072726")), finalized.join(", "));
  assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, "temp_07_28_26_hour_09_ter_001.csv")), true);
  assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, "temp_07_26_26_hour_22_ter_002.csv")), true);
});

test("an unreadable adjacent-day draft is left alone rather than swept", () => {
  clearTemp();
  fs.writeFileSync(
    path.join(TEMP_DIR, "temp_07_28_26_hour_09_ter_001.csv"),
    "GARBAGE,no-header\n",
  );

  const finalized = ayalaService.finalizeAllTempFilesForDate("2026-07-27");

  assert.deepStrictEqual(finalized, []);
  assert.strictEqual(
    fs.existsSync(path.join(TEMP_DIR, "temp_07_28_26_hour_09_ter_001.csv")),
    true,
  );
});
