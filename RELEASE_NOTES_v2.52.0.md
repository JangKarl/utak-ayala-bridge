# Ayala Bridge v2.52.0 — Selectable Bridge IP

Adds an operator-selectable network address for the bridge. This fixes stores where the POS PC is on **two networks** (e.g. the store Wi-Fi *and* the Ayala mall LAN): the bridge could advertise the wrong address, leading POS devices to the unreachable network and causing uploads to fail.

## What's new

- **Bridge IP picker (tray)** — The tray now has a **Bridge IP** submenu listing every network address on the PC (with its adapter name). Pick the one your POS tablets are on (e.g. the store Wi-Fi address) and the bridge will use and display that address from then on.
- **Remembered across restarts** — The selected address is saved, so it stays put after reboots and updates. Leave it on **Auto-detect** to keep the previous automatic behavior.
- **Smarter "IP changed" alerts** — Notifications now follow your selected address, so the bridge no longer prompts you to switch to a secondary (e.g. mall-LAN) network it shouldn't use.
- **Self-healing** — If the chosen address ever disappears (adapter unplugged), the bridge automatically falls back to auto-detect instead of getting stuck.

## Notes

- The bridge still listens on **all** network interfaces, so it remains reachable even while you change the displayed address — selecting an IP sets what it advertises, not what it binds to.
- After updating: open the tray → **Bridge IP** → choose the store-network address, then make sure the bridge IP in the POS mall settings matches it.
- If POS devices still can't reach the bridge at that address, check the PC's firewall (allow TCP port 3800) and that the Wi-Fi network doesn't isolate clients from each other.

**Full changelog:** v2.51.1...v2.52.0
