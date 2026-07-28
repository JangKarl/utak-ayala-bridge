# Ayala Bridge v2.52.4 — correct file dates on POS PCs set to the wrong timezone

Fixes a defect that made the mall reject End-of-Day files outright. No configuration or operator action is required for the fix itself, but see **Operator actions** below — there are two.

## What's fixed

- **The date in a generated filename now always matches the date inside the file.** A store's EOD was rejected with *"TRN_DATE in filename not equal to TRN_DATE inside the file"*: `EOD{ccode}072626.csv` contained `TRN_DATE,2026-07-27`. Dates that end up in a filename were being read back in the POS PC's **own** timezone, so on a PC not set to Philippine time the filename date landed a day behind the transaction date. Every filename and lock key is now derived in store time (`Asia/Manila`), independent of how the PC's clock is configured. This affects the EOD file, the official per-transaction file, the hourly draft buckets, and the EOD lock / reprocess keys.
- **Hourly files are finalized again on affected PCs.** The hourly job picked its target hour from the PC's clock while drafts are bucketed by the POS's transaction time, so on a wrongly-configured PC it matched nothing and quietly finalized no files. It was masked by the End-of-Day run finalizing them instead. It now works on its own schedule again.
- **Malformed dates are rejected instead of guessed at.** A date that doesn't arrive in the expected form is now refused rather than interpreted, since a guessed date would reproduce exactly the filename/content mismatch above.
- **Hourly drafts left behind by the previous version are recovered.** Drafts written before this update carry a filename that is a day out. End-of-Day now recognises and finalizes them under the correct date, so their transactions still reach the mall. Drafts belonging to a genuinely different business day are deliberately left untouched — including while a prior day's End-of-Day is being posted.

## Operator actions

1. **Set the POS PC's Windows timezone to Philippine time.** This release makes the bridge immune to a wrong PC timezone, but a wrong system clock will still cause problems elsewhere. Fix it on any affected machine.
2. **Before re-uploading a day that was processed by an older version,** check with the dev team first. Files already on disk from before this update carry the old, day-early filename. Re-sending one of those days would write a second file for the same business day and double-count it in the running grand total the mall validates. New days are unaffected.

## Notes

- Best installed between business days. Installing mid-day is safe for the current day's data, but leaves the smallest window for the draft-recovery path above.
- Adds `TIMEZONE` as an optional `.env` override (**default `Asia/Manila`**). It sets the *store's* timezone and should not be changed to match the PC's.

**Full changelog:** v2.52.3...v2.52.4
