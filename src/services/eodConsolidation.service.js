const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const { UPLOADS_DIR } = require("../constants/ayala");

/**
 * Bridge-owned EOD consolidation + grand-total cascade.
 *
 * Ayala validates a PER-TERMINAL running grand total: in EOD{ccode}{mmddyy}.csv
 * each terminal column carries its own OLD_GRNTOT/NEW_GRNTOT, where
 *   NEW_GRNTOT[T] - OLD_GRNTOT[T] = that terminal's net for the day, and
 *   OLD_GRNTOT[T] on a day = that terminal's NEW_GRNTOT on its previous active day.
 * (Confirmed from a live 2-terminal file: TER 001 and TER 002 carry different
 * grand totals in the same file.) EODCTR is store-level/shared, not per-terminal.
 *
 * Therefore reprocessing a past day for a terminal must cascade THAT terminal's
 * chain forward across all of its later days, leaving other terminals untouched.
 * The day's net (NEW-OLD) is invariant for days that weren't reprocessed, so the
 * cascade only shifts OLD/NEW by the upstream delta.
 */

/** Parse a CSV line, respecting double-quoted fields (e.g. MERCHANT_NAME). */
function _parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function _round2(n) {
  return parseFloat((Number(n) || 0).toFixed(2));
}

/** MMDDYY -> sortable YYYYMMDD number (assumes 20YY). */
function _mmddyyToNum(mmddyy) {
  const mm = parseInt(mmddyy.slice(0, 2), 10);
  const dd = parseInt(mmddyy.slice(2, 4), 10);
  const yy = parseInt(mmddyy.slice(4, 6), 10);
  return (2000 + yy) * 10000 + mm * 100 + dd;
}

/**
 * Atomic-ish file replace. POSIX rename is atomic; Windows rename throws if the
 * target exists, so fall back to remove-then-rename. The live EOD file is thus
 * never left half-written.
 */
function atomicWriteFile(targetPath, content) {
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.rmSync(targetPath, { force: true });
    } catch (_) {
      /* ignore */
    }
    fs.renameSync(tmp, targetPath);
  }
}

/**
 * Lists EOD files for a CCCODE, ascending by transaction date.
 * Filename shape: EOD{ccode}{mmddyy}.csv  (mmddyy = last 6 chars of the stem).
 */
function listEodFilesForCcode(ccode, uploadsDir = UPLOADS_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(uploadsDir);
  } catch (err) {
    log.warn(`[Consolidation] Cannot read uploads dir ${uploadsDir}: ${err.message}`);
    return [];
  }
  const prefix = `EOD${ccode}`;
  const out = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".csv")) continue;
    const stem = name.slice(3, -4); // strip "EOD" and ".csv"
    const mmddyy = stem.slice(-6);
    if (!/^\d{6}$/.test(mmddyy)) continue;
    out.push({
      file: name,
      path: path.join(uploadsDir, name),
      mmddyy,
      dateNum: _mmddyyToNum(mmddyy),
    });
  }
  out.sort((a, b) => a.dateNum - b.dateNum);
  return out;
}

/**
 * Reads the TER_NO / OLD_GRNTOT / NEW_GRNTOT rows of an EOD file.
 * Returns { lines, terNos:[3-digit], oldGrn:[float], newGrn:[float] }.
 */
function parseEodColumns(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const rowFor = (key) => {
    const line = lines.find((l) => l.startsWith(`${key},`));
    return line ? _parseCsvLine(line).slice(1) : [];
  };
  const terNos = rowFor("TER_NO").map((v) =>
    String(v).replace(/"/g, "").trim().padStart(3, "0"),
  );
  const oldGrn = rowFor("OLD_GRNTOT").map((v) => _round2(v));
  const newGrn = rowFor("NEW_GRNTOT").map((v) => _round2(v));
  return { content, lines, terNos, oldGrn, newGrn };
}

/**
 * Rewrites a single terminal column's OLD_GRNTOT and NEW_GRNTOT in place,
 * preserving every other line/field byte-for-byte. Writes atomically.
 */
function writeColumnGrnTot(filePath, colIndex, { oldGrntot, newGrntot }) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const patch = (key, value) => {
    const idx = lines.findIndex((l) => l.startsWith(`${key},`));
    if (idx === -1) return;
    const cells = _parseCsvLine(lines[idx]);
    if (colIndex + 1 >= cells.length) return;
    cells[colIndex + 1] = _round2(value).toFixed(2);
    lines[idx] = cells.join(",");
  };
  patch("OLD_GRNTOT", oldGrntot);
  patch("NEW_GRNTOT", newGrntot);
  atomicWriteFile(filePath, lines.join("\n"));
}

/**
 * Rewrites the reprocessed day's own terminal grand-total pair from the prior
 * available EOD file. The uploaded payload only needs to preserve the day net
 * (NEW_GRNTOT - OLD_GRNTOT); the bridge owns the running chain.
 *
 * @returns {{ adjusted: boolean, oldGrntot?: number, newGrntot?: number, net?: number }}
 */
function normalizeTerminalGrandTotal({
  ccode,
  terNo,
  mmddyy,
  uploadsDir = UPLOADS_DIR,
}) {
  const ter = String(terNo).trim().padStart(3, "0");
  const files = listEodFilesForCcode(ccode, uploadsDir);
  const dateNum = _mmddyyToNum(mmddyy);
  const currentFile = files.find((f) => f.mmddyy === mmddyy);

  if (!currentFile) {
    log.warn(
      `[NormalizeGrandTotal] No EOD file for ${ccode} ${mmddyy}; nothing to normalize.`,
    );
    return { adjusted: false };
  }

  const current = parseEodColumns(currentFile.path);
  const currentCol = current.terNos.indexOf(ter);
  if (currentCol === -1) {
    log.warn(
      `[NormalizeGrandTotal] Terminal ${ter} absent in ${currentFile.file}; nothing to normalize.`,
    );
    return { adjusted: false };
  }

  let prevNew = 0;
  const previousFiles = files
    .filter((f) => f.dateNum < dateNum)
    .sort((a, b) => b.dateNum - a.dateNum);

  for (const f of previousFiles) {
    const parsed = parseEodColumns(f.path);
    const col = parsed.terNos.indexOf(ter);
    if (col === -1) continue;
    prevNew = parsed.newGrn[col];
    break;
  }

  const origOld = current.oldGrn[currentCol];
  const origNew = current.newGrn[currentCol];
  const net = _round2(origNew - origOld);
  const newOld = _round2(prevNew);
  const newNew = _round2(prevNew + net);

  if (newOld !== origOld || newNew !== origNew) {
    writeColumnGrnTot(currentFile.path, currentCol, {
      oldGrntot: newOld,
      newGrntot: newNew,
    });
    log.info(
      `[NormalizeGrandTotal] ${ccode} ${mmddyy} TER ${ter}: OLD ${origOld}->${newOld}, NEW ${origNew}->${newNew}`,
    );
    return {
      adjusted: true,
      oldGrntot: newOld,
      newGrntot: newNew,
      net,
    };
  }

  return {
    adjusted: false,
    oldGrntot: newOld,
    newGrntot: newNew,
    net,
  };
}

/**
 * Cascades a terminal's grand-total chain forward across all EOD files dated
 * AFTER `afterMmddyy`. The reprocessed day's own NEW_GRNTOT must already be
 * corrected (by the rebuild) before this runs — it is used as the starting
 * point. Each later day keeps its own net (NEW-OLD, invariant) and only its
 * OLD/NEW shift to stay continuous with the upstream terminal total.
 *
 * Other terminals' columns are never touched.
 *
 * @returns {{ adjusted: Array<{mmddyy,terNo,oldGrntot,newGrntot,net}> }}
 */
function cascadeTerminalForward({
  ccode,
  terNo,
  afterMmddyy,
  uploadsDir = UPLOADS_DIR,
}) {
  const ter = String(terNo).trim().padStart(3, "0");
  const files = listEodFilesForCcode(ccode, uploadsDir);
  const startDateNum = _mmddyyToNum(afterMmddyy);

  const startFile = files.find((f) => f.mmddyy === afterMmddyy);
  if (!startFile) {
    log.warn(
      `[Cascade] No EOD file for ${ccode} ${afterMmddyy}; nothing to cascade.`,
    );
    return { adjusted: [] };
  }
  const start = parseEodColumns(startFile.path);
  const startCol = start.terNos.indexOf(ter);
  if (startCol === -1) {
    log.warn(
      `[Cascade] Terminal ${ter} absent in ${startFile.file}; nothing to cascade.`,
    );
    return { adjusted: [] };
  }

  let prevNew = start.newGrn[startCol];
  const adjusted = [];

  for (const f of files) {
    if (f.dateNum <= startDateNum) continue; // only days after the reprocessed one
    const parsed = parseEodColumns(f.path);
    const col = parsed.terNos.indexOf(ter);
    if (col === -1) continue; // terminal didn't operate this day; chain carries forward

    const origOld = parsed.oldGrn[col];
    const origNew = parsed.newGrn[col];
    const net = _round2(origNew - origOld); // per-terminal day net (invariant)
    const newOld = _round2(prevNew);
    const newNew = _round2(prevNew + net);

    if (newOld !== origOld || newNew !== origNew) {
      writeColumnGrnTot(f.path, col, { oldGrntot: newOld, newGrntot: newNew });
      adjusted.push({
        mmddyy: f.mmddyy,
        terNo: ter,
        oldGrntot: newOld,
        newGrntot: newNew,
        net,
      });
      log.info(
        `[Cascade] ${ccode} ${f.mmddyy} TER ${ter}: OLD ${origOld}->${newOld}, NEW ${origNew}->${newNew}`,
      );
    }
    prevNew = newNew;
  }

  return { adjusted };
}

module.exports = {
  atomicWriteFile,
  listEodFilesForCcode,
  parseEodColumns,
  writeColumnGrnTot,
  normalizeTerminalGrandTotal,
  cascadeTerminalForward,
  _mmddyyToNum,
  _round2,
};
