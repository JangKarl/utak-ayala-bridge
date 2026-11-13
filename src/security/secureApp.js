const express = require("express");
const log = require("electron-log");

function createSecureApp(security, routes) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.headers.origin) return res.status(403).json({ error: "Use a paired POS device." });
    next();
  });
  app.post("/pair", express.json({ limit: "4kb" }), (req, res, next) => {
    try { res.json(security.pair(req.body || {})); } catch (e) { next(e); }
  });
  // Authenticate before parsing potentially large uploads.
  app.use((req, res, next) => {
    try {
      req.bridgeGrant = security.authenticate((req.headers.authorization || "").replace(/^Bearer /, ""));
      next();
    } catch (e) { next(e); }
  });
  app.use(express.json({ limit: "5mb" }));
  app.use((req, res, next) => {
    try {
      security.validateScope(req.bridgeGrant, req.query);
      if (req.body !== undefined) security.validateScope(req.bridgeGrant, req.body);
      const grant = req.bridgeGrant;
      const identity = { ccode: grant.ccode, uid: grant.uid, device_id: grant.deviceId, device_name: grant.deviceName };
      // Express 5 req.query is a getter; install a request-local sanitized value.
      Object.defineProperty(req, "query", { value: { ...req.query, ...identity }, configurable: true });
      req.body = { ...req.body, ...identity };
      next();
    } catch (e) { next(e); }
  });
  app.use("/", routes);
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error("[SecureApp] " + req.method + " " + req.path + " failed:", err);
    else if (status === 403) log.warn("[SecureApp] " + req.method + " " + req.path + " rejected: " + err.message);
    res.status(status).json({ error: status === 500 ? "Secure bridge request failed." : err.message });
  });
  return app;
}
module.exports = { createSecureApp };
