// UTAK cloud ACC endpoints (fun/functions/mall/acc). The store is identified
// by ACC_UID and proves itself with ACC_KEY, both set from the tray's
// "Paste ACC setup code".
const BASE =
  process.env.ACC_CLOUD_URL || "https://us-central1-posfire-8d2cb.cloudfunctions.net/";
const TIMEOUT_MS = 60 * 1000;

async function call(fn, { query = {}, body } = {}) {
  const uid = process.env.ACC_UID;
  const key = process.env.ACC_KEY;
  if (!uid || !key) throw new Error("ACC store is not set up (no setup code)");

  const url = new URL(`mall-acc-${fn}`, BASE);
  url.search = new URLSearchParams({ user: uid, ...query }).toString();
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "x-bridge-key": key,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify({ user: uid, ...body }) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`${fn}: HTTP ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

module.exports = {
  pending: () => call("pending"),
  download: (shift, mode = "deliver") => call("download", { query: { shift, mode } }),
  ack: (shift, cc, via) => call("ack", { body: { shift, cc, via } }),
};
