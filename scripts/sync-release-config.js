#!/usr/bin/env node
/**
 * Post-publish hook: point the Utak back-office "Ayala Bridge" download at the
 * release we just published. Writes `config/ayalaBridge` in RTDB so the merchant
 * Settings UI shows the current version + a working download link.
 *
 * Runs automatically after `electron-builder --publish` (see the "publish"
 * script). Uses the Firebase CLI, so the maintainer must be logged in
 * (`firebase login`) with access to the target projects.
 *
 * The download URL is PERMANENT: it relies on the versionless artifact name
 * (build.artifactName = "ayala-bridge-Setup.${ext}") so GitHub's
 * `releases/latest/download/...` always resolves to the newest installer. Only
 * `version` / `releasedAt` change between releases.
 *
 * Usage (default updates BOTH dev and prod — publishing is already a
 * production action via electron-updater, so the pointer should match):
 *   node scripts/sync-release-config.js              # dev + prod
 *   node scripts/sync-release-config.js --only-prod  # prod only
 *   node scripts/sync-release-config.js --only-dev   # dev only
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pkg = require("../package.json");
const REPO = "JangKarl/utak-ayala-bridge";
const ARTIFACT = "ayala-bridge-Setup.exe"; // must match build.artifactName

// project + its RTDB instance (both projects keep their default instance on the
// legacy *.firebaseio.com host).
const TARGETS = {
  prod: { project: "posfire-8d2cb", instance: "posfire-8d2cb" },
  dev: { project: "utakdev2", instance: "utakdev2-default-rtdb" },
};

const args = process.argv.slice(2);
const targets = args.includes("--only-prod")
  ? [TARGETS.prod]
  : args.includes("--only-dev")
    ? [TARGETS.dev]
    : [TARGETS.dev, TARGETS.prod];

const config = {
  version: pkg.version,
  url: `https://github.com/${REPO}/releases/latest/download/${ARTIFACT}`,
  releasedAt: Date.now(),
};

const tmpFile = path.join(os.tmpdir(), `ayalaBridge-config-${process.pid}.json`);
fs.writeFileSync(tmpFile, JSON.stringify(config));

try {
  for (const t of targets) {
    console.log(`[sync] config/ayalaBridge -> ${t.project} (v${config.version})`);
    execFileSync(
      "firebase",
      [
        "database:set",
        "/config/ayalaBridge",
        tmpFile,
        "--project",
        t.project,
        "--instance",
        t.instance,
        "--force",
      ],
      { stdio: "inherit", shell: true },
    );
  }
  console.log("[sync] done:", JSON.stringify(config));
} finally {
  fs.unlinkSync(tmpFile);
}
