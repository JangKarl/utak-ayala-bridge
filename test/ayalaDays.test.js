const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listAyalaDays, ayalaDayDetail } = require("../src/services/ayalaDays.service");

const CC = "84106000000001070";

test("classifies each business day from the pickup folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ayala-days-"));
  const put = (n, s = "") => fs.writeFileSync(path.join(dir, n), s);
  // 102826: today, hourly only. 102726: EOD has 001 but 002 sold too.
  // 102626: complete. 102526: hourly but no EOD. 102426: reprocess open.
  put(`${CC}102826001_5.csv`);
  put(`${CC}102726001_9.csv`);
  put(`${CC}102726002_3.csv`);
  put(`EOD${CC}102726.csv`, `CCCODE,${CC}\nTER_NO,001\nGROSS_SLS,1500.50\n`);
  put(`${CC}102626001_4.csv`);
  put(`EOD${CC}102626.csv`, `CCCODE,${CC}\r\nTER_NO,"001","002"\r\nGROSS_SLS,100.00,250.25\r\n`);
  put(`${CC}102526002_1.csv`);
  put(`EOD${CC}102426.csv`, `TER_NO,001\nGROSS_SLS,1\n`);

  const rows = listAyalaDays({
    dir,
    days: ["102826", "102726", "102626", "102526", "102426", "102326"],
    ccodes: [CC],
    pending: [{ ccode: CC, mmddyy: "102426", pendingTerNos: ["002"] }],
  });
  const by = Object.fromEntries(rows.map((r) => [r.day, r]));

  assert.equal(by["102826"].status, "open");
  assert.deepEqual(by["102826"].hourly, { "001": 1 });
  assert.equal(by["102726"].status, "missing");
  assert.deepEqual(by["102726"].missing, ["002"]);
  assert.equal(by["102726"].gross, 1500.5);
  assert.equal(by["102626"].status, "closed");
  assert.deepEqual(by["102626"].terNos, ["001", "002"]);
  assert.equal(by["102626"].gross, 350.25);
  assert.equal(by["102526"].status, "noeod");
  assert.equal(by["102426"].status, "resending");
  assert.deepEqual(by["102426"].missing, ["002"]);
  assert.equal(by["102326"].status, "nosales");
});

test("a day's trail: hourly sends, the hour still collecting, and EOD totals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ayala-out-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ayala-tmp-"));
  const txn = (time, no, gross, flag = "S") =>
    `CDATE,2026-10-27\nTRN_TIME,${time}\nTER_NO,001\nTRANSACTION_NO,${no}\nGROSS_SLS,${gross}\nSLS_FLAG,${flag}\nQTY,1.000\nPRICE,${gross}\n`;
  const head = (cc) => `CCCODE,${cc}\nMERCHANT_NAME,DEMO\nTRN_DATE,2026-10-27\nNO_TRN,0\n`;
  fs.writeFileSync(path.join(dir, `${CC}102726001_000002.csv`), head(CC) + txn("10:05:00", "000001", "100.00") + txn("10:40:00", "000002", "50.00", "R"));
  fs.writeFileSync(path.join(dir, `${CC}102726002_000007.csv`), head(CC) + txn("09:15:00", "000007", "80.50"));
  fs.writeFileSync(path.join(tmp, "temp_10_27_26_hour_11_ter_001.csv"), head(CC) + txn("11:01:00", "000003", "20.00"));
  fs.writeFileSync(path.join(tmp, "temp_10_27_26_hour_11_ter_009.csv"), head("999") + txn("11:01:00", "1", "1"));
  fs.writeFileSync(path.join(dir, `EOD${CC}102726.csv`),
    `CCCODE,${CC}\nTER_NO,001,002\nSTRANS,00000001,00000007\nETRANS,00000003,00000007\nGROSS_SLS,120.00,80.50\nNO_VOID,1,0\nVOID_AMNT,15.00,0.00\n`);

  const d = ayalaDayDetail({ dir, tempDir: tmp, ccode: CC, day: "102726" });
  assert.deepEqual(d.hours.map((h) => [h.hour, h.ter, h.txns, h.refunds, h.gross, h.pending]), [
    [9, "002", 1, 0, 80.5, false],
    [10, "001", 2, 1, 100, false],
    [11, "001", 1, 0, 20, true],
  ]);
  assert.deepEqual(d.hours[1].receipts, ["000001", "000002"]);
  assert.equal(d.eod.terminals.length, 2);
  assert.equal(d.eod.terminals[0].gross, 120);
  assert.equal(d.eod.terminals[0].noVoid, 1);
  assert.deepEqual(d.eod.terminals[1].receipts, ["00000007", "00000007"]);
  assert.equal(ayalaDayDetail({ dir, tempDir: tmp, ccode: CC, day: "102626" }).eod, null);
});

test("a missing folder reads as no sales", () => {
  const [r] = listAyalaDays({ dir: path.join(os.tmpdir(), "nope-ayala-x"), days: ["102826"], ccodes: [CC] });
  assert.equal(r.status, "nosales");
});
