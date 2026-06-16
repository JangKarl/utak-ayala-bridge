const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const { TEMP_DIR } = require("../constants/ayala");

const REGISTRY_FILE = path.join(TEMP_DIR, "terminal_registry.json");

/**
 * Cross-account terminal-number registry.
 *
 * The bridge is the only component that sees every Utak account (UID) sharing
 * a store (same CCCODE), so it is the authoritative place to enforce that a
 * terminal number (TER_NO) is unique store-wide. Ayala EOD consolidation keys
 * everything on TER_NO — if two devices share one, the later /endOfDay
 * overwrites the earlier terminal's column in EOD{ccode}{mmddyy}.csv and that
 * terminal's sales are silently lost (see ayala.service.generateEodFile).
 *
 * State shape: { "<ccode>": { "<ter_no>": { deviceId, uid, updatedAt } } },
 * mirrored to a JSON file under TEMP_DIR so a bridge restart preserves
 * ownership.
 */
class TerminalRegistryService {
  constructor() {
    /**
     * @type {Record<string, Record<string, { deviceId: string, uid: string|null, updatedAt: number }>>}
     */
    this.registry = {};
    this._hydrate();
  }

  _hydrate() {
    try {
      if (!fs.existsSync(REGISTRY_FILE)) return;
      const raw = fs.readFileSync(REGISTRY_FILE, "utf-8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") this.registry = obj;
      log.info(
        `[TerminalRegistry] Hydrated ${Object.keys(this.registry).length} ccode(s) from disk`,
      );
    } catch (err) {
      log.warn(`[TerminalRegistry] Could not hydrate registry: ${err.message}`);
    }
  }

  _persist() {
    try {
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(this.registry));
    } catch (err) {
      log.warn(`[TerminalRegistry] Could not persist registry: ${err.message}`);
    }
  }

  _norm(terNo) {
    return String(terNo || "").trim().padStart(3, "0");
  }

  /**
   * Returns ownership info for (ccode, terNo) without mutating anything.
   * available=true means the number is free, OR is already owned by deviceId
   * (idempotent — the same device re-checking its own number).
   */
  check({ ccode, terNo, deviceId }) {
    const ter = this._norm(terNo);
    const owner = this.registry[ccode] && this.registry[ccode][ter];
    if (!owner) return { available: true, owner: null };
    const sameDevice = deviceId != null && owner.deviceId === deviceId;
    return { available: sameDevice, owner };
  }

  /**
   * Claims (ccode, terNo) for deviceId.
   *
   * - Free, or already owned by deviceId → { ok: true } (idempotent).
   * - Owned by a DIFFERENT device → { ok: false, conflict: true, owner } (hard block).
   *
   * A device re-registering releases any OTHER terNo it previously held under
   * the same ccode, so changing a device's terminal number doesn't leave a
   * stale reservation that would block the new device of that number.
   *
   * Without ccode+deviceId there is no identity to enforce, so the call is a
   * best-effort success (used by the /eod/start backfill path).
   */
  register({ ccode, terNo, deviceId, uid = null }) {
    if (!ccode || !deviceId) {
      return { ok: true, conflict: false, owner: null, skipped: true };
    }
    const ter = this._norm(terNo);
    const existing = this.registry[ccode] && this.registry[ccode][ter];

    if (existing && existing.deviceId !== deviceId) {
      return { ok: false, conflict: true, owner: existing };
    }

    if (!this.registry[ccode]) this.registry[ccode] = {};

    // Release any other terNo previously held by this device under this ccode.
    for (const key of Object.keys(this.registry[ccode])) {
      if (key !== ter && this.registry[ccode][key].deviceId === deviceId) {
        delete this.registry[ccode][key];
      }
    }

    this.registry[ccode][ter] = { deviceId, uid, updatedAt: Date.now() };
    this._persist();
    return { ok: true, conflict: false, owner: this.registry[ccode][ter] };
  }
}

module.exports = new TerminalRegistryService();
