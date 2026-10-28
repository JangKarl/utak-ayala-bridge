const fs = require("fs");
const path = require("path");

const cell = (v) => String(v ?? "").replace(/"/g, "").trim();

/** Field → per-terminal values of one vertical Ayala EOD file. */
function readEod(file) {
  const rows = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [k, ...vals] = line.split(",");
    rows[cell(k)] = vals.map(cell);
  }
  return rows;
}

/**
 * What the window shows per business day and store: is the EOD there, which
 * terminals it holds, and does any terminal with sales that day miss from it.
 * Reads only the pickup folder (the bridge already keeps final files there).
 *
 * @param {{ dir: string, days: string[], ccodes: string[], pending?: Array<{ccode:string, mmddyy:string, pendingTerNos:string[]}>, today?: string }} o
 */
function listAyalaDays({ dir, days, ccodes, pending = [], today = days[0] }) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // Folder missing or unreadable: every day shows as no files.
  }
  const out = [];
  for (const day of days) {
    for (const ccode of ccodes) {
      const hourly = {};
      const re = new RegExp(`^${ccode}${day}(\\d{3})_\\d+\\.csv$`, "i");
      for (const n of names) {
        const m = re.exec(n);
        if (m) hourly[m[1]] = (hourly[m[1]] || 0) + 1;
      }
      const eodName = `EOD${ccode}${day}.csv`;
      let eod = null;
      if (names.includes(eodName)) {
        try {
          eod = readEod(path.join(dir, eodName));
        } catch {
          eod = {};
        }
      }
      const terNos = (eod?.TER_NO || []).map((t) => t.padStart(3, "0"));
      const gross = (eod?.GROSS_SLS || []).reduce((s, v) => s + (Number(v) || 0), 0);
      const missing = Object.keys(hourly).filter((t) => eod && !terNos.includes(t));
      const rp = pending.find((p) => p.ccode === ccode && p.mmddyy === day);

      let status;
      if (rp) status = "resending";
      else if (eod && missing.length) status = "missing";
      else if (eod) status = "closed";
      else if (Object.keys(hourly).length) status = day === today ? "open" : "noeod";
      else status = "nosales";

      out.push({
        day,
        ccode,
        status,
        terNos,
        missing: rp ? rp.pendingTerNos : missing,
        gross: eod ? gross : null,
        hourly,
        eodFile: eod ? eodName : null,
      });
    }
  }
  return out;
}

const num = (v) => Number(v) || 0;

/** One hourly file's transactions: blocks start at each CDATE row. */
function readTxns(file) {
  const txns = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const [k, v] = line.split(",");
    if (k === "CDATE") txns.push({});
    else if (txns.length && ["TRN_TIME", "TRANSACTION_NO", "GROSS_SLS", "SLS_FLAG"].includes(k)) {
      txns[txns.length - 1][k] = cell(v);
    }
  }
  return txns;
}

function hourRow(file, ter, pending) {
  const txns = readTxns(file);
  const nos = txns.map((t) => t.TRANSACTION_NO).filter(Boolean);
  return {
    hour: Number((txns[0]?.TRN_TIME || "").slice(0, 2)) || 0,
    ter,
    txns: txns.length,
    refunds: txns.filter((t) => t.SLS_FLAG === "R").length,
    gross: txns.reduce((s, t) => s + (t.SLS_FLAG === "R" ? 0 : num(t.GROSS_SLS)), 0),
    receipts: nos.length ? [nos[0], nos[nos.length - 1]] : null,
    file: path.basename(file),
    at: pending ? null : fs.statSync(file).mtimeMs,
    pending,
  };
}

/**
 * The trail of one business day: what each terminal sent per hour (and what
 * is still being collected for the current hour), plus the EOD totals.
 */
function ayalaDayDetail({ dir, tempDir, ccode, day }) {
  const hours = [];
  const ls = (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  const re = new RegExp(`^${ccode}${day}(\\d{3})_\\d+\\.csv$`, "i");
  for (const n of ls(dir)) {
    const m = re.exec(n);
    if (m) hours.push(hourRow(path.join(dir, n), m[1], false));
  }
  // Drafts are named by date only, so the CCCODE row says whose they are.
  const draftRe = new RegExp(`^temp_${day.slice(0, 2)}_${day.slice(2, 4)}_${day.slice(4)}_hour_(\\d+)_ter_(\\d{3})\\.csv$`, "i");
  for (const n of ls(tempDir)) {
    const m = draftRe.exec(n);
    if (!m) continue;
    const file = path.join(tempDir, n);
    if (readEod(file).CCCODE?.[0] !== ccode) continue;
    hours.push({ ...hourRow(file, m[2], true), hour: Number(m[1]) });
  }
  hours.sort((a, b) => a.hour - b.hour || a.ter.localeCompare(b.ter));

  const eodFile = path.join(dir, `EOD${ccode}${day}.csv`);
  let eod = null;
  if (fs.existsSync(eodFile)) {
    const rows = readEod(eodFile);
    const terNos = (rows.TER_NO || []).map((t) => t.padStart(3, "0"));
    eod = {
      at: fs.statSync(eodFile).mtimeMs,
      file: path.basename(eodFile),
      terminals: terNos.map((ter, i) => {
        const f = (k) => num(rows[k]?.[i]);
        return {
          ter,
          gross: f("GROSS_SLS"),
          vatable: f("VATABLE_SLS"),
          vat: f("VAT_AMNT"),
          vatExempt: f("VATEXEMPT_SLS"),
          nonVat: f("NONVAT_SLS"),
          discounts: f("DISCOUNTS"),
          serviceCharge: f("SCHRGE_AMT"),
          refunds: f("REFUND_AMT"),
          noRefund: f("NO_REFUND"),
          voids: f("VOID_AMNT"),
          noVoid: f("NO_VOID"),
          receipts: [rows.STRANS?.[i] || "", rows.ETRANS?.[i] || ""],
          oldGrandTotal: f("OLD_GRNTOT"),
          newGrandTotal: f("NEW_GRNTOT"),
        };
      }),
    };
  }
  return { ccode, day, hours, eod };
}

module.exports = { listAyalaDays, ayalaDayDetail };
