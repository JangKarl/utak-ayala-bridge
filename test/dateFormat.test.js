const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { execFileSync } = require("child_process");

const { mmddyy, mmddyyUnderscored, parseWireDate, nowTz } = require("../src/utils");

const FIXTURE = path.join(__dirname, "fixtures", "printDateStamps.js");

/**
 * Runs the date helpers in a child process under a forced timezone. Node reads
 * the local timezone once at process start, so this cannot be done in-process.
 */
function stampsUnderTz(tz, dateStr) {
  const out = execFileSync(process.execPath, [FIXTURE, dateStr], {
    env: { ...process.env, TZ: tz },
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

test("mmddyy formats a wire date as MMDDYY", () => {
  assert.strictEqual(mmddyy("2026-07-27"), "072726");
  assert.strictEqual(mmddyy("2026-01-01"), "010126");
  assert.strictEqual(mmddyy("2026-12-31"), "123126");
});

test("mmddyyUnderscored formats a wire date as MM_DD_YY", () => {
  assert.strictEqual(mmddyyUnderscored("2026-07-27"), "07_27_26");
  assert.strictEqual(mmddyyUnderscored("2026-01-01"), "01_01_26");
});

test("mmddyy returns null on an invalid or malformed date", () => {
  assert.strictEqual(mmddyy("not-a-date"), null);
  assert.strictEqual(mmddyy("2026-13-45"), null);
  assert.strictEqual(mmddyy(""), null);
  assert.strictEqual(mmddyy(undefined), null);
  assert.strictEqual(mmddyyUnderscored("nope"), null);
});

test("parseWireDate rejects a value the ISO sniffer would have accepted", () => {
  // Guards the explicit format string: without it moment falls back to a
  // permissive parser and these would come back valid.
  assert.strictEqual(parseWireDate("07/27/2026").isValid(), false);
  assert.strictEqual(parseWireDate("2026-07-27T15:00:00Z").isValid(), false);
});

test("nowTz reports the store timezone regardless of machine timezone", () => {
  assert.strictEqual(nowTz().tz(), "Asia/Manila");
});

test("REGRESSION: filename date matches TRN_DATE under a negative-offset TZ", () => {
  // The Alley (Ayala tenant): EOD{cccode}072626.csv contained TRN_DATE
  // 2026-07-27 and the mall rejected it. Their POS PC is not on Manila time.
  const hostile = stampsUnderTz("America/Los_Angeles", "2026-07-27");

  assert.strictEqual(
    hostile.legacy,
    "072626",
    "control: the hostile TZ must actually reproduce the old skew, else this test proves nothing",
  );
  assert.strictEqual(hostile.mmddyy, "072726");
  assert.strictEqual(hostile.mmddyyUnderscored, "07_27_26");
});

test("REGRESSION: date stamps are identical across machine timezones", () => {
  const zones = [
    "Asia/Manila",
    "UTC",
    "America/Los_Angeles",
    "America/New_York",
    "Pacific/Honolulu",
    "Pacific/Kiritimati",
  ];

  for (const tz of zones) {
    const got = stampsUnderTz(tz, "2026-07-27");
    assert.strictEqual(got.mmddyy, "072726", `mmddyy wrong under TZ=${tz}`);
    assert.strictEqual(
      got.mmddyyUnderscored,
      "07_27_26",
      `mmddyyUnderscored wrong under TZ=${tz}`,
    );
  }
});
