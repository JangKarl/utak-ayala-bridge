# Ayala Bridge v2.51.1 — Hardened Build & Stable Installer Link

Maintenance release. No change to how the bridge runs — CSV generation, multi-terminal coordination, EOD/reprocess, and the auto-updater all behave exactly as in v2.51.0. This release hardens how the app is **packaged and distributed**.

## What's new

- **Hardened package** — The installer now ships only what the app needs at runtime. Local configuration files are no longer bundled into the build, and dev-only files (tests, sample data, docs) are excluded, so the installer is leaner and contains nothing it shouldn't.
- **Stable download link** — The installer now has a fixed name, so there is a single permanent download URL that always resolves to the latest version. No need to update links for every release.
- **Leaner auto-update** — Update checks no longer rely on any bundled credentials; the bridge talks to the public release feed directly.

## Notes

- Existing installs auto-update to v2.51.1 as usual — no manual reinstall needed. The first launch after updating shows the **"Updated to v2.51.1"** confirmation introduced in v2.51.0.
- Recommended: update to v2.51.1 so every bridge is running the hardened build.
- `GET /status` continues to report the running version for remote verification.

**Full changelog:** v2.51.0...v2.51.1
