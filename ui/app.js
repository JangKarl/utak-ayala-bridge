// Renders main.js uiState() and calls its actions through window.bridge.
const $ = (id) => document.getElementById(id);
const call = (action, arg) => window.bridge(action, arg);
let state = null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Ayala names days MMDDYY.
const ayDayLabel = (d) =>
  new Date(2000 + +d.slice(4, 6), +d.slice(0, 2) - 1, +d.slice(2, 4)).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function banner(id, r) {
  const el = $(id);
  if (!r || !r.message) {
    el.hidden = true;
    return;
  }
  el.textContent = r.message;
  el.className = `banner ${r.ok === false ? "bad" : "ok"}`;
  el.hidden = false;
}

function show(view) {
  for (const v of ["v-ayalasetup", "v-ayala"]) $(v).hidden = v !== view;
  $("v-help").hidden = false;
}

function fillIps(select, s) {
  const opts = [`<option value="">Auto-detect (${esc(s.bridgeIp)})</option>`].concat(
    s.ips.map((a) => `<option value="${esc(a.address)}">${esc(a.address)} (${esc(a.name)})</option>`),
  );
  const html = opts.join("");
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  select.value = s.pinnedIp || "";
}

const peso = (n) => `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ters = (list) => list.map((t) => `TER ${t}`).join(", ");

// [chip class, label, what to do]: the hint is written for the cashier.
function ayalaDay(r) {
  const sold = Object.keys(r.hourly);
  switch (r.status) {
    case "closed": return ["ok", "Closed", ""];
    case "missing": return ["bad", "Missing a terminal", `${ters(r.missing)} sold this day but is not in the end-of-day file. On that tablet, run End of Day again for this date.`];
    case "resending": return ["warn", "Re-sending", r.missing.length ? `Waiting for ${ters(r.missing)}. Open the POS on that tablet; it re-sends by itself.` : "Finishing up."];
    case "noeod": return ["bad", "No end of day", `Sales from ${ters(sold)} but no end-of-day file. Close the shift on each POS.`];
    case "open": return ["idle", "Open", "Sales are coming in. The end-of-day file is made when the shift is closed."];
    default: return ["idle", "No sales", ""];
  }
}

function renderAyala(y) {
  const online = y.devices.filter((d) => d.online).length;
  const bad = y.days.filter((r) => r.status === "missing" || r.status === "noeod");
  const health = bad.length ? ["bad", `${bad.length} day${bad.length > 1 ? "s" : ""} need attention`]
    : !y.devices.length ? ["warn", "No tablet connected yet"]
    : online ? ["ok", "Working"] : ["warn", "No tablet online"];
  $("ay-health").className = `chip ${health[0]}`;
  $("ay-health").textContent = health[1];
  banner("ay-alert", bad.length ? { ok: false, message: `${bad.map((r) => ayDayLabel(r.day)).join(", ")}: see the table below for what to do.` } : null);
  const today = y.days.find((r) => r.status !== "nosales" && r.day === y.days[0]?.day);
  $("ay-stats").innerHTML = [
    ["Tablets online", `<span class="chip ${online ? "ok" : y.devices.length ? "warn" : "idle"}">${online} of ${y.devices.length}</span>`],
    ["Today", today ? esc(ayalaDay(today)[1]) : "No sales yet"],
    ["Re-sending", y.reprocessing ? `<span class="chip warn">${y.reprocessing} day${y.reprocessing > 1 ? "s" : ""}</span>` : "None"],
    ["Bridge", `<span class="mono">${esc(state.bridgeIp)}:${esc(state.port)}</span>`],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><div>${v}</div></div>`).join("");

  // Only stores with sales this week count; old test stores stay out of the way.
  const stores = new Set(y.days.filter((r) => r.status !== "nosales").map((r) => r.ccode)).size;
  $("ay-days-head").innerHTML = `<tr><th>Business day</th>${stores > 1 ? "<th>Store</th>" : ""}<th>Status</th><th>Terminals</th><th class="num">Gross sales</th><th></th></tr>`;
  // With several stores, an idle store's empty days are just noise.
  const rows = stores > 1 ? y.days.filter((r) => r.status !== "nosales") : y.days;
  if (!picked || !rows.some((r) => r.day === picked.day && r.ccode === picked.ccode)) {
    const first = rows.find((r) => r.status !== "nosales");
    picked = first ? { day: first.day, ccode: first.ccode } : null;
  }
  $("ay-days").innerHTML = rows.length
    ? rows.map((r) => {
        const [cls, label, hint] = ayalaDay(r);
        const t = r.terNos.length ? ters(r.terNos) : Object.keys(r.hourly).length ? ters(Object.keys(r.hourly)) : "—";
        const on = picked && picked.day === r.day && picked.ccode === r.ccode;
        return `<tr class="${on ? "picked" : ""}"><td class="day">${esc(ayDayLabel(r.day))}</td>${stores > 1 ? `<td class="mono">${esc(r.ccode)}</td>` : ""}
          <td><span class="chip ${cls}">${label}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</td>
          <td>${esc(t)}</td><td class="num">${r.gross == null ? "—" : esc(peso(r.gross))}</td>
          <td class="num">${r.status === "nosales" ? "" : `<button class="view" data-day="${esc(r.day)}" data-ccode="${esc(r.ccode)}" aria-pressed="${on}">${on ? "Viewing" : "View"}</button>`}</td></tr>`;
      }).join("")
    : `<tr><td colspan="${stores > 1 ? 6 : 5}" class="empty">No sales in the last 7 days. Days appear here once a tablet sends a sale.</td></tr>`;

  $("devices").innerHTML = y.devices.length
    ? y.devices.map((d) => `<tr><td><span class="chip ${d.online ? "ok" : "idle"}">${d.online ? "Online" : "Offline"}</span></td>
        <td class="mono">${esc(d.terNo)}</td><td>${esc(d.deviceName)}</td><td>${esc(d.lastSeenAtIso ? when(Date.parse(d.lastSeenAtIso)) : "never")}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No tablet has connected yet. On each POS: Ayala settings → Bridge IP → enter the address above.</td></tr>`;
  $("ay-folder").textContent = y.uploadsDir;
}

let picked = null; // { day, ccode } shown in the trail card

const hourLabel = (h) => {
  const f = (x) => `${x % 12 || 12}${x < 12 || x === 24 ? "am" : "pm"}`;
  return `${f(h)}–${f(h + 1)}`;
};

// One business day's trail: each hourly file sent, then the end-of-day totals.
function renderTrail(d) {
  if (!d) {
    $("ay-trail").hidden = true;
    return;
  }
  $("ay-trail").hidden = false;
  $("trail-title").textContent = `Trail · ${ayDayLabel(d.day)}`;
  const sent = d.hours.filter((h) => !h.pending);
  const txns = d.hours.reduce((s, h) => s + h.txns, 0);
  const refunds = d.hours.reduce((s, h) => s + h.refunds, 0);
  const hourlyGross = d.hours.reduce((s, h) => s + h.gross, 0);
  const eodGross = d.eod ? d.eod.terminals.reduce((s, t) => s + t.gross, 0) : null;
  $("trail-stats").innerHTML = [
    ["Transactions", `${txns}${refunds ? ` <span class="muted">(${refunds} refund${refunds > 1 ? "s" : ""})</span>` : ""}`],
    ["Hourly files sent", `${sent.length}`],
    ["Sales in hourly files", esc(peso(hourlyGross))],
    ["End-of-day gross", eodGross == null ? "Not yet" : esc(peso(eodGross))],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><div>${v}</div></div>`).join("");

  $("trail-hours").innerHTML = d.hours.length
    ? d.hours.map((h) => `<tr><td>${hourLabel(h.hour)}</td><td class="mono">${esc(h.ter)}</td>
        <td class="num">${h.txns}${h.refunds ? ` <span class="muted">· ${h.refunds} R</span>` : ""}</td>
        <td class="mono">${h.receipts ? `${esc(h.receipts[0])}–${esc(h.receipts[1])}` : "—"}</td>
        <td class="num">${esc(peso(h.gross))}</td>
        <td>${h.pending ? `<span class="chip warn">Collecting</span><span class="hint">Sent after the hour ends.</span>` : esc(when(h.at))}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">No hourly files for this day.</td></tr>`;

  if (!d.eod) {
    $("trail-eod").innerHTML = `<p class="empty">No end-of-day file yet. It is made when each POS closes its shift.</p>`;
    return;
  }
  const ts = d.eod.terminals;
  const many = ts.length > 1;
  const sum = (k) => ts.reduce((s, t) => s + t[k], 0);
  const money = (k) => [...ts.map((t) => peso(t[k])), ...(many ? [peso(sum(k))] : [])];
  const counted = (k, n) => [...ts.map((t) => `${peso(t[k])} · ${t[n]}`), ...(many ? [`${peso(sum(k))} · ${sum(n)}`] : [])];
  // Gross always shows; the rest only when some terminal has a value.
  const lines = [
    ["Gross sales", money("gross"), true],
    ["Vatable sales", money("vatable"), sum("vatable")],
    ["VAT", money("vat"), sum("vat")],
    ["VAT-exempt sales", money("vatExempt"), sum("vatExempt")],
    ["Non-VAT sales", money("nonVat"), sum("nonVat")],
    ["Discounts", money("discounts"), sum("discounts")],
    ["Service charge", money("serviceCharge"), sum("serviceCharge")],
    ["Refunds · count", counted("refunds", "noRefund"), sum("refunds") || sum("noRefund")],
    ["Voids · count", counted("voids", "noVoid"), sum("voids") || sum("noVoid")],
    ["Receipts", [...ts.map((t) => `${t.receipts[0]}–${t.receipts[1]}`), ...(many ? [""] : [])], true],
    ["Grand total", [...ts.map((t) => `${peso(t.oldGrandTotal)} → ${peso(t.newGrandTotal)}`), ...(many ? [""] : [])], true],
  ].filter((l) => l[2]);
  $("trail-eod").innerHTML = `<p class="muted">File made ${esc(when(d.eod.at))} · <span class="mono">${esc(d.eod.file)}</span></p>
    <div class="tablebox"><table><thead><tr><th></th>${ts.map((t) => `<th class="num">TER ${esc(t.ter)}</th>`).join("")}${many ? `<th class="num">Total</th>` : ""}</tr></thead>
    <tbody>${lines.map(([k, vals]) => `<tr><th scope="row">${k}</th>${vals.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// Setup screen: turns green the moment a tablet reaches this laptop.
function renderAyalaFirst(y) {
  const on = y.devices.find((d) => d.online);
  $("ay-first").className = `chip ${on ? "ok" : y.devices.length ? "warn" : "idle"}`;
  $("ay-first").textContent = on ? `TER ${on.terNo} connected` : y.devices.length ? "Tablet seen, now offline" : "Waiting for a tablet…";
  $("ay-first-hint").textContent = on ? "You can finish setup." : "Save the address on a POS and this updates by itself.";
}

function render(s) {
  state = s;
  $("hdr").textContent = `v${s.version}${s.beta ? " beta" : ""}${s.updateReady ? ` · update v${s.updateReady} ready` : ""}`;
  $("foot").textContent = `Bridge running on ${s.bridgeIp}:${s.port}`;
  const addr = `${s.bridgeIp}:${s.port}`;
  $("ay-addr").textContent = addr;
  $("ay-addr2").textContent = addr;
  fillIps($("ip-setup"), s);
  fillIps($("ip-status"), s);
  document.querySelectorAll(".theme button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.theme === s.theme));

  if (s.welcome) {
    renderAyalaFirst(s.ayala);
    return show("v-ayalasetup");
  }
  renderAyala(s.ayala);
  show("v-ayala");
}

const refresh = async () => {
  render(await call("state"));
  if (!$("v-ayala").hidden) renderTrail(picked && (await call("dayDetail", picked)));
};

// Actions
$("btn-ay-done").addEventListener("click", async () => {
  await call("finishSetup");
  refresh();
});

$("btn-open-ay").addEventListener("click", () => call("openFolder"));
document.querySelectorAll(".theme button").forEach((b) =>
  b.addEventListener("click", async () => {
    await call("setTheme", b.dataset.theme);
    refresh();
  }),
);
$("ay-days").addEventListener("click", (e) => {
  const b = e.target.closest("button.view");
  if (!b) return;
  picked = { day: b.dataset.day, ccode: b.dataset.ccode };
  refresh().then(() => $("ay-trail").scrollIntoView({ behavior: "smooth", block: "start" }));
});
$("btn-folder-ay").addEventListener("click", async () => banner("ay-folder-msg", await call("chooseFolder")));
for (const id of ["btn-copy", "btn-copy2"]) {
  $(id).addEventListener("click", async () => {
    await call("copyAddress");
    $(id).textContent = "Copied ✓";
    setTimeout(() => ($(id).textContent = "Copy"), 1500);
  });
}
$("btn-logs").addEventListener("click", () => call("openLogs"));
for (const id of ["btn-pair", "btn-pair2"]) $(id).addEventListener("click", () => call("pair"));
$("btn-fix").addEventListener("click", () => call("fixConnection"));
for (const id of ["ip-setup", "ip-status"]) {
  $(id).addEventListener("change", async (e) => {
    await call("setBridgeIp", e.target.value);
    refresh();
  });
}

refresh();
setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 4000);
