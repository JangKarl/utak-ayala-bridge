# Ayala Bridge v2.52.1 — Duplicate transaction guard

Fixes Ayala mall uploads being **rejected for duplicate transactions**. Some stores (e.g. Mamonaku, Vermosa) saw a run of `.csv_error` files with the message *"There are same TRANSACTION_NO"*, because the same sale was written into an upload file more than once — so those sales failed to report.

## What's fixed

- **Sales are no longer counted twice in an upload file.** If the POS re-sends a transaction (after a dropped/timed-out connection, or during a reprocess), the bridge now recognizes it's already recorded for that hour and skips the duplicate instead of appending it again.
- **Extra safety net at file build time.** Even if a duplicate somehow reaches the draft, the bridge now removes it when finalizing the official file, corrects the transaction count (`NO_TRN`), and never places a duplicate in the mall pickup folder.

## Notes

- No configuration or operator action is required — the fix is automatic once the bridge updates.
- **Already-rejected files** from before this update still need to be reprocessed so those sales tally with the mall. Coordinate a reprocess for the affected store/day/terminal with the Utak team.

**Full changelog:** v2.52.0...v2.52.1
