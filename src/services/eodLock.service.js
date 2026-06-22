const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const { UPLOADS_DIR, TEMP_DIR, EOD_FIELDS } = require("../constants/ayala");

const LOCK_FILE = path.join(TEMP_DIR, "eod_locks.json");
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Parses a single CSV line, respecting double-quoted fields.
 */
function _parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Cross-terminal EOD lock registry.
 *
 * The bridge holds one lock per (CCCODE, MMDDYY). Any terminal sharing the
 * same CCCODE — regardless of which Utak account (UID) it belongs to — sees
 * the same lock. This lets a multi-Utak-account store coordinate EOD without
 * cross-UID Firebase access.
 *
 * State lives in memory and is mirrored to a JSON file under TEMP_DIR so a
 * bridge restart does not silently release locks within their TTL window.
 */
class EodLockService {
  constructor() {
    /** @type {Map<string, { startedBy: string, startedAt: number, expiresAt: number }>} */
    this.locks = new Map();
    this._hydrate();
  }

  _key(ccode, mmddyy) {
    return `${ccode}_${mmddyy}`;
  }

  _hydrate() {
    try {
      if (!fs.existsSync(LOCK_FILE)) return;
      const raw = fs.readFileSync(LOCK_FILE, "utf-8");
      const obj = JSON.parse(raw);
      const now = Date.now();
      for (const [key, entry] of Object.entries(obj)) {
        if (entry && typeof entry.expiresAt === "number" && entry.expiresAt > now) {
          this.locks.set(key, entry);
        }
      }
      log.info(`[EodLock] Hydrated ${this.locks.size} active lock(s) from disk`);
    } catch (err) {
      log.warn(`[EodLock] Could not hydrate lock file: ${err.message}`);
    }
  }

  _persist() {
    try {
      const obj = Object.fromEntries(this.locks);
      fs.writeFileSync(LOCK_FILE, JSON.stringify(obj));
    } catch (err) {
      log.warn(`[EodLock] Could not persist lock file: ${err.message}`);
    }
  }

  _evictIfExpired(key) {
    const entry = this.locks.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.locks.delete(key);
      this._persist();
      return null;
    }
    return entry || null;
  }

  /**
   * Returns the list of TER_NOs already present in the EOD file for this
   * (CCCODE, MMDDYY), by parsing the header row of EOD{ccode}{mmddyy}.csv.
   * Returns an empty array if no file exists yet.
   */
  getUploadedTerNos(ccode, mmddyy) {
    const filename = `EOD${ccode}${mmddyy}.csv`;
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) return [];
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) return [];
      const fieldMap = {};
      for (const line of lines) {
        const parts = _parseCsvLine(line);
        fieldMap[parts[0]] = parts.slice(1);
      }
      const terRow = fieldMap["TER_NO"];
      if (!terRow) return [];
      return terRow.map((v) => String(v).replace(/"/g, "").padStart(3, "0"));
    } catch (err) {
      log.warn(
        `[EodLock] Could not parse TER_NOs from ${filename}: ${err.message}`,
      );
      return [];
    }
  }

  /**
   * Attempts to claim the EOD lock for (CCCODE, MMDDYY).
   *
   * - No existing active lock → claim and return { acquired: true, startedBy: terNo }.
   * - Existing lock owned by same terNo → idempotent { acquired: true, startedBy: terNo }.
   * - Existing lock owned by different terNo → { acquired: false, startedBy: <leader> }.
   *
   * Note: a non-acquired result is NOT an error. The caller is still allowed
   * to upload its own EOD subset (the bridge merges by TER_NO). The acquired
   * flag just identifies the leader for UI display.
   */
  claim({ ccode, mmddyy, terNo, ttlMs = DEFAULT_TTL_MS }) {
    const key = this._key(ccode, mmddyy);
    const existing = this._evictIfExpired(key);
    const now = Date.now();
    const normalizedTer = String(terNo).padStart(3, "0");

    if (!existing) {
      const entry = {
        startedBy: normalizedTer,
        startedAt: now,
        expiresAt: now + ttlMs,
      };
      this.locks.set(key, entry);
      this._persist();
      return { acquired: true, startedBy: normalizedTer, startedAt: now };
    }

    if (existing.startedBy === normalizedTer) {
      return {
        acquired: true,
        startedBy: existing.startedBy,
        startedAt: existing.startedAt,
      };
    }

    return {
      acquired: false,
      startedBy: existing.startedBy,
      startedAt: existing.startedAt,
    };
  }

  /**
   * Returns the lock + upload state for (CCCODE, MMDDYY) as seen by a
   * specific TER_NO. Used by terminals polling whether they should block.
   */
  status({ ccode, mmddyy, terNo }) {
    const key = this._key(ccode, mmddyy);
    const entry = this._evictIfExpired(key);
    const uploadedTerNos = this.getUploadedTerNos(ccode, mmddyy);
    const normalizedTer = terNo ? String(terNo).padStart(3, "0") : null;

    const inProgress = !!entry || uploadedTerNos.length > 0;
    const selfUploaded = normalizedTer
      ? uploadedTerNos.includes(normalizedTer)
      : false;

    return {
      inProgress,
      startedBy: entry ? entry.startedBy : null,
      startedAt: entry ? entry.startedAt : null,
      uploadedTerNos,
      selfUploaded,
    };
  }

  /**
   * Refreshes the lock TTL after a successful /endOfDay write. Keeps the
   * lock "alive" so polling terminals continue to see EOD as in progress
   * until the natural day rollover.
   */
  refresh({ ccode, mmddyy, ttlMs = DEFAULT_TTL_MS }) {
    const key = this._key(ccode, mmddyy);
    const existing = this.locks.get(key);
    const now = Date.now();
    if (existing) {
      existing.expiresAt = now + ttlMs;
      this._persist();
    }
  }
}

module.exports = new EodLockService();
