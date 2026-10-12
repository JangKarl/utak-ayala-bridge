const { validationResult } = require("express-validator");
const log = require("electron-log");
const { accSender } = require("../services/accSender.service");
const { version: BRIDGE_VERSION } = require("../../package.json");

const invalid = (req, res) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ errors: errors.array() });
  return true;
};

const accController = {
  getStatus(req, res) {
    res.json({
      status: "Server is running",
      bridge: "ayala-bridge",
      mall: "acc",
      version: BRIDGE_VERSION,
      acc: accSender().status(),
    });
  },

  handleTransactions(req, res) {
    if (invalid(req, res)) return;
    try {
      const { store } = accSender();
      for (const { key, val } of req.body.txns) store.putTxn(key, val);
      res.json({ ok: true, saved: req.body.txns.length });
    } catch (err) {
      log.error(`[ACC] transaction save failed: ${err.message}`);
      res.status(500).json({ error: "Could not save transaction" });
    }
  },

  handleClose(req, res) {
    if (invalid(req, res)) return;
    try {
      const { shiftKey, terminal, count, lastReceiptNo = null } = req.body;
      accSender().store.recordClose(shiftKey, String(terminal), {
        count: Number(count),
        lastReceiptNo,
      });
      log.info(`[ACC] close ${shiftKey} terminal ${terminal} (${count} sales)`);
      res.json({ ok: true });
      accSender().sync().catch((err) => log.error(`[ACC] sync: ${err.message}`));
    } catch (err) {
      log.error(`[ACC] close failed: ${err.message}`);
      res.status(500).json({ error: "Could not record close" });
    }
  },
};

module.exports = accController;
