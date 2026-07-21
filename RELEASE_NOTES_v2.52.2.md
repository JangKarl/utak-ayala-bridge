# Ayala Bridge v2.52.2 — EOD/reprocess hardening

Reliability and data-integrity hardening for the multi-terminal End-of-Day (EOD) and reprocess flow, from a pre-deploy review of the Ayala mall integration. No configuration or operator action is required — the fixes apply automatically once the bridge updates.

## What's fixed

- **Crash-safe state and EOD files.** The EOD lock, reprocess-state, and terminal-registry files, plus the live `EOD{ccode}{mmddyy}.csv` the mall picks up, are now written atomically (temp file + rename). A crash or power-loss mid-write can no longer leave a half-written file that the bridge would silently reset to empty on restart — which previously could drop an active lock or wipe the cross-terminal terminal-number registry.
- **Reprocess no longer reverts an applied correction.** If a reprocess is raised a second time for the same store/day while one is already in progress, the bridge keeps the in-progress rebuild instead of re-seeding it from the old file — so a correction another terminal already submitted is no longer silently discarded and reverted.
- **Normal EODs aren't wrongly blocked during a reprocess.** The "regenerate hourly first" guard now applies only to the terminals actually involved in the reprocess; a bystander terminal's normal EOD is no longer rejected.
- **Steadier terminal tracking.** The EOD/transaction/hourly endpoints now record terminal presence and flag terminal-number conflicts in the log (without ever blocking an EOD).

## Notes

- Also includes small robustness fixes (a temp-file matcher correction and guards against unhandled errors on the updater and the "Select Directory" tray action).

**Full changelog:** v2.52.1...v2.52.2
