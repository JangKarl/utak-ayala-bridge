# Ayala Bridge v2.52.9 — stop Fix Connection blaming the wrong thing

Corrects three checks in the tray's *Fix Connection* tool that could each send a store looking in the wrong place. Nothing about how transactions are recorded, how files are generated and consolidated, or how they reach the mall has changed.

## What's fixed

- **Security software that is switched off is no longer blamed.** The tool reported any installed suite as a likely cause, whether or not it was actually running. A store with an expired McAfee trial — protection off, firewall off — was told to go and change McAfee's firewall settings, which were blocking nothing. It now checks whether the product is really on, and says plainly when one is installed but switched off, so nobody spends an afternoon in the wrong settings screen.

- **It now finds a block placed on the port, not just on the program.** A rule that blocks the bridge by name was found and removed; a rule that blocks the port the bridge uses was invisible to it, even though the effect on the POS is identical. Both are found now. A rule that blocks *every* incoming connection is named on screen but never removed on its own — that can be deliberate on a shared PC, and deleting it could open far more than this one bridge.

- **It now checks the bridge is reachable, not merely running.** The tool confirmed something was listening on the port. If that something was listening only to the PC itself, it would answer the tool's own test and refuse every tablet — the one case that looked perfectly healthy from the PC while the store could not sell. It now reports the address the bridge is actually open on, and fails loudly when that address is the PC alone.

## Operator actions

1. **None.** Install it and run *Fix Connection* as before; the report is simply more accurate.

## Notes

- Safe to install at any time, including mid-day.
- The tool is still only run when someone chooses it from the tray. It never runs on its own.
- v2.52.8's additions are unchanged: it still reports when a tablet last reached this PC, and still prints the steps for a third-party firewall — now only when that firewall is actually on.

**Full changelog:** v2.52.8...v2.52.9
