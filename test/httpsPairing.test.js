const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BridgeSecurity, pairingProof } = require("../src/security/bridgeSecurity");
const identity = { bridgeId: "a".repeat(32), hostname: "ayala-" + "a".repeat(32) + ".invalid", pin: "b".repeat(64), pfx: "fixture", passphrase: "fixture", expiresAt: Date.now() + 86400000 };
const vault = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ayala-https-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "secure-state");
  return { file, security: await BridgeSecurity.open({ file, storage: vault, createIdentity: async () => identity }) };
}
const device = { ccode: "9999001", uid: "user1", deviceId: "device1", deviceName: "POS" };
test("invitation is local, store-bound, single-use and credentials survive restart/revocation", async t => {
  const { security, file } = await setup(t);
  const invite = security.invite("9999001", "192.168.1.6");
  assert.throws(() => security.pair({ ...device, ccode: "other", secret: invite.secret }), /store/i);
  const result = security.pair({ ...device, secret: invite.secret });
  assert.throws(() => security.pair({ ...device, secret: invite.secret }), /invitation/i);
  assert.equal(security.authenticate(result.token).uid, "user1");
  assert.ok(!fs.readFileSync(file, "utf8").includes(result.token));
  const restarted = await BridgeSecurity.open({ file, storage: vault, createIdentity: () => { throw Error("must not replace identity"); } });
  assert.equal(restarted.authenticate(result.token).deviceId, "device1");
  restarted.revoke(result.credentialId);
  assert.throws(() => restarted.authenticate(result.token), /credential/i);
});
test("expiry, cancellation, corrupt state and failed persistence fail closed", async t => {
  const { security, file } = await setup(t);
  const invite = security.invite("9999001", "192.168.1.6");
  security.invitation.expiresAt = 0;
  assert.throws(() => security.pair({ ...device, secret: invite.secret }), /invitation/i);
  const cancelled = security.invite("9999001", "192.168.1.6");
  security.cancelInvitation();
  assert.throws(() => security.pair({ ...device, secret: cancelled.secret }), /invitation/i);
  fs.writeFileSync(file, "corrupt");
  await assert.rejects(BridgeSecurity.open({ file, storage: vault, createIdentity: async () => identity }));
});
test("authorization rejects cross-store and cross-device data, including nested CSV records", async t => {
  const { security } = await setup(t);
  const invite = security.invite("9999001", "192.168.1.6");
  const { token } = security.pair({ ...device, secret: invite.secret });
  const grant = security.authenticate(token);
  assert.doesNotThrow(() => security.validateScope(grant, { data: [{ CCCODE: device.ccode }] }));
  for (const payload of [{ ccode: "other" }, { uid: "other" }, { device_id: "other" }, { data: [{ CCCODE: "other" }] }, { data: { CCCODE: "other" } }]) {
    assert.throws(() => security.validateScope(grant, payload), /scope/i);
  }
  assert.throws(() => security.authenticate("not-a-token"), /credential/i);
});


test("HTTPS pairing and authenticated routes work with a real Windows certificate", { skip: process.platform !== "win32" }, async t => {
  const https = require("node:https");
  const crypto = require("node:crypto");
  const express = require("express");
  const { createWindowsIdentity } = require("../src/security/windowsIdentity");
  const { createSecureApp } = require("../src/security/secureApp");
  const realIdentity = await createWindowsIdentity();
  const cert = new crypto.X509Certificate(Buffer.from(realIdentity.certificate, "base64"));
  assert.equal(cert.checkHost(realIdentity.hostname), realIdentity.hostname);
  assert.equal(cert.checkHost("wrong.invalid"), undefined);
  assert.equal(crypto.createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex"), realIdentity.pin);
  const { security } = await setup(t);
  security.save({ version: 1, identity: realIdentity, credentials: [] });
  const routes = express.Router();
  routes.get("/heartbeat", (req, res) => res.json({ status: "alive", identity: req.query }));
  routes.post("/transaction", (req, res) => res.json(req.body));
  const server = https.createServer(security.tlsOptions(), createSecureApp(security, routes));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, { token, body, hostname = realIdentity.hostname, origin } = {}) => new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (origin) headers.Origin = origin;
    const req = https.request({
      host: "127.0.0.1", port: server.address().port, servername: hostname,
      ca: cert.toString(), path, method: body === undefined ? "GET" : "POST", headers,
    }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  await assert.rejects(request("/heartbeat", { hostname: "wrong.invalid" }), /hostname|altnames/i);
  assert.equal((await request("/heartbeat")).status, 401);
  const invitation = security.invite(device.ccode, "127.0.0.1");
  const paired = await request("/pair", { body: { ...device, secret: invitation.secret } });
  assert.equal(paired.status, 200);
  const token = paired.data.token;
  assert.equal((await request("/pair", { body: { ...device, secret: invitation.secret } })).status, 403);
  const heartbeat = await request("/heartbeat", { token });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.data.identity.uid, device.uid);
  assert.equal((await request("/heartbeat?ccode=other", { token })).status, 403);
  assert.equal((await request("/heartbeat", { token, origin: "https://example.com" })).status, 403);
  assert.equal((await request("/transaction", { token, body: { data: { CCCODE: "other" } } })).status, 403);
  const accepted = await request("/transaction", { token, body: { data: { CCCODE: device.ccode } } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.device_id, device.deviceId);
  security.revoke(paired.data.credentialId);
  assert.equal((await request("/heartbeat", { token })).status, 401);
  const typedInvite = security.invite(device.ccode, "127.0.0.1");
  const nonce = "c".repeat(32);
  const keys = pairingProof(typedInvite.code.replace("-", ""), realIdentity.pin, device.ccode, nonce);
  const typed = await request("/pair", { body: { ...device, nonce, proof: keys.proof } });
  assert.equal(typed.status, 200);
  assert.equal(typed.data.confirm, keys.confirm);
  assert.equal((await request("/heartbeat", { token: typed.data.token })).status, 200);
});

test("failed secure storage writes do not issue credentials or consume an invitation", async t => {
  const { security } = await setup(t);
  const invitation = security.invite(device.ccode, "192.168.1.6");
  security.storage = { ...vault, encryptString: () => { throw new Error("disk unavailable"); } };
  assert.throws(() => security.pair({ ...device, secret: invitation.secret }), /disk unavailable/);
  assert.equal(security.devices().length, 0);
  assert.equal(security.invitation.secret, invitation.secret);
});

// Reference vectors computed independently (Python hashlib); AyalaBridgeTlsTest uses the same ones.
test("pairing proof and confirmation are HMACs of a PBKDF2 key bound to the pin, store and nonce", () => {
  assert.deepEqual(pairingProof("K7PM2X", "b".repeat(64), "9999001", "0".repeat(32)), {
    proof: "e4795f631b1c0b6cca0e862da928f7d78b0484c0447309998fd9f0b32050cf78",
    confirm: "33a7c264656c361cfabe36ee0bfd41f11e51c5b7342898a7c900c43d84fe7867",
  });
  assert.deepEqual(pairingProof("000000", "b".repeat(64), "99990000000000001", "f".repeat(32)), {
    proof: "196354230e616195cdb1bf02296021e8ddefeaa340a492d82db5bee349eb6a17",
    confirm: "1083825390e173cd0a908ae49f15bb0a0a4fc61de18abeab944de7372f1f07dc",
  });
});

const typedPair = (security, code, { pin = identity.pin, nonce = "0".repeat(32) } = {}) =>
  security.pair({ ...device, nonce, proof: pairingProof(code.replace("-", ""), pin, device.ccode, nonce).proof });

test("typed pairing code is six Crockford characters and single-use", async t => {
  const { security } = await setup(t);
  const { code } = security.invite(device.ccode, "192.168.1.6");
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
  const result = typedPair(security, code);
  assert.equal(security.authenticate(result.token).deviceId, device.deviceId);
  // The bridge proves it knows the code too, so a fake bridge cannot complete pairing.
  assert.equal(result.confirm, pairingProof(code.replace("-", ""), identity.pin, device.ccode, "0".repeat(32)).confirm);
  assert.throws(() => typedPair(security, code), /invitation/i);
});

test("a proof made against another certificate (fake bridge) is rejected", async t => {
  const { security } = await setup(t);
  const { code } = security.invite(device.ccode, "192.168.1.6");
  assert.throws(() => typedPair(security, code, { pin: "e".repeat(64) }), /invitation/i);
  assert.equal(security.devices().length, 0);
});

test("wrong typed codes cancel the invitation after five attempts", async t => {
  const { security } = await setup(t);
  const { code } = security.invite(device.ccode, "192.168.1.6");
  const wrong = code === "000-000" ? "111-111" : "000-000";
  for (let i = 0; i < 5; i++) assert.throws(() => typedPair(security, wrong), /invitation/i);
  assert.throws(() => typedPair(security, code), /invitation/i);
  assert.equal(security.devices().length, 0);
});
