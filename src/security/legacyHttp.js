const http = require("node:http");
const express = require("express");
const cors = require("cors");

const LEGACY_HTTP_PORT = 3800;

// Migration window only: the pre-HTTPS, unauthenticated API (as shipped up to
// v2.52.12) for POS builds that cannot pair yet. Turned off per store from the tray.
function startLegacyHttp(routes, port = LEGACY_HTTP_PORT) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/", routes);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

module.exports = { startLegacyHttp, LEGACY_HTTP_PORT };
