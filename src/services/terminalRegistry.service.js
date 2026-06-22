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
 * State shape:
 * { "<ccode>": { "<ter_no>": {
 *   deviceId, uid, deviceName, createdAt, updatedAt, lastSeenAt
 * } } }
 *
 * Mirrored to a JSON file under TEMP_DIR so a bridge restart preserves
 * ownership and recent device presence.
 */
class TerminalRegistryService {
  constructor() {
    /**
     * @type {Record<string, Record<string, { deviceId: string, uid: string|null, deviceName?: string|null, createdAt?: number, updatedAt: number, lastSeenAt?: number }>>}
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

  /** Returns every registered TER_NO for a CCCODE, sorted ascending. */
  listTerNos(ccode) {
    return Object.keys(this.registry[ccode] || {}).sort();
  }

  _cleanName(deviceName) {
    const name = typeof deviceName === "string" ? deviceName.trim() : "";
    return name || null;
  }

  /**
   * Claims (ccode, terNo) for deviceId.
   *
   * - Free, or already owned by deviceId → { ok: true } (idempotent).
   * - Owned by a DIFFERENT device → { ok: false, conflict: true, owner } (hard block),
   *   UNLESS force:true, in which case the number is reassigned to deviceId and
   *   the result carries { tookOverFrom } describing the displaced owner.
   *
   * `force` is reserved for the explicit, human-confirmed device-setup path
   * (POST /terminal/register). The silent backfill paths (/heartbeat, /eod/*)
   * never pass it, so they can never quietly steal another device's terminal.
   *
   * A device re-registering releases any OTHER terNo it previously held under
   * the same ccode, so changing a device's terminal number doesn't leave a
   * stale reservation that would block the new device of that number.
   *
   * Without ccode+deviceId there is no identity to enforce, so the call is a
   * best-effort success (used by the /eod/start backfill path).
   */
  register({ ccode, terNo, deviceId, uid = null, deviceName = null, force = false }) {
    if (!ccode || !deviceId) {
      return { ok: true, conflict: false, owner: null, skipped: true };
    }
    const ter = this._norm(terNo);
    const existing = this.registry[ccode] && this.registry[ccode][ter];
    const isSameDevice = !!existing && existing.deviceId === deviceId;

    if (existing && !isSameDevice && !force) {
      return { ok: false, conflict: true, owner: existing };
    }

    if (!this.registry[ccode]) this.registry[ccode] = {};
    const now = Date.now();
    const cleanName = this._cleanName(deviceName);

    // On a forced takeover the previous owner is a DIFFERENT device, so do not
    // inherit its uid/deviceName/createdAt — start fresh for the new owner.
    const tookOverFrom = existing && !isSameDevice ? { ...existing } : null;
    const base = isSameDevice ? existing : {};

    // Release any other terNo previously held by this device under this ccode.
    for (const key of Object.keys(this.registry[ccode])) {
      if (key !== ter && this.registry[ccode][key].deviceId === deviceId) {
        delete this.registry[ccode][key];
      }
    }

    this.registry[ccode][ter] = {
      ...base,
      deviceId,
      uid: uid || base.uid || null,
      deviceName: cleanName || base.deviceName || null,
      createdAt: base.createdAt || now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this._persist();
    return {
      ok: true,
      conflict: false,
      owner: this.registry[ccode][ter],
      tookOverFrom,
    };
  }

  /**
   * Records that a known terminal is currently talking to the bridge. This is
   * intentionally routed through register() so presence updates also keep the
   * TER_NO uniqueness guard fresh.
   */
  touch({ ccode, terNo, deviceId, uid = null, deviceName = null }) {
    return this.register({ ccode, terNo, deviceId, uid, deviceName });
  }

  /**
   * Returns registered devices with computed online state.
   *
   * @param {{ ccode?: string|null, onlineWindowMs?: number }} [options]
   */
  listDevices(options = {}) {
    const { ccode = null, onlineWindowMs = 60 * 1000 } = options;
    const now = Date.now();
    const ccodeEntries = ccode
      ? [[ccode, this.registry[ccode] || {}]]
      : Object.entries(this.registry);
    const devices = [];

    for (const [storeCode, terminals] of ccodeEntries) {
      for (const [terNo, owner] of Object.entries(terminals || {})) {
        const lastSeenAt = owner.lastSeenAt || owner.updatedAt || null;
        const secondsSinceLastSeen = lastSeenAt
          ? Math.max(0, Math.round((now - lastSeenAt) / 1000))
          : null;
        const online =
          typeof secondsSinceLastSeen === "number" &&
          secondsSinceLastSeen * 1000 <= onlineWindowMs;

        devices.push({
          ccode: storeCode,
          terNo,
          deviceId: owner.deviceId,
          deviceName: owner.deviceName || `Terminal ${terNo}`,
          uid: owner.uid || null,
          createdAt: owner.createdAt || null,
          updatedAt: owner.updatedAt || null,
          lastSeenAt,
          lastSeenAtIso: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
          latestConnectionTimeIso: lastSeenAt
            ? new Date(lastSeenAt).toISOString()
            : null,
          secondsSinceLastSeen,
          online,
        });
      }
    }

    return devices.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if ((b.lastSeenAt || 0) !== (a.lastSeenAt || 0)) {
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
      }
      return `${a.ccode}:${a.terNo}`.localeCompare(`${b.ccode}:${b.terNo}`);
    });
  }
}

module.exports = new TerminalRegistryService();
