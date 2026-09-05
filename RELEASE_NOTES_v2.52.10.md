# Ayala Bridge v2.52.10 — report a duplicate terminal number instead of only logging it

Makes one existing safety check visible outside the store PC. Nothing about how transactions are recorded, how files are generated and consolidated, or how they reach the mall has changed.

## What's changed

- **A duplicate terminal number is now reported back to the POS.** Each store terminal owns its number, and the bridge has always noticed when a second device tries to upload under a number that belongs to another one. Until now it only wrote that to the log file on this PC, where nobody would look until something had already gone wrong — and what goes wrong is that the second device's end-of-day overwrites the first one's column, so a terminal's whole day of sales quietly disappears from the consolidated file. The bridge now hands that warning back to the POS as well, so it can be seen from the back office while the day is still fixable.

- **The upload itself is unchanged.** The bridge still accepts the end-of-day from a device whose terminal number is contested. Refusing it would strand that terminal's sales entirely, which is worse than the clash it would prevent. This release reports; it does not block.

## Operator actions

1. **None.** Install it and carry on as before.

## Notes

- Safe to install at any time, including mid-day.
- Older POS builds ignore the new information, so this can be installed before the POS update that reads it. Nothing changes for them either way.
- If a store is told it has a duplicate terminal number, the fix is unchanged: set each device to its own number in POS device setup.

**Full changelog:** v2.52.9...v2.52.10
