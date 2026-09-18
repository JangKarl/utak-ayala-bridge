# Ayala Bridge v2.52.11 — Fix Connection now stops the IP address from changing

Corrects why a store's bridge address can still move on its own *after* **Fix Connection** has been run and has reported everything healthy. Nothing about how transactions are recorded, how files are generated and consolidated, or how they reach the mall has changed.

## What's fixed

- **An address that is working is now fixed in place, not merely approved.** The tool only ever pinned an address it judged broken. A PC with a perfectly normal address from the router was reported as healthy and left exactly as it was — which means still free to change. The router then handed out a different number at the next renewal, restart or power cut, and the tablet went on asking for the old one. The tray still said Running, the report still said every check passed, and the store still could not sell. A working address is now fixed the first time the tool sees one.

- **It keeps the number the PC already had.** Fixing the address does not move it, so there is nothing to re-type in the tray, on the tablet, or on the account. Running the tool again afterwards simply reports the address as fixed and changes nothing.

- **It can no longer leave a PC with no address at all.** Setting an address means briefly taking the old one off. If that step failed, the tool stopped right there — leaving the PC with no network, and no way to run the tool again over it. It now puts the PC back on the router's automatic address if it cannot finish, explains why, and carries on with the remaining checks. This also covers the repair it has always done for a broken address.

- **It now proves the address is really fixed before saying so.** The tool re-checks at the end and states plainly that the address cannot change by itself. If for any reason it could not be fixed, it says so and prints the PC's Wi-Fi MAC to give the router's owner, instead of printing a bridge IP that quietly stops being true.

## Operator actions

1. Install, then run **Fix Connection** once from the tray at each store.
2. It prints the bridge IP at the end. Set that same address in the tray's **Bridge IP** and on the tablet under **Ayala settings → IP address**. Support updates the account's stored address to match.
3. Best done once per store: ask whoever manages the Wi-Fi router to reserve that address for this PC. The tool now prints both the address and the MAC needed for it.

## Notes

- Safe to install at any time, including mid-day.
- Stores whose address was already set by hand are untouched — reported as fixed, nothing changed.
- The tool still only runs when someone chooses it from the tray. It never runs on its own, so a store nobody visits stays as it is.
- If an address ever does change again — a router reset, a new network, or another device taking the number — running **Fix Connection** repairs it exactly as before.

**Full changelog:** v2.52.10...v2.52.11
