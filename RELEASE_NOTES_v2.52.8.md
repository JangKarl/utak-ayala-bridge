# Ayala Bridge v2.52.8 — say when security software is blocking the POS

Improves the tray's *Fix Connection* tool. Nothing about how transactions are recorded, how files are generated and consolidated, or how they reach the mall has changed.

## What's new

- **It now says whether a tablet has actually reached this PC.** Until now the tool confirmed the bridge was working by asking it a question from the PC itself — a test the bridge passes even while every tablet in the store is being turned away, because that question never leaves the machine. It now reports when a POS last got through, and says plainly when none ever has. That is the difference between "the bridge is running" and "the bridge is reachable", and it is the answer support actually needs.

- **When other security software is installed, it spells out what to do.** McAfee, Avast and similar keep their own firewall, separate from the Windows one the tool already sets, and it is not allowed to change their settings. Instead of one line naming the product, it now prints the exact steps for that product — starting with a two-minute test that confirms whether it is the cause before anyone changes a single setting — with the store's Wi-Fi name and the file to allow already filled in, so there is nothing to look up. It also opens the security software ready for the operator.

## What it deliberately does not change

- **Another product's firewall settings.** McAfee and the like offer no supported way for a tool to add a rule, and anything forced in would quietly stop working on their next update — leaving the store broken while this tool reported success. The steps are put in front of a person instead.

## Operator actions

1. **None, unless the tool reports that security software is blocking the POS** — in which case the steps are on screen, in order, with the fast test first.

## Notes

- Safe to install at any time, including mid-day.
- The tool is still only run when someone chooses it from the tray. It never runs on its own.
- The report on the Desktop, `ayala-bridge-check.txt`, now includes the "last reached by a tablet" result. If the POS still will not connect, that file remains the one thing to send to UTAK support.

**Full changelog:** v2.52.7...v2.52.8
