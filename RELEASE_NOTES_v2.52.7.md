# Ayala Bridge v2.52.7 — make "Fix Connection" actually open

Corrects a defect in v2.52.6. **Anyone on v2.52.6 should install this**, otherwise the tray's *Fix Connection* entry does nothing. Nothing else has changed, and no configuration or operator action is required.

## What's fixed

- **"Fix Connection" now opens.** In v2.52.6 the entry closed instantly, showing a black window for a moment and no administrator prompt. It failed at the point where it asks Windows for administrator rights, before anything else could run. Choosing it from the tray now brings up the usual Windows permission prompt and then the checks, as intended.

## Notes

- **Operator actions: none.**
- Safe to install at any time, including mid-day.
- v2.52.6 is otherwise unaffected: how transactions are recorded, how files are generated and consolidated, and how they reach the mall are all identical. Only the tray tool was unreachable.

**Full changelog:** v2.52.6...v2.52.7
