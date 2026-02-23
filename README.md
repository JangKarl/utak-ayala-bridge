# Ayala Bridge

A production-ready bridge for processing POS transaction data and generating Ayala-compliant CSV files.

## Features
- **System Tray Integration**: Run in the background with a taskbar icon.
- **Installable**: Native Windows installer (NSIS).
- **Auto-start**: Configurable to start when the computer boots.
- **Robust Logging**: Automated log rotation and persistent storage.
- **Vertical CSV Generation**: Formats transaction data into the required vertical `FIELD,VALUE` format.

## Installation
1. Download the installer from the releases page (or build it using `npm run build`).
2. Run the installer and follow the prompts.
3. Once installed, search for 'Ayala Bridge' in your Start menu.

## Development
```bash
npm install
npm run dev # Run server only
npm start   # Run as Electron app
```

## Configuration
Ports and other settings can be modified in the `.env` file located in the application directory.
By default, the bridge listens on port `3000`.

## Directory
Processed CSVs and logs are stored in `C:\AYALA\tenant_api\storage\app\OUTGOING`.

### Migrating Existing Files
If you have existing CSV files from a previous installation, manually copy them from the old location (`%USERPROFILE%\.ayala-bridge\uploads`) to the new directory (`C:\AYALA\tenant_api\storage\app\OUTGOING`).

## Icon Requirements
For a production-ready Windows installer, your `assets/icon.ico` must:
- Be a valid Microsoft Icon (.ico) file.
- Contain a layer that is at least **256x256 pixels**.
- If your icon is smaller, the build will fail. You can use online converters like 'icoconvert.com' to ensure your ICO file includes the 256px layer.
