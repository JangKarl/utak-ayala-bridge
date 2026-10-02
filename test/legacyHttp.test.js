const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { startLegacyHttp } = require("../src/security/legacyHttp");

const get = port => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: "/heartbeat", agent: false }, res => {
    let data = "";
    res.on("data", chunk => { data += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
  }).on("error", reject);
});

// Migration window: POS builds without HTTPS pairing keep the old, unauthenticated API.
test("legacy HTTP serves the existing routes without pairing until it is stopped", async () => {
  const routes = express.Router();
  routes.get("/heartbeat", (req, res) => res.json({ status: "alive" }));
  const server = await startLegacyHttp(routes, 0);
  const { port } = server.address();
  const reply = await get(port);
  assert.equal(reply.status, 200);
  assert.equal(reply.data.status, "alive");
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(get(port), /ECONNREFUSED/);
});
