/**
 * Tests for the store-wide-unique TER_NO registry, focused on the force-takeover
 * (reinstall-recovery) behavior. See utak task f76502db and memory
 * ayala-terminal-registry-takeover.
 *
 * Run with: npm test  (uses Node's built-in test runner — no framework dep).
 *
 * The service is a singleton that mirrors to C:\UTAK\Temp\terminal_registry.json.
 * We stub _persist and reset the in-memory map per test so these never touch
 * disk or the machine's real registry.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// Silence electron-log's file transport so the suite writes no stray log files.
const log = require("electron-log");
log.transports.file.level = false;

const registry = require("../src/services/terminalRegistry.service");
registry._persist = () => {}; // never write to disk during tests

const CC = "84106000000001070";

function reset() {
  registry.registry = {};
}

test("claims a free terminal number (normalized to 3 digits)", () => {
  reset();
  const r = registry.register({
    ccode: CC,
    terNo: "1",
    deviceId: "A",
    uid: "uidA",
    deviceName: "POS A",
  });
  assert.equal(r.ok, true);
  assert.equal(r.conflict, false);
  assert.equal(r.owner.deviceId, "A");
  assert.equal(r.owner.deviceName, "POS A");
  assert.equal(r.tookOverFrom, null);
  assert.deepEqual(registry.listTerNos(CC), ["001"]);
});

test("re-registering the SAME device is idempotent and preserves createdAt", async () => {
  reset();
  const first = registry.register({ ccode: CC, terNo: "1", deviceId: "A" });
  const createdAt = first.owner.createdAt;
  await new Promise((r) => setTimeout(r, 2));
  const again = registry.register({ ccode: CC, terNo: "1", deviceId: "A" });
  assert.equal(again.ok, true);
  assert.equal(again.conflict, false);
  assert.equal(again.tookOverFrom, null);
  assert.equal(again.owner.createdAt, createdAt, "createdAt must not reset");
  assert.ok(again.owner.updatedAt >= createdAt);
});

test("hard-blocks a DIFFERENT device without force (the 409 path) and does not mutate ownership", () => {
  reset();
  registry.register({ ccode: CC, terNo: "1", deviceId: "A", deviceName: "POS A" });
  const r = registry.register({
    ccode: CC,
    terNo: "1",
    deviceId: "B",
    deviceName: "POS B",
  });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(r.owner.deviceId, "A", "owner surfaced for the prompt is still A");
  // Ownership unchanged in the registry — B cannot silently take it.
  assert.equal(
    registry.check({ ccode: CC, terNo: "1", deviceId: "B" }).owner.deviceId,
    "A",
  );
});

test("force takeover reassigns to the new device with a FRESH owner record", () => {
  reset();
  registry.register({
    ccode: CC,
    terNo: "1",
    deviceId: "A",
    uid: "uidA",
    deviceName: "POS A",
  });
  // Age the original record so a NON-inherited createdAt is provable regardless
  // of how fast the two register() calls run (Date.now() has ms resolution).
  registry.registry[CC]["001"].createdAt = 1000;
  const r = registry.register({
    ccode: CC,
    terNo: "1",
    deviceId: "B",
    uid: "uidB",
    deviceName: "POS B",
    force: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.conflict, false);
  assert.equal(r.owner.deviceId, "B");
  assert.equal(r.tookOverFrom.deviceId, "A", "displaced owner is reported");
  // Must NOT inherit the displaced owner's identity (uid / name / createdAt).
  assert.equal(r.owner.uid, "uidB");
  assert.equal(r.owner.deviceName, "POS B");
  assert.notEqual(r.owner.createdAt, 1000, "createdAt is fresh, not inherited");
});

test("force on a FREE number is a normal claim (no takeover record)", () => {
  reset();
  const r = registry.register({ ccode: CC, terNo: "2", deviceId: "A", force: true });
  assert.equal(r.ok, true);
  assert.equal(r.conflict, false);
  assert.equal(r.tookOverFrom, null);
});

test("reinstall recovery: same physical device, regenerated id, takes over its own number", () => {
  reset();
  // Original install owns terminal 5.
  registry.register({
    ccode: CC,
    terNo: "5",
    deviceId: "old-install-id",
    deviceName: "Front Counter",
  });
  // After reinstall the persisted id regenerated → looks like a new device →
  // hard-blocked without force (this was the 409 lockout being fixed).
  const blocked = registry.register({
    ccode: CC,
    terNo: "5",
    deviceId: "new-install-id",
  });
  assert.equal(blocked.conflict, true);
  // User confirms the takeover prompt → force reassigns to the new id.
  const ok = registry.register({
    ccode: CC,
    terNo: "5",
    deviceId: "new-install-id",
    force: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.owner.deviceId, "new-install-id");
  assert.equal(ok.tookOverFrom.deviceId, "old-install-id");
});

test("a device changing its terminal number releases its previous reservation", () => {
  reset();
  registry.register({ ccode: CC, terNo: "1", deviceId: "A" });
  registry.register({ ccode: CC, terNo: "3", deviceId: "A" }); // A moves 1 → 3
  assert.deepEqual(registry.listTerNos(CC), ["003"], "stale 001 reservation freed");
  // Number 1 is now free for another device (no stale lock).
  const r = registry.register({ ccode: CC, terNo: "1", deviceId: "B" });
  assert.equal(r.ok, true);
  assert.equal(r.conflict, false);
});

test("check() is read-only and reports availability + owner correctly", () => {
  reset();
  assert.equal(registry.check({ ccode: CC, terNo: "7", deviceId: "A" }).available, true);
  registry.register({ ccode: CC, terNo: "7", deviceId: "A" });
  // Same device → still available (idempotent re-check of its own number).
  assert.equal(registry.check({ ccode: CC, terNo: "7", deviceId: "A" }).available, true);
  // Different device → unavailable, owner surfaced so the modal can prompt.
  const other = registry.check({ ccode: CC, terNo: "7", deviceId: "B" });
  assert.equal(other.available, false);
  assert.equal(other.owner.deviceId, "A");
  // check() must not mutate.
  assert.equal(registry.listTerNos(CC).length, 1);
});

test("missing ccode/deviceId is a best-effort skip (the /eod/start no-identity path)", () => {
  reset();
  const r = registry.register({ terNo: "1", deviceId: "A" }); // no ccode
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test("silent backfill via touch() (no force) can NEVER steal another device's number", () => {
  reset();
  registry.register({ ccode: CC, terNo: "1", deviceId: "A" });
  // touch() routes through register() WITHOUT force (heartbeat / eod backfill).
  const t = registry.touch({ ccode: CC, terNo: "1", deviceId: "B" });
  assert.equal(t.conflict, true);
  assert.equal(t.owner.deviceId, "A");
});
