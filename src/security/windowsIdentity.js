const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

async function createWindowsIdentity() {
  if (process.platform !== "win32") throw new Error("HTTPS certificate provisioning currently requires Windows.");
  const bridgeId = crypto.randomBytes(16).toString("hex");
  const hostname = "ayala-" + bridgeId + ".invalid";
  const passphrase = crypto.randomBytes(32).toString("hex");
  const { stdout } = await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(fs.readFileSync(path.join(__dirname, "newCertificate.ps1"), "utf8"), "utf16le").toString("base64"),
  ], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, AYALA_CERT_HOST: hostname, AYALA_CERT_PASSWORD: passphrase } });
  const output = JSON.parse(stdout.trim());
  const cert = new crypto.X509Certificate(Buffer.from(output.certificate, "base64"));
  if (!cert.checkHost(hostname) || !cert.verify(cert.publicKey)) throw new Error("Generated certificate identity is invalid.");
  const pin = crypto.createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  return { bridgeId, hostname, pin, certificate: output.certificate, pfx: output.pfx, passphrase, expiresAt: Date.parse(cert.validTo) };
}
module.exports = { createWindowsIdentity };
