# Ayala Bridge v2.52.13 — Fix Connection works on a LAN cable

Fix Connection only knew how to repair a bridge PC on Wi-Fi. A store that moved the bridge PC to a LAN cable got "No Wi-Fi adapter is connected", nothing was checked or fixed, and the address kept moving. This release lets it repair a cabled PC too. Nothing about how transactions are recorded, how files are generated and consolidated, or how they reach the mall has changed.

## What's fixed

- **Fix Connection now repairs a PC on a LAN cable.** It used to look only for Wi-Fi and stop when there was none. It now finds the connection the tablet actually uses — Wi-Fi or cable — and checks and fixes that one, including saving its address so it survives a restart.

- **It never guesses between two cables.** Many bridge PCs have two cables: the store network the tablet uses, and the mall link. Fixing the wrong one would cut the PC off from the mall. The tool decides by evidence — the tablet's address if support gives it, then the Bridge IP chosen in the tray, then Wi-Fi, then a single cable. If there are two cables and nothing says which one the tablet uses, it stops and says so instead of changing anything.

- **Wi-Fi-only steps stay on Wi-Fi.** Settings that only apply to wireless (private MAC address, wireless power plan) are skipped on a cable, and a PC with no Wi-Fi name no longer makes the report fail before its summary.

## Operator actions

1. On a PC with two cables, **set the tray's Bridge IP to the store-network address first**, or run `Fix Bridge Connection.cmd <tablet IP>`. Either tells the tool which cable is the tablet's.
2. Run Fix Connection. It prints the bridge IP. Set that same address on the tablet under **Ayala settings → IP address**. Support updates the account's stored address to match.
3. **Do the router reservation** for the address and MAC it prints. That is still the only fix that survives a Windows repair, a network reset or a reinstall.

## Notes

- Safe to install at any time, including mid-day. Nothing runs until someone clicks Fix Connection.
- Re-running remains safe: a healthy setting is reported, never changed.

**Full changelog:** v2.52.12...v2.52.13
