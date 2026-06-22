# Ayala Bridge

A production Windows service that bridges Utak POS devices and Ayala's mall
reporting system. POS devices push transaction / end-of-day data over the local
network; the bridge generates Ayala-compliant CSV files into the mall pickup
folder and coordinates **multiple terminals that share one store** so the
consolidated reports stay correct.

It runs as a system-tray app with an embedded Express API server, auto-starts on
boot, and auto-updates over the air.

> **Working on the code?** See [CLAUDE.md](CLAUDE.md) for the full architecture,
> API reference, and the multi-terminal coordination design.

## Features
- **System tray integration** — runs in the background with a taskbar icon and a
  live list of connected POS devices (online/offline, last seen).
- **Auto-update (OTA)** — pulls signed releases from the private GitHub repo via
  `electron-updater`; installs on next quit.
- **Multi-terminal coordination** — store-wide-unique terminal numbers, a
  cross-terminal EOD lock, and bridge-owned per-terminal grand totals so several
  devices (even across Utak accounts) sharing one store produce one coherent EOD.
- **Reprocess / regenerate** — rebuild any past day's files across all terminals
  in the background, with atomic staging swap and offline-terminal carry-forward.
- **Vertical CSV generation** — the required `FIELD,VALUE` per-row format, one
  column per terminal.
- **Robust logging** — `electron-log` with rotation; viewable from the tray.
- **Installable** — native Windows NSIS installer; configurable auto-start.

## Installation
1. Download the installer from the releases page (or build it with `npm run build`).
2. Run the installer and follow the prompts.
3. Once installed, search for **Ayala Bridge** in the Start menu. It then keeps
   itself up to date automatically.

## Development
```bash
npm install
npm run dev      # Express server only (headless)
npm start        # Full Electron app with system tray
npm run build    # Build the Windows NSIS installer -> dist/
npm run publish  # Build + publish a GitHub release (drives OTA updates)
```
There is no automated test suite yet — verify via `npm run dev` and the HTTP API.

## Configuration
Settings live in the `.env` file in the application directory:
- `PORT` — API port (**default `3800`**).
- `GH_TOKEN` — GitHub PAT (`repo` scope) used by the auto-updater for the
  private release repo. Required for OTA and for `npm run publish`.
- `LOG_LEVEL`, `NODE_ENV` — logging / environment.

## API (summary)
Base URL `http://<bridge-ip>:3800`. Full reference in [CLAUDE.md](CLAUDE.md).
- `GET /status`, `GET /devices` — health and connected devices
- `POST /endOfDay`, `POST /transaction`, `POST /hourly`, `POST /checkPreviousEOD`
- `GET /heartbeat` — connectivity + device presence
- `POST /eod/start`, `GET /eod/status`, `POST /eod/reprocess` — EOD coordination
- `POST /terminal/register`, `GET /terminal/check` — terminal-number ownership

## Directories
| Path | Purpose |
|---|---|
| `C:\AYALA\tenant_api\storage\app\OUTGOING` | Final CSVs (the mall pickup folder). Changeable from the tray ("Select Directory"). |
| `C:\UTAK\Temp` | Hourly draft temp files + JSON state (terminal registry, EOD locks, reprocess state). |
| `C:\UTAK\Temp\.staging` | In-progress reprocess rebuilds (never seen by the mall). |

### Migrating existing files
If you have CSV files from a previous installation, copy them from the old
location (`%USERPROFILE%\.ayala-bridge\uploads`) to
`C:\AYALA\tenant_api\storage\app\OUTGOING`.

## Icon requirements
For a production installer, `assets/icon.ico` must be a valid `.ico` containing a
layer of at least **256×256 px**, or the build fails. Online converters like
`icoconvert.com` can ensure the 256px layer is present.
