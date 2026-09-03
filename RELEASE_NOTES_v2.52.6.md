# Ayala Bridge v2.52.6 — repair a POS that cannot reach the bridge, from the tray

Adds a tool for the most common support call: the tray says *Running*, but the POS sits on **Offline** and never sends. Nothing about how files are generated, consolidated, or uploaded has changed.

## What's new

- **A "Fix Connection" entry in the tray menu.** It checks the whole path between the POS and this PC, repairs what it can, and finishes by showing the address to enter on the tablet. It asks for the Windows administrator prompt when it starts, and can be run at any time — a setting that is already correct is reported, never changed.

- **The usual cause is repaired automatically.** In almost every case the store PC's Wi-Fi has been given an address by hand, along with a *router address that does not exist on that network*. Windows then reports "No network access" on the Wi-Fi while the bridge carries on running normally, and the POS heartbeat times out because nothing ever reaches it. The tool no longer asks anyone to type a router address: it asks the router itself what the network is, then fixes the PC's address to match. The address still stays put, so the address stored on the POS keeps working.

- **It also finds the faults that look identical from the outside.** A bridge that is not running, or a port taken by another program; an address the router never issued, or one already in use by another device; a router handing out no address at all; a second network connection competing with the Wi-Fi; and — the invisible one — a Windows Firewall rule created by clicking *Cancel* on the security prompt the first time the bridge started, which blocks the POS no matter what else is set. Each is either repaired or named on screen with the exact step to take.

- **It stops the bridge going offline by itself.** A laptop that sleeps, or a Wi-Fi card Windows powers down when idle, is the usual reason a working bridge drops out later in the day. Both are switched off while the PC is plugged in.

- **Optionally checks the tablet too.** Given the tablet's address, it can tell the difference between a tablet joined to the wrong Wi-Fi and a router with Guest mode or Client Isolation switched on — two faults that otherwise look the same and are fixed very differently.

- **It leaves a report.** Everything it found is written to **`ayala-bridge-check.txt`** on the Desktop. If the POS still will not connect, send that file to UTAK support — it is the whole picture in one attachment.

## What it deliberately does not change

- **A second network connection with its own router address is reported, not altered.** On stores with a separate mall network cable, that connection is how sales reach the mall. Removing its router address could stop uploads, so the tool names the connection and the exact box to clear, and leaves the decision to a person.
- **Other security software** (McAfee, Avast, and similar) is reported by name. Its settings are outside the tool's reach and may need the port allowed there as well.

## Operator actions

1. **After running it, set the address it shows in both places** — the tray's *Bridge IP*, and the POS's Ayala settings. Both must match, or the POS will keep looking at the old one.
2. **It changes the PC's power settings.** Sleep and hibernate are switched off while plugged in, so the bridge stays reachable through the trading day. This is intended; be aware of it on a shared laptop.
3. **The Wi-Fi card's power setting takes effect after the next restart.** Everything else applies immediately.

## Notes

- Safe to install at any time, including mid-day.
- The tool is only run when someone chooses it from the tray. It never runs on its own.
- It repairs a connection that is broken; it cannot keep an address from changing later. A router reboot or a replacement router can still hand out a different address, and the POS must then be pointed at the new one.

**Full changelog:** v2.52.5...v2.52.6
