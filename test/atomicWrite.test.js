const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { atomicWriteFile } = require("../src/utils");

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ayala-atomic-"));
  return path.join(dir, name);
}

test("atomicWriteFile writes content and leaves no .tmp behind", () => {
  const target = tmpFile("state.json");
  atomicWriteFile(target, JSON.stringify({ a: 1 }));
  assert.strictEqual(fs.readFileSync(target, "utf-8"), '{"a":1}');
  assert.strictEqual(
    fs.existsSync(`${target}.tmp`),
    false,
    "temp file should be renamed away",
  );
});

test("atomicWriteFile overwrites an existing target (Windows rename fallback)", () => {
  const target = tmpFile("registry.json");
  fs.writeFileSync(target, "OLD");
  atomicWriteFile(target, "NEW");
  assert.strictEqual(fs.readFileSync(target, "utf-8"), "NEW");
  assert.strictEqual(fs.existsSync(`${target}.tmp`), false);
});

test("atomicWriteFile result parses back cleanly (no truncation)", () => {
  const target = tmpFile("locks.json");
  const payload = { "8410_071926": { startedBy: "001", expiresAt: 123 } };
  atomicWriteFile(target, JSON.stringify(payload));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, "utf-8")), payload);
});
