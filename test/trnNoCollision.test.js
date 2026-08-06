const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Coverage for the TRANSACTION_NO collision guard (task e5fad5f5 —
 * mamonaku_vermosa 2026-08-04). Before this fix, appendTransaction /
 * appendHourlyTransactions deduped purely on TRANSACTION_NO: a sale and a
 * refund that happened to share an identifier (the confirmed POS-side bug —
 * see ensureRefundCounter in utakmobile24) would silently skip the second
 * one and still return HTTP 200, so the POS never knew a row was dropped.
 * This guard distinguishes a genuine collision (same TRANSACTION_NO,
 * DIFFERENT SLS_FLAG) from a legitimate re-send (same TRANSACTION_NO, SAME
 * SLS_FLAG — a queue-drain retry) and throws TrnNoCollisionError only for
 * the former.
 */

// Swap TEMP_DIR/UPLOADS_DIR to a scratch directory before the service loads
// them, exactly like test/tempDraftScan.test.js.
const constPath = require.resolve("../src/constants/ayala");
const realConstants = require(constPath);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ayala-trnno-"));
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

function clearTemp() {
  for (const f of fs.readdirSync(TEMP_DIR)) {
    const p = path.join(TEMP_DIR, f);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }
}

/** Minimal but structurally valid /transaction payload. */
function makeRecord(over = {}) {
  return {
    CCCODE: "84106000000001070",
    MERCHANT_NAME: "MAMONAKU KOHI",
    TRN_DATE: "2026-08-04",
    CDATE: "2026-08-04",
    TRN_TIME: "20:45",
    TER_NO: "001",
    TRANSACTION_NO: "7904",
    GROSS_SLS: "378.00",
    SLS_FLAG: "S",
    ...over,
  };
}

test("appendTransaction absorbs a re-send: same TRANSACTION_NO, same SLS_FLAG", () => {
  clearTemp();
  const first = ayalaService.appendTransaction(makeRecord());
  const second = ayalaService.appendTransaction(makeRecord());
  assert.strictEqual(first, second);

  const content = fs.readFileSync(path.join(TEMP_DIR, first), "utf-8");
  const occurrences = content.split("\n").filter((l) => l === "TRANSACTION_NO,7904").length;
  assert.strictEqual(occurrences, 1, "the resend must not append a second block");
});

test("appendTransaction THROWS on a collision: same TRANSACTION_NO, different SLS_FLAG", () => {
  clearTemp();
  ayalaService.appendTransaction(makeRecord({ SLS_FLAG: "S" }));

  assert.throws(
    () => ayalaService.appendTransaction(makeRecord({ SLS_FLAG: "R" })),
    (err) => err.code === "TRN_NO_COLLISION",
    "a refund reusing the sale's TRANSACTION_NO must be rejected, not silently dropped",
  );
});

test("appendHourlyTransactions absorbs a re-send batch", () => {
  clearTemp();
  const first = ayalaService.appendHourlyTransactions("260804", "20", [makeRecord()]);
  const second = ayalaService.appendHourlyTransactions("260804", "20", [makeRecord()]);
  assert.strictEqual(first, second);

  const content = fs.readFileSync(path.join(TEMP_DIR, first), "utf-8");
  const occurrences = content.split("\n").filter((l) => l === "TRANSACTION_NO,7904").length;
  assert.strictEqual(occurrences, 1);
});

test("appendHourlyTransactions THROWS when a batch record collides with the existing draft", () => {
  clearTemp();
  ayalaService.appendHourlyTransactions("260804", "20", [makeRecord({ SLS_FLAG: "S" })]);

  assert.throws(
    () =>
      ayalaService.appendHourlyTransactions("260804", "20", [
        makeRecord({ SLS_FLAG: "R" }),
      ]),
    (err) => err.code === "TRN_NO_COLLISION",
  );
});

test("appendHourlyTransactions THROWS when two records WITHIN one batch collide", () => {
  clearTemp();
  assert.throws(
    () =>
      ayalaService.appendHourlyTransactions("260804", "20", [
        makeRecord({ SLS_FLAG: "S" }),
        makeRecord({ SLS_FLAG: "R" }),
      ]),
    (err) => err.code === "TRN_NO_COLLISION",
  );
});

test("finalizeHourlyDraft keeps the FIRST occurrence and drops a colliding second one (no throw — cron context)", () => {
  clearTemp();
  // Bypass the append-time guard entirely by writing the draft directly, to
  // exercise finalizeHourlyDraft's own defense-in-depth dedup in isolation.
  const tempFilename = "temp_08_04_26_hour_20_ter_001.csv";
  const lines = [
    "CCCODE,84106000000001070",
    "MERCHANT_NAME,MAMONAKU KOHI",
    "TRN_DATE,2026-08-04",
    "NO_TRN,0",
    "CDATE,2026-08-04",
    "TRN_TIME,20:45",
    "TER_NO,001",
    "TRANSACTION_NO,7904",
    "GROSS_SLS,378.00",
    "SLS_FLAG,S",
    "CDATE,2026-08-04",
    "TRN_TIME,21:28",
    "TER_NO,001",
    "TRANSACTION_NO,7904",
    "GROSS_SLS,378.00",
    "SLS_FLAG,R",
  ];
  fs.writeFileSync(path.join(TEMP_DIR, tempFilename), lines.join("\n") + "\n");

  const finalized = ayalaService.finalizeHourlyDraft(tempFilename);
  assert.ok(finalized, "a draft with one surviving block must still finalize");

  const content = fs.readFileSync(path.join(UPLOADS_DIR, finalized), "utf-8");
  const slsFlagLines = content.split("\n").filter((l) => l.startsWith("SLS_FLAG,"));
  assert.strictEqual(slsFlagLines.length, 1, "the colliding second block must be dropped");
  assert.strictEqual(slsFlagLines[0], "SLS_FLAG,S", "the FIRST occurrence survives");
});
