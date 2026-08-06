# Ayala Bridge v2.52.5 — stop accepting a transaction and then discarding it

Fixes a defect that let a refund disappear between the POS and the mall without anything reporting a failure. No configuration or operator action is required.

## What's fixed

- **A record the bridge cannot store is now refused instead of acknowledged.** The bridge recognised an already-seen transaction purely by its transaction number. When the POS sent a refund that reused the transaction number of the sale it was refunding, the bridge treated it as a duplicate of that sale, skipped it, wrote a warning to the log, and still answered *"Transaction recorded"*. The POS had no way to tell a stored row from a discarded one, so it never queued or retried — the refund was simply gone. The loss only surfaced days later when the mall's validator flagged the day: one store on 2026-08-04 was reported as 17 per-transaction rows against the 18 its End-of-Day declared, with the refunded amount missing from the payment totals.

- **Genuine re-sends are still absorbed silently.** A record arriving a second time as the *same kind* of record — a sale re-sent as a sale, which is what a queue-drain retry or a reprocess re-run produces — is skipped exactly as before. Only a *different* kind of record arriving under a number already in use (a refund under a sale's number) is refused, and it is refused with an error the POS can see, log, and report.

- **Hourly finalization now names the problem.** The end-of-hour step still keeps the first record when two share a number, because it runs on a timer with no caller to report back to and stranding the draft would be worse. It now records a collision distinctly at error level instead of blending into the ordinary re-send notices, so an occurrence is findable in the log.

## Why the record is refused rather than stored alongside

Admitting both records would put the same transaction number in one file twice, and the mall rejects an entire file that does so. That would trade one lost row for a whole rejected hour. Refusing the write is the correct outcome: it keeps the file valid and puts the failure where someone can act on it.

## Notes

- **Operator actions: none.**
- Safe to install at any time, including mid-day.
- This release is the safety net, not the root fix. The underlying cause is on the POS side — refunds could be assigned a number already belonging to their original sale — and is addressed in a separate app update. Installing this bridge release **before** that app update is both safe and recommended: it changes nothing for correctly-numbered traffic and starts making any affected refunds visible immediately rather than letting them vanish.

**Full changelog:** v2.52.4...v2.52.5
