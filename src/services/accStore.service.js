const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { TEMP_DIR, TIMEZONE } = require("../constants/ayala");
const { atomicWriteFile } = require("../utils");

// How long sales and delivery records stay on the laptop.
const KEEP_DAYS = 45;

/**
 * The laptop's copy of the store's sales, per business day, so a file can be
 * built without internet. Sales are appended as JSON lines (last write wins
 * per transaction key), so a refund re-sent later simply replaces the sale.
 *
 * state.json: { config, totals: {YYMMDD: {term: newGT}}, days: {YYMMDD: {
 *   closes: {term: {count, lastReceiptNo, at}}, sent?: {...} }} }
 */
class AccStore {
  constructor(
    dir = process.env.ACC_STATE_DIR || path.join(TEMP_DIR, "acc"),
    now = () => Date.now(),
  ) {
    this.now = now;
    this.txnDir = path.join(dir, "txns");
    this.statePath = path.join(dir, "state.json");
    fs.mkdirSync(this.txnDir, { recursive: true });
    this.state = { config: null, totals: {}, days: {} };
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(this.statePath, "utf8")));
    } catch (_) {
      /* first run */
    }
  }

  static dayOf(txnKey) {
    return moment.unix(Number(txnKey)).tz(TIMEZONE).format("YYMMDD");
  }

  save() {
    atomicWriteFile(this.statePath, JSON.stringify(this.state, null, 2));
  }

  day(d) {
    if (!this.state.days[d]) this.state.days[d] = { closes: {} };
    return this.state.days[d];
  }

  putTxn(key, val) {
    const d = AccStore.dayOf(key);
    fs.appendFileSync(
      path.join(this.txnDir, `${d}.jsonl`),
      JSON.stringify({ key: String(key), val }) + "\n",
    );
    return d;
  }

  /** @returns {{ key: string, val: object }[]} latest version of each sale */
  txnList(d) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(this.txnDir, `${d}.jsonl`), "utf8");
    } catch (_) {
      return [];
    }
    const byKey = new Map();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const t = JSON.parse(line);
        byKey.set(t.key, t.val);
      } catch (_) {
        /* torn last line after a power cut */
      }
    }
    return [...byKey].map(([key, val]) => ({ key, val }));
  }

  recordClose(d, terminal, { count, lastReceiptNo }) {
    this.day(d).closes[terminal] = { count, lastReceiptNo, at: this.now() };
    this.save();
  }

  /**
   * Complete = every terminal that sold that day reported its close, and the
   * laptop holds at least as many sales as each terminal says it made.
   */
  completeness(d) {
    const closes = this.day(d).closes;
    const held = {};
    for (const { val } of this.txnList(d)) {
      const t = String(parseInt(val?.terminalNumber ?? val?.terminal ?? 1, 10) || 1);
      held[t] = (held[t] || 0) + 1;
    }
    const missingClose = Object.keys(held).filter((t) => !closes[t]);
    const short = Object.entries(closes)
      .filter(([t, c]) => (held[t] || 0) < (c.count || 0))
      .map(([t, c]) => ({ terminal: t, held: held[t] || 0, expected: c.count }));
    return { complete: !missingClose.length && !short.length, missingClose, short };
  }

  setConfig(config) {
    this.state.config = config;
    const last = config?.lastTotals;
    if (last?.key) this.state.totals[last.key] = last.totals;
    this.save();
  }

  setTotals(d, totals) {
    this.state.totals[d] = totals;
    this.save();
  }

  /** Grand totals of the last day before d that has any (F16 carry). */
  totalsBefore(d) {
    const key = Object.keys(this.state.totals)
      .filter((k) => k < d)
      .sort()
      .pop();
    return key ? this.state.totals[key] : {};
  }

  markSent(d, sent) {
    this.day(d).sent = { ...sent, at: this.now() };
    this.save();
  }

  /** Days whose last close is older than the deadline and nothing was sent. */
  dueForLocal(now, deadlineMs) {
    return Object.entries(this.state.days)
      .filter(([, day]) => !day.sent)
      .filter(([, day]) => {
        const at = Math.max(0, ...Object.values(day.closes).map((c) => c.at));
        return at > 0 && now - at >= deadlineMs;
      })
      .map(([d]) => d)
      .sort();
  }

  unverifiedLocalDays() {
    return Object.entries(this.state.days)
      .filter(([, day]) => day.sent?.via === "local" && !day.sent.verified)
      .map(([d]) => d)
      .sort();
  }

  lastSent() {
    const sent = Object.entries(this.state.days)
      .filter(([, day]) => day.sent)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .pop();
    return sent ? { day: sent[0], ...sent[1].sent, content: undefined } : null;
  }

  prune(now = this.now()) {
    const cutoff = moment(now).tz(TIMEZONE).subtract(KEEP_DAYS, "days").format("YYMMDD");
    // Never drop a local file the cloud has not checked yet.
    const unchecked = new Set(this.unverifiedLocalDays());
    const keep = (d) => d >= cutoff || unchecked.has(d);
    let changed = false;
    for (const f of fs.readdirSync(this.txnDir)) {
      if (!keep(f.slice(0, 6))) fs.rmSync(path.join(this.txnDir, f), { force: true });
    }
    for (const d of Object.keys(this.state.days)) {
      if (keep(d)) continue;
      delete this.state.days[d];
      changed = true;
    }
    // The newest totals always stay: they seed the next Old Grand Total.
    for (const d of Object.keys(this.state.totals).sort().slice(0, -1)) {
      if (d < cutoff) {
        delete this.state.totals[d];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

module.exports = { AccStore };
