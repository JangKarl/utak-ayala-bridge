# Ayala Bridge - AI Coding Agent Instructions

## Project Overview
This is an Electron-based Windows application that acts as a bridge between POS systems and Ayala reporting requirements. It runs as a system tray application with an Express API server that receives transaction data and generates Ayala-compliant CSV files in a specific vertical format.

## Architecture

### Dual-Mode Design
- **Electron App** ([main.js](../main.js)): System tray interface, auto-start capability, Windows installer support
- **Express Server** ([bridge.js](../bridge.js)): HTTP API for receiving transaction data (port 3000 by default)
- **Separation**: Server can run standalone via `npm run dev` for testing, or bundled in Electron via `npm start`

### Core Data Flow
1. POS system sends transaction data to Express API endpoints
2. **Per-transaction mode**: Data appended to hourly temp files (`temp_MM_DD_YY_hour_H.csv`)
3. **Cron job** ([src/jobs/ayala.job.js](../src/jobs/ayala.job.js)): Every hour at minute 0, finalizes previous hour's temp file
4. **EOD mode**: Direct generation of end-of-day summary files
5. All files stored in `%USERPROFILE%\.ayala-bridge\uploads` (production) or `./uploads` (dev)

## Critical CSV Format (Unique to This Project)

### Vertical Field-Value Format
All CSV files use a **vertical format** where each row is `FIELD,VALUE` (not traditional columnar CSV):
```csv
CCCODE,78006000000003002
MERCHANT_NAME,TMS UNO RETAIL
TRN_DATE,2022-08-25
GROSS_SLS,6000.00
VAT_AMNT,578.57
```

### File Naming Conventions
- **EOD files**: `{CCCODE}{MMDDYY}{TER_NO}_{EODCTR}.csv`
  - Example: `ABC3212345012126001_000001.csv`
- **Transaction files**: `{CCCODE}{MMDDYY}{TER_NO}_{LAST_TRN_NO}.csv`
  - Example: `ABC3212340812260010000031.csv`
- **Temp files** (hourly drafts): `temp_{MM}_{DD}_{YY}_hour_{H}.csv`

### Field Definitions as Source of Truth
[src/constants/ayala.js](../src/constants/ayala.js) defines four critical field arrays:
- `FILE_HEADER_FIELDS`: Header for per-transaction files (CCCODE, MERCHANT_NAME, TRN_DATE, NO_TRN)
- `TRANSACTION_FIELDS`: Fields for each transaction record (~70 fields including payment types)
- `ITEM_FIELDS`: Line item details (QTY, ITEMCODE, PRICE, LDISC)
- `EOD_FIELDS`: End-of-day summary fields (~110 fields)

**When adding new fields**, update the constants file first, then ensure `formatValue()` in [src/utils/index.js](../src/utils/index.js) handles the formatting correctly.

## Field Formatting Rules

### Precision & Padding (see [src/utils/index.js](../src/utils/index.js))
- **Monetary fields** (e.g., `GROSS_SLS`, `VAT_AMNT`): Always `.00` two decimal places
- **Quantity fields** (`QTY`, `QTY_SLD`): `.000` three decimal places
- **Transaction numbers** (`STRANS`, `ETRANS`): Zero-padded to 8 digits
- **Counter fields** (`NO_*` prefix): Integer with no padding unless specified
- **Terminal number** (`TER_NO`): Zero-padded to 3 digits in filenames

**Example from `formatValue()`**:
```javascript
// QTY fields get 3 decimal places
if (["QTY", "QTY_SLD"].includes(key)) {
  return isNaN(num) ? "0.000" : num.toFixed(3);
}
```

## Critical Workflows

### Development
```bash
npm install          # Install dependencies
npm run dev          # Run Express server only (headless)
npm start            # Run full Electron app with system tray
```

### Building Installer
```bash
npm run build        # Creates Windows NSIS installer
```
**Icon requirement**: `assets/icon.ico` must have a 256×256 layer or build fails (documented in README)

### Testing API Endpoints
- `GET /status`: Health check
- `POST /endOfDay`: Generate EOD file (requires `data` object with EOD_FIELDS)
- `POST /transaction`: Append to hourly draft (requires `data` object with TRANSACTION_FIELDS + optional `items` array)
- `POST /checkPreviousEOD`: Check if EOD files exist for a given CCCODE and MMDDYY

**Request structure** (see [src/controllers/ayala.controller.js](../src/controllers/ayala.controller.js)):
```javascript
{
  "data": {
    "CCCODE": "ABC3212345012126001",
    "TRN_DATE": "2022-08-25",
    "GROSS_SLS": 6000.00,
    "items": [
      { "QTY": 2, "ITEMCODE": "ITEM001", "PRICE": 100.00, "LDISC": 0 }
    ]
  }
}
```

## Service Layer Patterns

### Controllers vs Services ([MVC-style separation](../src))
- **Controllers** ([src/controllers/ayala.controller.js](../src/controllers/ayala.controller.js)): Handle HTTP requests, validation, logging, responses
- **Services** ([src/services/ayala.service.js](../src/services/ayala.service.js)): Business logic for file generation, NO HTTP dependencies
- **Principle**: Services should be testable without Express context

### Error Handling Pattern
All controller methods follow this structure:
1. Validate request using `express-validator`
2. Log the operation with context (CCCODE, TRN_DATE, etc.)
3. Call service method
4. Log success with generated filename
5. Catch errors, log with prefix (e.g., `[EndOfDay]`), return 500

## Cron Job Behavior

The hourly finalization job ([src/jobs/ayala.job.js](../src/jobs/ayala.job.js)) runs at `0 * * * *` (every hour at minute 0):
- **Targets the PREVIOUS hour** (current time - 60 minutes)
- Checks for temp file existence
- Reads file content, counts transactions by `CDATE,` occurrences
- Updates `NO_TRN` field in header to match transaction count
- Renames temp file to official format with CCCODE + date + TER_NO + LAST_TRN_NO
- **Deletes temp file if empty** (0 transactions)

## Project-Specific Conventions

### Logging
- Uses `electron-log` throughout (works in both renderer and main process)
- All logs prefixed with context: `[EndOfDay]`, `[Transaction]`, `[Cron]`
- Log levels: `info` for normal operations, `error` for failures, `warn` for edge cases

### No Database
Files are the source of truth. Previous data is checked by reading the `uploads` directory directly (see `checkPreviousEOD()` method).

### Windows-Specific
- User data stored in `process.env.USERPROFILE` (Windows home directory)
- System tray integration ([main.js](../main.js) lines 35-65)
- NSIS installer configuration in [package.json](../package.json) `build` section

## When Adding Features

### New Field Types
1. Add to appropriate array in [src/constants/ayala.js](../src/constants/ayala.js)
2. Add formatting logic to `formatValue()` in [src/utils/index.js](../src/utils/index.js)
3. Update sample CSV files in `uploads/` for documentation

### New API Endpoints
1. Add route in [src/routes/ayala.routes.js](../src/routes/ayala.routes.js)
2. Add controller method in [src/controllers/ayala.controller.js](../src/controllers/ayala.controller.js)
3. Add service method in [src/services/ayala.service.js](../src/services/ayala.service.js)
4. Follow validation → log → service → log success pattern

### Modifying File Generation
All file writes happen in [src/services/ayala.service.js](../src/services/ayala.service.js). Key methods:
- `generateEodFile(data)`: Creates EOD CSV directly
- `appendTransaction(data)`: Adds to hourly temp file
- `finalizeHourlyDraft(tempFilename)`: Cron job calls this to rename/update temp files

## Example Files
Reference these for correct format:
- [uploads/correct_eod_textfile_format.csv](../uploads/correct_eod_textfile_format.csv): EOD format
- [uploads/correct_perTransaction_textfile_format.csv](../uploads/correct_perTransaction_textfile_format.csv): Transaction format

## Build & Deployment Notes
- Built files go to `dist/` (ignored by git)
- Logs stored in Electron's log directory (accessible via system tray "View Logs")
- Port 3000 is hardcoded in [src/constants/ayala.js](../src/constants/ayala.js) (can be changed via .env)
