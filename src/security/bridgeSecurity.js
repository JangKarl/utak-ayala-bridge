const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isIPv4 } = require("node:net");
const log = require("electron-log");
const { createWindowsIdentity } = require("./windowsIdentity");

const { PORT: HTTPS_PORT } = require("../constants/ayala");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const MAX_PAIRING_ATTEMPTS = 5;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PROOF_ITERATIONS = 600000;
// Slow key from the typed code, bound to the certificate the POS saw. The POS sends `proof`;
// the bridge answers with `confirm`. A fake bridge gets a proof for its own pin: useless here,
// and forging `confirm` means cracking 2^30 slow hashes before the POS times out.
function pairingProof(code, pin, ccode, nonce) {
  const key = crypto.pbkdf2Sync(code, "ayala-pair-v1|" + pin + "|" + ccode + "|" + nonce, PROOF_ITERATIONS, 32, "sha256");
  const mac = label => crypto.createHmac("sha256", key).update(label).digest("hex");
  return { proof: mac("pos"), confirm: mac("bridge") };
}
function fail(message, status = 403) { throw Object.assign(new Error(message), { status }); }
function text(value, name, pattern, max = 128) {
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) fail("Invalid " + name, 400);
  return value;
}

class BridgeSecurity {
  static async open({ file, storage, createIdentity = createWindowsIdentity }) {
    if (!storage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable; HTTPS startup stopped.");
    const instance = new BridgeSecurity(file, storage);
    instance.createIdentity = createIdentity;
    if (fs.existsSync(file)) {
      instance.state = JSON.parse(storage.decryptString(fs.readFileSync(file)));
      const s = instance.state;
      if (s.version !== 1 || !/^[a-f0-9]{32}$/.test(s.identity?.bridgeId) ||
          s.identity.hostname !== "ayala-" + s.identity.bridgeId + ".invalid" ||
          !/^[a-f0-9]{64}$/.test(s.identity.pin) || !s.identity.pfx ||
          !s.identity.passphrase || !Number.isFinite(s.identity.expiresAt) ||
          !Array.isArray(s.credentials) || s.credentials.some(c => !c || !/^[a-f0-9]{64}$/.test(c.tokenHash) ||
            typeof c.id !== "string" || typeof c.uid !== "string" || typeof c.deviceId !== "string" ||
            typeof c.deviceName !== "string" || typeof c.ccode !== "string" || !Number.isFinite(c.pairedAt))) throw new Error("Invalid secure bridge state; restore it instead of silently replacing its identity.");
    } else {
      instance.save({ version: 1, identity: await createIdentity(), credentials: [] });
      log.info("[Security] Created new bridge identity " + instance.state.identity.bridgeId);
    }
    return instance;
  }
  constructor(file, storage) { this.file = file; this.storage = storage; this.invitation = null; }
  save(next) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, this.storage.encryptString(JSON.stringify(next)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.state = next; // Never authorize changes that did not reach disk.
  }
  tlsOptions() {
    return { pfx: Buffer.from(this.state.identity.pfx, "base64"), passphrase: this.state.identity.passphrase, minVersion: "TLSv1.2" };
  }
  invite(ccode, ip) {
    text(ccode, "store code", /^[A-Za-z0-9]+$/, 40);
    if (!isIPv4(ip)) fail("Choose a valid bridge IPv4 address", 400);
    if (this.state.identity.expiresAt <= Date.now()) fail("Bridge certificate expired. Renew locally and pair devices again.", 409);
    const secret = crypto.randomBytes(32).toString("hex");
    const shortCode = Array.from({ length: 6 }, () => CROCKFORD[crypto.randomInt(32)]).join("");
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.invitation = { ccode, secret, shortCode, expiresAt, failures: 0 };
    const { bridgeId, hostname, pin } = this.state.identity;
    const code = shortCode.slice(0, 3) + "-" + shortCode.slice(3);
    return { version: 1, bridgeId, hostname, pin, ip, port: HTTPS_PORT, ccode, secret, expiresAt, code };
  }
  cancelInvitation() { this.invitation = null; }
  pair(body) {
    const i = this.invitation;
    const typed = typeof body.ccode === "string" && /^[a-f0-9]{32}$/.test(body.nonce) && /^[a-f0-9]{64}$/.test(body.proof);
    // ponytail: sync PBKDF2 blocks ~0.3s per attempt; capped at five per invitation.
    const keys = i && typed ? pairingProof(i.shortCode, this.state.identity.pin, body.ccode, body.nonce) : null;
    const valid = i && i.expiresAt > Date.now() && (typeof body.secret === "string" ? same(body.secret, i.secret)
      : !!keys && same(body.proof, keys.proof));
    if (!valid) {
      if (i && ++i.failures >= MAX_PAIRING_ATTEMPTS) this.cancelInvitation();
      log.warn("[Pair] Rejected " + (typed ? "typed code" : "QR") + " pairing attempt" + (i ? " (" + i.failures + "/" + MAX_PAIRING_ATTEMPTS + ")" : " (no open invitation)"));
      fail("Pairing invitation is invalid or expired.");
    }
    if (body.ccode !== i.ccode) fail("Pairing store does not match the invitation.");
    text(body.uid, "account", /^[A-Za-z0-9_-]+$/);
    text(body.deviceId, "device", /^[A-Za-z0-9:._-]+$/, 256);
    text(body.deviceName, "device name", /^[^\x00-\x1f]+$/, 128);
    const token = crypto.randomBytes(32).toString("hex");
    const grant = { id: crypto.randomUUID(), tokenHash: hash(token), ccode: i.ccode,
      uid: body.uid, deviceId: body.deviceId, deviceName: body.deviceName, pairedAt: Date.now() };
    const credentials = this.state.credentials.filter(c => !(c.uid === grant.uid && c.deviceId === grant.deviceId && c.ccode === grant.ccode));
    this.save({ ...this.state, credentials: [...credentials, grant] });
    this.cancelInvitation();
    log.info("[Pair] Paired " + grant.deviceName + " (" + grant.deviceId + ") ccode=" + grant.ccode + " uid=" + grant.uid + " via " + (keys ? "typed code" : "QR"));
    return { token, credentialId: grant.id, bridgeId: this.state.identity.bridgeId, ccode: grant.ccode,
      ...(keys && { confirm: keys.confirm }) };
  }
  authenticate(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) fail("Bridge credential required.", 401);
    const digest = hash(token);
    const grant = this.state.credentials.find(c => c.tokenHash === digest);
    if (!grant) {
      // Log once per credential: a revoked POS keeps retrying every 15s.
      if (this.lastRejected !== digest) log.warn("[Auth] Rejected unknown or revoked bridge credential");
      this.lastRejected = digest;
      fail("Bridge credential revoked or unknown. Pair this POS again.", 401);
    }
    return grant;
  }
  validateScope(grant, src) {
    if (!src || typeof src !== "object" || Array.isArray(src)) fail("Invalid request scope.", 400);
    for (const [field, expected] of [["ccode", grant.ccode], ["uid", grant.uid], ["device_id", grant.deviceId]]) {
      if (src[field] !== undefined && src[field] !== expected) fail("Request outside paired device/store scope.");
    }
    if (src.data !== undefined) {
      const records = Array.isArray(src.data) ? src.data : [src.data];
      if (records.some(row => !row || typeof row !== "object" || Array.isArray(row) || row.CCCODE !== grant.ccode)) {
        fail("CSV data outside paired store scope.");
      }
    }
  }
  devices() {
    return this.state.credentials.map(({ tokenHash, ...info }) => info);
  }
  async renew() {
    const identity = await this.createIdentity();
    this.save({ version: 1, identity, credentials: [] });
    this.cancelInvitation();
    log.warn("[Security] Certificate renewed; all POS pairings removed. New bridge " + identity.bridgeId);
  }
  revoke(id) {
    const device = this.state.credentials.find(c => c.id === id);
    if (device) log.warn("[Pair] Revoked " + device.deviceName + " (" + device.deviceId + ") ccode=" + device.ccode);
    this.save({ ...this.state, credentials: this.state.credentials.filter(c => c.id !== id) });
  }
}
module.exports = { BridgeSecurity, HTTPS_PORT, pairingProof };

