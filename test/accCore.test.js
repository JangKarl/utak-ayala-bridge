// Same golden file as fun/functions/mall/acc/_core/__tests__: the laptop's
// offline build must match the cloud's byte for byte.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildDailyFile } = require("../src/acc-core/buildDailyFile");

const dir = path.join(__dirname, "fixtures", "acc");
const day = JSON.parse(fs.readFileSync(path.join(dir, "day.json"), "utf8"));

test("vendored ACC core matches the cloud golden file", () => {
  const out = buildDailyFile(day);
  assert.strictEqual(out.filename, "05142601.csv");
  assert.strictEqual(out.content, fs.readFileSync(path.join(dir, out.filename), "utf8"));
});
