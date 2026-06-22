const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const { TEMP_DIR } = require("../constants/ayala");

const STATE_FILE = path.join(TEMP_DIR, "reprocess_state.json");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — reprocess can span until offline terminals return
const DEFAULT_FINALIZE_WINDOW_MS = 5 * 60 * 1000; // after this, carry-forward absent terminals and swap

/**
 * Tracks which (CCCODE, MMDDYY) days are pending a cross-terminal reprocess,
 * which terminals are expected to re-submit, and which already have.
 *
 * "Expected" terminals = the set already present in the live EOD file when the
 * reprocess was raised (each must re-submit fresh data into the staging
 * rebuild). When all have re-submitted — or the finalize window elapses, after
 * which absent terminals are carried forward from the snapshot — the rebuild is
 * swapped in and the grand-total chain is cascaded forward.
 *
 * Mirrors eodLock.service: in-memory Map mirrored to a JSON file under TEMP_DIR
 * so a bridge restart preserves pending reprocesses within their TTL.
 */
class ReprocessStateService {
  constructor() {
    /**
     * @type {Map<string, {
     *   ccode: string, mmddyy: string, startedBy: string|null, startedAt: number,
     *   expectedTerNos: string[], doneTerNos: string[],
     *   finalizeAt: number, expiresAt: number
     * }>}
     */
    this.state = new Map();
    this._hydrate();
  }

  _key(ccode, mmddyy) {
    return `${ccode}_${mmddyy}`;
  }

  _norm(terNo) {
    return String(terNo || "").trim().padStart(3, "0");
  }

  _hydrate() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const obj = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      const now = Date.now();
      for (const [key, entry] of Object.entries(obj)) {
        if (entry && typeof entry.expiresAt === "number" && entry.expiresAt > now) {
          this.state.set(key, entry);
        }
      }
      log.info(`[Reprocess] Hydrated ${this.state.size} pending reprocess(es)`);
    } catch (err) {
      log.warn(`[Reprocess] Could not hydrate state: ${err.message}`);
    }
  }

  _persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(this.state)));
    } catch (err) {
      log.warn(`[Reprocess] Could not persist state: ${err.message}`);
    }
  }

  _evictIfExpired(key) {
    const entry = this.state.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.state.delete(key);
      this._persist();
      return null;
    }
    return entry || null;
  }

  /**
   * Marks (CCCODE, MMDDYY) as needing a cross-terminal reprocess. Idempotent:
   * re-raising refreshes the expected set and timers without losing the
   * already-done terminals.
   *
   * @param {string[]} expectedTerNos terminals that must re-submit (from the
   *   live EOD file's TER_NO row at raise time).
   */
  markDirty({
    ccode,
    mmddyy,
    byTerNo = null,
    expectedTerNos = [],
    ttlMs = DEFAULT_TTL_MS,
    finalizeWindowMs = DEFAULT_FINALIZE_WINDOW_MS,
  }) {
    const key = this._key(ccode, mmddyy);
    const now = Date.now();
    const expected = expectedTerNos.map((t) => this._norm(t));
    const existing = this._evictIfExpired(key);

    const entry = {
      ccode,
      mmddyy,
      startedBy: existing ? existing.startedBy : byTerNo ? this._norm(byTerNo) : null,
      startedAt: existing ? existing.startedAt : now,
      // Union of any previously-known expected set with the new one.
      expectedTerNos: Array.from(
        new Set([...(existing ? existing.expectedTerNos : []), ...expected]),
      ),
      doneTerNos: existing ? existing.doneTerNos : [],
      finalizeAt: now + finalizeWindowMs,
      expiresAt: now + ttlMs,
    };
    this.state.set(key, entry);
    this._persist();
    return this._view(entry);
  }

  /** Records that a terminal has re-submitted its fresh data for the day. */
  markTerminalDone({ ccode, mmddyy, terNo }) {
    const key = this._key(ccode, mmddyy);
    const entry = this._evictIfExpired(key);
    if (!entry) return null;
    const ter = this._norm(terNo);
    if (!entry.doneTerNos.includes(ter)) entry.doneTerNos.push(ter);
    this.state.set(key, entry);
    this._persist();
    return this._view(entry);
  }

  /** Returns the reprocess view for a day, or a not-in-progress default. */
  getState({ ccode, mmddyy, terNo = null }) {
    const entry = this._evictIfExpired(this._key(ccode, mmddyy));
    if (!entry) {
      return {
        inProgress: false,
        startedBy: null,
        expectedTerNos: [],
        doneTerNos: [],
        pendingTerNos: [],
        selfPending: false,
      };
    }
    const view = this._view(entry);
    if (terNo) view.selfPending = view.pendingTerNos.includes(this._norm(terNo));
    return view;
  }

  /** True once every expected terminal has re-submitted, or the window elapsed. */
  shouldFinalize({ ccode, mmddyy }, now = Date.now()) {
    const entry = this._evictIfExpired(this._key(ccode, mmddyy));
    if (!entry) return false;
    const pending = this._pending(entry);
    return pending.length === 0 || now >= entry.finalizeAt;
  }

  clear({ ccode, mmddyy }) {
    const key = this._key(ccode, mmddyy);
    if (this.state.delete(key)) this._persist();
  }

  /** All currently-pending reprocesses (used by the periodic finalize sweep). */
  listPending() {
    const out = [];
    for (const [, entry] of this.state) {
      if (entry.expiresAt > Date.now()) out.push(this._view(entry));
    }
    return out;
  }

  _pending(entry) {
    return entry.expectedTerNos.filter((t) => !entry.doneTerNos.includes(t));
  }

  _view(entry) {
    return {
      inProgress: true,
      ccode: entry.ccode,
      mmddyy: entry.mmddyy,
      startedBy: entry.startedBy,
      startedAt: entry.startedAt,
      expectedTerNos: entry.expectedTerNos,
      doneTerNos: entry.doneTerNos,
      pendingTerNos: this._pending(entry),
      finalizeAt: entry.finalizeAt,
      selfPending: false,
    };
  }
}

module.exports = new ReprocessStateService();
