// ACC send rules with a fake cloud and throwaway folders: cloud delivery,
// waiting for an unsynced cloud, the offline deadline, and the check that
// confirms or corrects an offline file.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AccStore } = require("../src/services/accStore.service");
const { AccSender, describeSync } = require("../src/services/accSender.service");

const fixtures = path.join(__dirname, "fixtures", "acc");
const day = JSON.parse(fs.readFileSync(path.join(fixtures, "day.json"), "utf8"));
const golden = fs.readFileSync(path.join(fixtures, "05142601.csv"), "utf8");
const D = "260514";
const HOUR = 60 * 60 * 1000;

// Activation 40 days earlier gives Z 40/41 and these totals give the golden
// file's Old Grand Totals, so an offline build must equal the golden CSV.
const config = {
  posCode: "RW-ACC-TEST",
  terminalNumbers: [1, 2],
  firstShiftKey: "260404",
  zCounter: 0,
  lastTotals: { key: "260513", totals: { 1: 1000, 2: 500 } },
};

function setup({ online = true, cloudContent = golden, cloudTxns = 6, closed = [D] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-"));
  process.env.ACC_FOLDER = path.join(root, "ACC");
  process.env.ACC_DEADLINE_MIN = "60";
  // The fixture's own day, so the 45-day cleanup keeps it.
  let now = Date.parse("2026-05-14T14:00:00Z");
  const clock = () => now;
  const store = new AccStore(path.join(root, "state"), clock);
  const calls = [];
  let counter = 0;
  const cloud = {
    pending: async () => {
      if (!online) throw new Error("offline");
      return { pending: closed.filter((d) => !store.day(d).sent || store.day(d).sent.via === "local"), closed, config };
    },
    download: async (d, mode) => {
      calls.push(["download", d, mode]);
      const sent = store.day(d).sent;
      const cc = mode === "deliver" && sent?.acked ? sent.cc : ++counter;
      return { filename: `051426${String(cc).padStart(2, "0")}.csv`, content: cloudContent, cc, txns: cloudTxns };
    },
    ack: async (d, cc, via) => {
      calls.push(["ack", d, cc, via]);
      counter = Math.max(counter, cc);
      return { ok: true };
    },
  };
  const sender = new AccSender({ store, cloud, now: clock });
  return {
    store,
    sender,
    calls,
    files: () => (fs.existsSync(process.env.ACC_FOLDER) ? fs.readdirSync(process.env.ACC_FOLDER).sort() : []),
    read: (f) => fs.readFileSync(path.join(process.env.ACC_FOLDER, f), "utf8"),
    advance: (ms) => (now += ms),
    goOnline: (v = true) => (online = v),
  };
}

const feed = (store) => {
  for (const t of day.txns) store.putTxn(t.key, t.val);
  store.recordClose(D, "1", { count: 3 });
  store.recordClose(D, "2", { count: 3 });
};

test("online: delivers the cloud file once and acks it", async () => {
  const t = setup();
  feed(t.store);
  await t.sender.sync();
  await t.sender.sync();
  assert.deepStrictEqual(t.files(), ["05142601.csv"]);
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "ack"), [["ack", D, 1, "cloud"]]);
  assert.deepStrictEqual(t.store.state.totals[D], { 1: 1436, 2: 1350 });
});

test("online but cloud missing sales: waits, then sends locally at the deadline", async () => {
  const t = setup({ cloudTxns: 4 });
  feed(t.store);
  await t.sender.sync();
  assert.deepStrictEqual(t.files(), []);
  t.advance(HOUR);
  await t.sender.sync();
  assert.deepStrictEqual(t.files(), ["05142601.csv"]);
  assert.strictEqual(t.read("05142601.csv"), golden);
});

test("offline: nothing before the deadline, the golden file after it", async () => {
  const t = setup();
  t.store.setConfig(config); // cached from an earlier online sync
  t.goOnline(false);
  feed(t.store);
  await t.sender.sync();
  assert.deepStrictEqual(t.files(), []);
  t.advance(HOUR);
  await t.sender.sync();
  assert.deepStrictEqual(t.files(), ["05142601.csv"]);
  assert.strictEqual(t.read("05142601.csv"), golden);
  assert.strictEqual(t.store.day(D).sent.complete, true);
});

test("back online, cloud agrees: offline file is confirmed, nothing resent", async () => {
  const t = setup();
  t.store.setConfig(config);
  t.goOnline(false);
  feed(t.store);
  t.advance(HOUR);
  await t.sender.sync();
  t.goOnline(true);
  await t.sender.sync();
  assert.deepStrictEqual(t.files(), ["05142601.csv"]);
  assert.strictEqual(t.store.day(D).sent.verified, true);
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "ack"), [["ack", D, 1, "local"]]);
});

test("back online, cloud differs: sends the cloud file as attempt 02", async () => {
  const t = setup({ cloudContent: golden.replace("RW-ACC-TEST", "RW-ACC-FIXED") });
  t.store.setConfig(config);
  t.goOnline(false);
  feed(t.store);
  t.advance(HOUR);
  await t.sender.sync();
  t.goOnline(true);
  await t.sender.sync();
  assert.deepStrictEqual(t.files(), ["05142601.csv", "05142602.csv"]);
  assert.match(t.read("05142602.csv"), /RW-ACC-FIXED/);
  assert.strictEqual(t.store.day(D).sent.corrected, "05142601.csv");
  assert.deepStrictEqual(
    t.calls.filter((c) => c[0] === "ack"),
    [["ack", D, 1, "local"], ["ack", D, 2, "cloud"]],
  );
});

test("a tablet that never reported its close makes the offline file incomplete", async () => {
  const t = setup();
  t.store.setConfig(config);
  t.goOnline(false);
  for (const tx of day.txns) t.store.putTxn(tx.key, tx.val);
  t.store.recordClose(D, "1", { count: 3 });
  t.advance(HOUR);
  await t.sender.sync();
  assert.strictEqual(t.store.day(D).sent.complete, false);
  assert.deepStrictEqual(t.store.completeness(D).missingClose, ["2"]);
});

test("a refund re-sent later replaces the earlier version of the sale", () => {
  const t = setup();
  const [first] = day.txns;
  t.store.putTxn(first.key, { ...first.val, receiptNo: 999 });
  t.store.putTxn(first.key, first.val);
  const list = t.store.txnList(D);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].val.receiptNo, first.val.receiptNo);
});

test("each sync reports what it did, in words the tray can show", async () => {
  const t = setup();
  feed(t.store);
  const first = await t.sender.sync();
  assert.deepStrictEqual(first.sent, ["05142601.csv"]);
  assert.deepStrictEqual(describeSync(first), { body: "Sent 05142601.csv.", isError: false });
  assert.match(describeSync(await t.sender.sync()).body, /^Nothing to send/);
  t.goOnline(false);
  assert.deepStrictEqual(describeSync(await t.sender.sync()), { body: "Cloud unreachable: offline.", isError: true });
  assert.match(describeSync({ busy: true }).body, /Already sending/);
});

test("cloud lists a day again (lost ack or resend): writes the same file again", async () => {
  const t = setup();
  feed(t.store);
  await t.sender.sync();
  fs.rmSync(path.join(process.env.ACC_FOLDER, "05142601.csv")); // e.g. collected by Pollsys
  const pending = t.sender.cloud.pending;
  t.sender.cloud.pending = async () => ({ ...(await pending()), pending: [D] });
  t.store.markSent(D, { ...t.store.day(D).sent, acked: true }); // deliver re-uses the CC
  const again = await t.sender.sync();
  assert.deepStrictEqual(again.sent, ["05142601.csv"]);
  assert.deepStrictEqual(t.files(), ["05142601.csv"]);
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "ack"), [["ack", D, 1, "cloud"], ["ack", D, 1, "cloud"]]);
});

test("days() gives the window one status per day, newest first", async () => {
  const t = setup({ cloudTxns: 4, closed: ["260513", D] });
  feed(t.store);
  await t.sender.sync();
  assert.deepStrictEqual(
    t.sender.days().map((r) => [r.day, r.status]),
    [[D, "waiting"], ["260513", "sent"]],
  );
  t.advance(HOUR);
  await t.sender.sync();
  const [row] = t.sender.days(1);
  assert.strictEqual(row.status, "offline");
  assert.strictEqual(row.filename, "05142601.csv");
});
