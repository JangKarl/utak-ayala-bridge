#!/usr/bin/env node
/**
 * Post-publish hook: point the Utak back-office "Ayala Bridge" download at the
 * release we just published. Writes `config/ayalaBridge` in RTDB so the merchant
 * Settings UI shows the current version + a working download link.
 *
 * Runs automatically after `electron-builder --publish` (see the "publish"
 * script). Uses the Firebase CLI, so the maintainer must be logged in
 * (`firebase login`) with WRITE access to the target database.
 *
 * The download URL is PERMANENT: it relies on the versionless artifact name
 * (build.artifactName = "ayala-bridge-Setup.${ext}") so GitHub's
 * `releases/latest/download/...` always resolves to the newest installer. Only
 * `version` / `releasedAt` change between releases.
 *
 * Targets:
 *   (default)      -> DEV only. Safe + the CLI login has write access.
 *   --prod         -> DEV + PROD (posfire-8d2cb). Needs a CLI account with write
 *                     access to prod RTDB (most maintainer logins do NOT).
 *   --only-prod    -> PROD only.
 *
 * DEV comes from DEV_FIREBASE_PROJECT (and optional DEV_FIREBASE_INSTANCE,
 * default "<project>-default-rtdb") in electron-builder.env, which is
 * gitignored: a maintainer's dev project never lands in this public repo.
 * Unset -> the dev write is skipped.
 *
 * PROD note: in normal operation prod's config/ayalaBridge is set by an admin
 * through the back-office "Ayala Settings" UI (authenticated write, governed by
 * RTDB rules) — not by this script. Writes here are best-effort: a failure logs
 * a warning and NEVER fails the publish (the release is already out by now).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pkg = require("../package.json");

// A beta (e.g. 2.53.0-beta.1) reaches only pilot PCs through the updater. The
// Back Office link and version must keep pointing at the stable release.
if (pkg.version.includes("-")) {
  console.log(`[sync] v${pkg.version} is a pre-release; Back Office config left unchanged.`);
  process.exit(0);
}
const REPO = "JangKarl/utak-ayala-bridge";
const ARTIFACT = "ayala-bridge-Setup.exe"; // must match build.artifactName

// Only the two DEV_* keys are read; the GH_TOKEN beside them is left alone.
let local = {};
try {
  local = require("dotenv").parse(fs.readFileSync(path.join(__dirname, "..", "electron-builder.env")));
} catch (_) {
  // No electron-builder.env: no dev target.
}
const DEV = local.DEV_FIREBASE_PROJECT
  ? {
      project: local.DEV_FIREBASE_PROJECT,
      instance: local.DEV_FIREBASE_INSTANCE || `${local.DEV_FIREBASE_PROJECT}-default-rtdb`,
    }
  : null;
const PROD = { project: "posfire-8d2cb", instance: "posfire-8d2cb" };

const args = process.argv.slice(2);
const targets = args.includes("--only-prod")
  ? [PROD]
  : args.includes("--prod")
    ? [DEV, PROD].filter(Boolean)
    : [DEV].filter(Boolean); // default: dev only
if (!DEV && !args.includes("--only-prod")) {
  console.log("[sync] DEV_FIREBASE_PROJECT not set in electron-builder.env; dev write skipped.");
}

const config = {
  version: pkg.version,
  url: `https://github.com/${REPO}/releases/latest/download/${ARTIFACT}`,
  releasedAt: Date.now(),
};

const tmpFile = path.join(os.tmpdir(), `ayalaBridge-config-${process.pid}.json`);
fs.writeFileSync(tmpFile, JSON.stringify(config));

const failed = [];
try {
  for (const t of targets) {
    console.log(`[sync] config/ayalaBridge -> ${t.project} (v${config.version})`);
    try {
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
    } catch (err) {
      // Best-effort: the GitHub release already published. Don't fail publish.
      failed.push(t.project);
      console.warn(
        `[sync] WARNING: could not write config/ayalaBridge to ${t.project} ` +
          `(${err.status === 2 ? "permission/CLI error" : err.message}). ` +
          `Skipping — set it manually if needed.`,
      );
    }
  }
} finally {
  fs.unlinkSync(tmpFile);
}

if (failed.length) {
  console.warn(
    `[sync] Done with warnings. Not written to: ${failed.join(", ")}.\n` +
      `[sync] For PROD, set it via the back-office "Ayala Settings" admin editor, ` +
      `or with a CLI account that has prod RTDB write access:\n` +
      `[sync]   firebase database:set /config/ayalaBridge <file> --project posfire-8d2cb --instance posfire-8d2cb --force`,
  );
} else {
  console.log("[sync] done:", JSON.stringify(config));
}
// Always succeed: pointer sync is best-effort and must not fail the release.
process.exit(0);
