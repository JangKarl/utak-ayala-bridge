# Ayala Bridge — Project Guide

> Companion doc for AI agents and new contributors. Authoritative current
> reference. (An older `.github/copilot-instructions.md` exists but is partly
> stale — e.g. it says port 3000; the real default is **3800**. Prefer this file.)

## What This Is

A Windows desktop service that sits between Utak POS devices (the React Native
app `utakmobile24`, mall mode `ayala`) and Ayala's mall reporting system. POS
devices push transaction / end-of-day data over HTTP on the local network; the
bridge generates Ayala-compliant CSV text files into the mall's pickup folder
and coordinates **multiple terminals that share one store** so their
consolidated reports stay correct.

It ships as a **system-tray Electron app** with an embedded **Express API
server**, auto-starts on boot, and **auto-updates over the air** from a private
GitHub repo.

- **Live repo / OTA target:** `JangKarl/utak-ayala-bridge` (electron-updater).
- **Default port:** `3800` (override with `PORT` in `.env`).
- **Client:** `utakmobile24` → `src/mall/ayala/_shared/...` (helpers + `BridgeMonitorService`).

## Run / Build

```bash
npm install
npm run dev      # Express server only, headless (require('./bridge').startServer())
npm start        # Full Electron app + system tray
npm run build    # Windows NSIS installer -> dist/
npm run publish  # build + publish a release to GitHub (drives OTA auto-update)
```

There is **no test suite** (`npm test` is a stub). Verify changes by running
`npm run dev` and exercising the HTTP endpoints.

**Releasing an update:** bump `version` in `package.json`, then `npm run publish`
(requires `GH_TOKEN` with `repo` scope in `.env`). Installed clients download in
the background and install on next quit (`autoInstallOnAppQuit`).

**Build gotcha:** `assets/icon.ico` must contain a 256×256 layer or the NSIS
build fails.

## Architecture

Two cooperating layers, intentionally separable:

| Layer | File | Responsibility |
|---|---|---|
| Electron shell | [main.js](main.js) | System tray, device list menu, IP watcher, directory picker, auto-updater, single-instance lock |
| HTTP server | [bridge.js](bridge.js) | Express app, mounts routes, starts cron jobs + time watcher |

`bridge.js` exports `startServer()` so the server runs standalone in dev without
Electron. `main.js` loads `.env` (resolved relative to the executable when
packaged — CWD is unreliable under auto-start) and persisted `config.json` from
the Electron `userData` dir before requiring `bridge.js`.

### MVC layout under `src/`

```
src/
├── constants/ayala.js              # Field arrays (SOURCE OF TRUTH), PORT, dir paths
├── routes/ayala.routes.js          # Express routes + express-validator rules
├── controllers/ayala.controller.js # HTTP: validate → log → call service → respond
├── services/
│   ├── ayala.service.js            # CSV generation: EOD, per-transaction, hourly temp finalize, reprocess staging
│   ├── eodLock.service.js          # Cross-terminal EOD lock (one per ccode+day)
│   ├── terminalRegistry.service.js # Store-wide-unique TER_NO ownership + device presence
│   ├── reprocessState.service.js   # Which days/terminals are mid-reprocess
│   └── eodConsolidation.service.js # Per-terminal grand-total normalize + forward cascade, atomic file writes
├── jobs/
│   ├── ayala.job.js                # Hourly draft finalize cron + reprocess-finalize sweep cron
│   └── timeWatcher.js              # Detects manual system-clock changes, restarts cron
└── utils/index.js                  # getLocalIPAddress, formatValue
```

**Rule:** controllers do HTTP/validation/logging; services hold logic and have
**no Express dependency** (they must be callable from cron jobs too). All
services are **singletons** (`module.exports = new X()`).

## Storage & State (no database — files are the source of truth)

| Path | What |
|---|---|
| `C:\AYALA\tenant_api\storage\app\OUTGOING` | **`UPLOADS_DIR`** — the mall pickup folder. Only ever holds *final* CSV files. Overridable via tray "Select Directory" (persists `uploadsDir` → `UPLOADS_DIR`). |
| `C:\UTAK\Temp` | **`TEMP_DIR`** — hourly draft temp files + the JSON state mirrors below. |
| `C:\UTAK\Temp\.staging` | **`STAGING_DIR`** — in-progress reprocess rebuild (`EOD…` staging file + backed-up per-transaction files). Under TEMP so the mall never sees partial rebuilds. |
| `…\TEMP_DIR\terminal_registry.json` | TER_NO → owner device map, per ccode. |
| `…\TEMP_DIR\eod_locks.json` | Active EOD locks (TTL-mirrored). |
| `…\TEMP_DIR\reprocess_state.json` | Pending reprocesses (TTL-mirrored). |

Each stateful service keeps an in-memory structure mirrored to its JSON file:
**hydrate on construct, persist on mutate, evict on TTL**. A bridge restart
therefore preserves locks / ownership / pending reprocesses within their window.

## CSV File Format (unique to Ayala)

**Vertical** `FIELD,VALUE` rows (not columnar). One **column per terminal** in
consolidated files:

```csv
CCCODE,84106000000001070
MERCHANT_NAME,MAMONAKU KOHI
TER_NO,001,002
TRN_DATE,2026-02-01
GROSS_SLS,6000.00,4200.00
OLD_GRNTOT,12000.00,8000.00
NEW_GRNTOT,18000.00,12200.00
```

**Field arrays in [src/constants/ayala.js](src/constants/ayala.js) are the source
of truth:** `FILE_HEADER_FIELDS`, `TRANSACTION_FIELDS`, `ITEM_FIELDS`,
`EOD_FIELDS`. When adding a field, update the array first, then handle its
formatting in `formatValue()` ([src/utils/index.js](src/utils/index.js)).

**Formatting rules** (`formatValue`): money fields → 2 decimals (`.00`);
`QTY`/`QTY_SLD` → 3 decimals (`.000`); `STRANS`/`ETRANS` → zero-padded 8;
`TER_NO` → zero-padded 3 (in filenames and columns).

**File naming:**
- EOD (consolidated): `EOD{ccode}{mmddyy}.csv`
- Per-transaction: `{ccode}{mmddyy}{ter}_{lastTrnNo}.csv`
- Hourly draft (temp): `temp_{MM}_{DD}_{YY}_hour_{H}_ter_{TER}.csv`

`mmddyy` / the date in filenames is the **business date** sent by the POS, which
can differ from the server's calendar date (after-midnight sales still belong to
the previous shift). The hourly cron matches on **hour only** for this reason.

## HTTP API

All POST bodies are JSON. `ccode` = `tenantCode + contractNumber`. `ter_no` is
normalized to 3 digits server-side.

| Method | Route | Purpose |
|---|---|---|
| GET | `/status`, `/getStatus` | Health + registered devices |
| GET | `/devices?ccode=` | Devices with online state + last-seen |
| POST | `/endOfDay` | Generate consolidated EOD from `{ data: Daily \| Daily[] }`. Reprocess-aware (see below). |
| POST | `/checkPreviousEOD` | `{ ccode, mmddyy }` → does an EOD file exist |
| POST | `/transaction` | Append one txn `{ data: {…TRANSACTION_FIELDS, items[]} }` to the hourly draft |
| POST | `/hourly` | Append a batch `{ date, hour, data: [] }` to the hourly draft |
| GET | `/heartbeat?ccode&ter_no&device_id&device_name` | Connectivity check; updates device presence |
| POST | `/eod/start` | Claim the cross-terminal EOD lock `{ ccode, mmddyy, ter_no, device_id?, uid? }` |
| GET | `/eod/status?ccode&mmddyy&ter_no&device_id&uid` | Lock + upload + reprocess state for this terminal. **Omit `mmddyy`** → `{ reprocessPending: [...] }` filtered to this terminal's pending days |
| POST | `/eod/reprocess` | Raise a cross-terminal reprocess `{ ccode, mmddyy, ter_no?, device_id? }` |
| POST | `/terminal/register` | Claim a store-wide-unique TER_NO `{ ccode, ter_no, device_id, uid?, device_name?, force? }`. **409** on cross-device conflict |
| GET | `/terminal/check?ccode&ter_no&device_id` | Read-only availability (no mutation) |

## Multi-Terminal Coordination (the heart of this service)

A **store = one CCCODE**. Several POS devices — possibly on **different Utak
accounts (UIDs)** — can share it. The bridge is the *only* component that sees
all of them, so it owns coordination that Firebase can't do across UIDs.

The consolidated EOD file has **one column per TER_NO**. Three subsystems keep
that file coherent:

### 1. Terminal registry — unique TER_NO ([terminalRegistry.service.js](src/services/terminalRegistry.service.js))
Duplicate TER_NO is catastrophic: a second device's `/endOfDay` would overwrite
the first terminal's column → silent sales loss. `register()` **hard-rejects
(409)** when a *different* `device_id` already owns a TER_NO for the ccode;
idempotent for the same device. A device re-registering releases its old TER_NO.
- `force:true` is an **explicit, human-confirmed takeover** (POS setup modal
  only) for reinstall recovery, where a device's id regenerates. Silent backfill
  paths (`/heartbeat`, `/eod/*`) never pass `force`, so they can't steal a number.
- `/heartbeat` + `/eod/status` also `touch()` the registry → drives the tray's
  online/offline device list (60s online window).

### 2. EOD lock ([eodLock.service.js](src/services/eodLock.service.js))
One lock per `(ccode, mmddyy)`. The first terminal is the "leader"; **a
non-leader is still allowed to upload its own subset** (the bridge merges by
TER_NO). `selfUploaded` is computed by parsing the live EOD file's `TER_NO` row.
Lock TTL is refreshed after each successful `/endOfDay`.

### 3. Grand-total chain ([eodConsolidation.service.js](src/services/eodConsolidation.service.js))
Ayala validates a **per-terminal running total**: `NEW_GRNTOT[T] − OLD_GRNTOT[T]`
= that terminal's day net, and `OLD_GRNTOT[T]` = that terminal's `NEW_GRNTOT` on
its *previous active day*. **The bridge owns this chain.** The POS app sends
`OLD_GRNTOT=0` / `NEW_GRNTOT=day net`; on every `/endOfDay` the bridge:
- `normalizeTerminalGrandTotal()` — rewrites the day's OLD/NEW from the
  terminal's prior EOD (keeps the net invariant).
- `cascadeTerminalForward()` — shifts that terminal's OLD/NEW across all later
  days. **Other terminals' columns are never touched.** Writes are atomic
  (`atomicWriteFile`, Windows-safe rename-over-existing).

### Reprocess (regenerate a past day across all terminals)
Triggered by `POST /eod/reprocess` (raised from the POS after an EOD or bulk
upload). Flow:
1. **Raise** ([handleReprocess](src/controllers/ayala.controller.js)): snapshot
   the live EOD → copy into staging (so non-resubmitting terminals carry
   forward), compute the **expected terminal set** (registry ∪ live file's
   TER_NO row), mark the day dirty.
2. **Detect**: each terminal's `BridgeMonitorService` polls `/eod/status`, sees
   `reprocess.selfPending`, and **silently re-runs that day's hourly + daily**.
3. **Re-submit** (`/endOfDay` while reprocess active): writes into the **staging**
   file (never live), backs up the terminal's old per-transaction files, marks
   the terminal done.
   - **Gating:** if `NO_TRN > 0` but no regenerated hourly/per-transaction file
     was finalized this request → **409**. Ayala cross-foots EOD against the
     hourly files, so a reprocess must regenerate **both** (not EOD-only).
4. **Finalize** (all expected terminals done, *or* the 5-min window elapses via
   the sweep cron): atomic-swap staging → live, cascade each done terminal
   forward, clear state. Offline terminals are carried forward from the snapshot;
   they catch up on next launch.

TTL: a reprocess stays open 24h (terminals may be offline); the carry-forward
finalize window is 5 min.

## Background Jobs ([ayala.job.js](src/jobs/ayala.job.js))

- **Hourly finalize** (`0 * * * *`): finalizes the *previous* hour's per-terminal
  temp drafts → official per-transaction files (counts txns, updates `NO_TRN`,
  renames); deletes empty drafts.
- **Reprocess sweep** (`* * * * *`): finalizes any reprocess whose window elapsed
  (offline-terminal carry-forward).
- **Time watcher** ([timeWatcher.js](src/jobs/timeWatcher.js)): polls the clock
  every 15s; a jump > 2 min (manual change / demo) restarts the cron jobs so
  `node-cron` schedules don't drift.

## Conventions & Gotchas

- **Logging:** `electron-log` everywhere, context-prefixed: `[EndOfDay]`,
  `[Reprocess]`, `[Cron]`, `[TerminalRegister]`, etc. Tray → "View Logs".
- **Windows-only paths** are hardcoded (`C:\AYALA\...`, `C:\UTAK\Temp`).
- **Express 5** — async error semantics differ from v4; keep the
  try/catch-and-respond pattern in controllers.
- The bridge IP is shown in the tray and can change on the LAN; the POS resolves
  it via `ENDPOINT(mode)`. The IP watcher notifies on change.
- Don't write anything non-final into `UPLOADS_DIR` — staging/backups belong in
  `STAGING_DIR`.

## Client Side (for cross-repo work)

The POS app (`utakmobile24`) talks to this bridge from
`src/mall/ayala/_shared/`:
- `bridge/BridgeMonitorService.ts` — polls health + drains queue + runs the
  silent reprocess worker.
- `helpers/getBridgeEodStatus.ts` (`getBridgePendingReprocesses`),
  `claimBridgeEodLock.ts`, `registerDeviceTerminal.ts`,
  `raiseBridgeEodReprocess.ts`, `getAyalaBridgeDeviceId.ts`.
- `builders/DailyBuilder.ts` emits `OLD_GRNTOT=0` / `NEW_GRNTOT=day net` — this
  bridge owns the consolidated chain. Keep both sides in sync when changing the
  grand-total contract or any EOD field.
