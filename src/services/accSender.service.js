const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const { atomicWriteFile } = require("../utils");
const { AccStore } = require("./accStore.service");
const { buildDailyFile, zCountsFor } = require("../acc-core/buildDailyFile");

/** {terminal: New Grand Total} from a file's 99 rows (F5, F17). */
function totalsFromCsv(content) {
  const totals = {};
  for (const line of content.split("\r\n")) {
    const c = line.split(",");
    if (c[0] === "99") totals[c[4]] = Number(c[16]);
  }
  return totals;
}

/**
 * Gets each closed day's file into the ACC folder, on time and correct:
 * 1. Cloud path: deliver the cloud's file, unless the cloud holds fewer sales
 *    than the laptop (a tablet hasn't synced yet). Then wait.
 * 2. Local path: past the deadline with nothing sent, build the file here.
 * 3. Check: once online, compare each local file with the cloud's. If they
 *    differ, send the cloud's as the next attempt (CC + 1).
 */
class AccSender {
  constructor({ store, cloud, now = () => Date.now() }) {
    this.store = store;
    this.cloud = cloud;
    this.now = now;
    this.running = false;
    this.online = null;
    this.lastRunAt = null;
    this.lastError = null;
  }

  folder() {
    return process.env.ACC_FOLDER || "C:\\ACC";
  }

  deadlineMs() {
    return (Number(process.env.ACC_DEADLINE_MIN) || 60) * 60 * 1000;
  }

  write(filename, content) {
    fs.mkdirSync(this.folder(), { recursive: true });
    atomicWriteFile(path.join(this.folder(), filename), content);
    log.info(`[ACC] wrote ${filename} to ${this.folder()}`);
  }

  async sync() {
    if (this.running) return;
    this.running = true;
    try {
      let cloud = null;
      try {
        cloud = await this.cloud.pending();
        this.store.setConfig(cloud.config);
        this.online = true;
      } catch (err) {
        this.online = false;
        log.warn(`[ACC] cloud unreachable: ${err.message}`);
      }

      if (cloud) {
        for (const d of cloud.pending) {
          if (this.store.day(d).sent) continue; // a local send, checked below
          await this.guard(d, () => this.deliverFromCloud(d));
        }
        const closed = new Set(cloud.closed);
        for (const d of this.store.unverifiedLocalDays()) {
          if (closed.has(d)) await this.guard(d, () => this.reconcile(d));
        }
      }

      for (const d of this.store.dueForLocal(this.now(), this.deadlineMs())) {
        await this.guard(d, () => this.sendLocal(d));
      }
      this.store.prune(this.now());
    } finally {
      this.running = false;
      this.lastRunAt = this.now();
    }
  }

  // One bad day (e.g. folder unreachable) must not block the others.
  async guard(d, fn) {
    try {
      await fn();
    } catch (err) {
      this.lastError = { day: d, message: err.message, at: this.now() };
      log.error(`[ACC] ${d}: ${err.message}`);
    }
  }

  async deliverFromCloud(d) {
    const f = await this.cloud.download(d, "deliver");
    const held = this.store.txnList(d).length;
    if (f.txns < held) {
      log.info(`[ACC] ${d}: cloud has ${f.txns} sales, laptop ${held}; waiting for sync`);
      return;
    }
    this.write(f.filename, f.content);
    await this.cloud.ack(d, f.cc, "cloud");
    this.store.markSent(d, { cc: f.cc, via: "cloud", filename: f.filename, verified: true });
    this.store.setTotals(d, totalsFromCsv(f.content));
  }

  sendLocal(d) {
    const cfg = this.store.state.config;
    if (!cfg?.posCode) {
      throw new Error("no store settings cached yet; needs one online sync first");
    }
    const check = this.store.completeness(d);
    const cc = 1;
    const file = buildDailyFile({
      shiftKey: d,
      txns: this.store.txnList(d),
      terminalNumbers: cfg.terminalNumbers || [1],
      oldGrandTotals: this.store.totalsBefore(d),
      zCounts: zCountsFor(d, cfg.firstShiftKey, cfg.zCounter || 0),
      posCode: cfg.posCode,
      cc,
    });
    this.write(file.filename, file.content);
    this.store.markSent(d, {
      cc,
      via: "local",
      filename: file.filename,
      content: file.content,
      complete: check.complete,
      verified: false,
      acked: false,
    });
    this.store.setTotals(d, file.newTotals);
    if (!check.complete) {
      log.warn(`[ACC] ${d}: sent offline but INCOMPLETE ${JSON.stringify(check)}`);
    }
  }

  async reconcile(d) {
    const sent = this.store.day(d).sent;
    if (!sent.acked) {
      await this.cloud.ack(d, sent.cc, "local");
      this.store.markSent(d, { ...sent, acked: true });
    }
    const f = await this.cloud.download(d, "deliver");
    if (f.txns < this.store.txnList(d).length) {
      log.info(`[ACC] ${d}: cloud not caught up yet; check later`);
      return;
    }
    if (f.content === sent.content) {
      this.store.markSent(d, { ...this.store.day(d).sent, verified: true, content: undefined });
      log.info(`[ACC] ${d}: offline file matches the cloud`);
      return;
    }
    const g = await this.cloud.download(d, "regenerate");
    this.write(g.filename, g.content);
    await this.cloud.ack(d, g.cc, "cloud");
    this.store.markSent(d, {
      cc: g.cc,
      via: "cloud",
      filename: g.filename,
      verified: true,
      corrected: sent.filename,
    });
    this.store.setTotals(d, totalsFromCsv(g.content));
    log.warn(`[ACC] ${d}: offline file differed; sent correction ${g.filename}`);
  }

  status() {
    return {
      online: this.online,
      folder: this.folder(),
      lastRunAt: this.lastRunAt,
      lastSent: this.store.lastSent(),
      lastError: this.lastError,
      unchecked: this.store.unverifiedLocalDays(),
    };
  }
}

let instance = null;
function accSender() {
  if (!instance) {
    instance = new AccSender({
      store: new AccStore(),
      cloud: require("./accCloud.service"),
    });
  }
  return instance;
}

module.exports = { AccSender, accSender, totalsFromCsv };
