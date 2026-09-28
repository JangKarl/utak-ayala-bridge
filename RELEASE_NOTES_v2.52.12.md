# Ayala Bridge v2.52.12 — make the fixed IP address actually survive a restart

v2.52.11 fixed a working address in place, said so, and then lost it at the next restart. This corrects that and stops the tool claiming an address is permanent when it is not. Nothing about how transactions are recorded, how files are generated and consolidated, or how they reach the mall has changed.

## What's fixed

- **A fixed address now survives restarting the PC.** v2.52.11 set the address in a way Windows only held in memory. It looked right — the report said the address was fixed, and it was, until the machine was next switched off. Windows then went back to asking the router and took whatever number it was given, so a store that had been told its address was settled found it had moved again days later. The address is now written the same way the Windows settings screen writes it, so it comes back after a restart.

- **The tool no longer says an address is permanent when it is not.** It used to check only whether the address was fixed *at that moment*, which was true even when nothing had been saved. It now checks what the PC will come back with after a restart, and says plainly which of the two it found — fixed and saved, or set but not saved. A store is never again told the matter is settled when it is not.

- **Setting the address can no longer leave the PC without one.** The previous version removed the old address and then added the new one, with a moment in between where the PC had no address at all — and no network to fix itself over if that second step failed. The address is now replaced in a single step.

## Operator actions

1. **Install and re-run Fix Connection at any store that ran v2.52.11.** Those addresses were not saved and will have drifted, or will drift at the next restart.
2. It prints the bridge IP. Set that same address in the tray's **Bridge IP** and on the tablet under **Ayala settings → IP address**. Support updates the account's stored address to match.
3. **Do the router reservation.** The tool prints the address and the PC's MAC for it. This is the only fix that survives a Windows repair, a network reset or a reinstall, because nothing on the PC holds the setting — the router simply hands back the same address every time. A fixed address on the PC is the fallback for stores where nobody can reach the router.

## Notes

- Safe to install at any time, including mid-day.
- Re-running remains safe: a PC whose address is already fixed and saved is reported as such and nothing is changed.
- If a store's address still moves after all of this, the cause is something resetting the PC's network — the Windows "Diagnose network problems" wizard, a driver reinstall, or security software — and only the router reservation prevents that.

**Full changelog:** v2.52.11...v2.52.12
