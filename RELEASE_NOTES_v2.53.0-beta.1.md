# Ayala Bridge v2.53.0-beta.1 — paired, encrypted connection to the POS, and a window that shows what the bridge did

Until now any device on the store network could send sales to the bridge over plain HTTP, and the only way to see what the bridge was doing was the tray menu and the log file. This beta adds a secure, paired connection for the new POS (2.49) and a window that shows each day's files. It is a **beta**: only PCs with **Beta updates** ticked in the tray receive it. Old POS keep working unchanged, and nothing about how files are generated, consolidated or collected by the mall has changed.

## What's new

- **POS pair with the bridge, and the connection is encrypted.** The bridge now creates its own certificate and serves the POS on HTTPS port **3843**. A POS on 2.49 pairs once — scan the QR code, or type the 6-character code on devices without a camera — and from then on only paired POS can send to the bridge, each limited to its own store. A pairing code expires after 5 minutes or 5 wrong tries. Pairings can be revoked one by one from **Pair / Revoke POS**.

- **Old POS keep working during the move.** **Allow old POS (HTTP port 3800)** is on by default, so tablets still on 2.48 reach the bridge exactly as before. Turn it off only after every POS in the store is on 2.49 and paired.

- **A window that shows what the bridge did.** Click the tray icon (or open the shortcut again) to see the last 7 business days: closed, missing a terminal, no end of day, re-sending or open, each with what to do. Open a day to see every hourly file sent (transactions, receipts, sales, time), the hour still collecting, and the end-of-day totals per terminal. It also lists the tablets and the files folder, and has **Pair a POS**. Closing the window hides it; the bridge keeps running.

- **Beta updates.** A tray checkbox, **Beta updates (pilot stores only)**, lets a pilot store receive pre-releases like this one first. When the stable version ships, beta PCs move to it automatically.

## What's fixed

- **A folder chosen with Select Directory is now actually used.** The bridge read its folder before loading the saved choice, so a picked folder was ignored. PCs that picked a folder before this release keep writing where they do today, so nothing moves away from where Ayala collects it.

## Operator actions

1. **Pilot stores only:** tick **Beta updates** in the tray, then **Check for Updates**.
2. On each POS on 2.49: in the bridge, **Pair a POS** → enter the store code → on the POS, **Ayala settings → Secure Bridge** → scan the QR code or type the code. The POS shows online in the window once it connects.
3. Leave **Allow old POS** on until every POS in the store is paired. Then turn it off.
4. If a paired POS cannot connect, run **Fix Connection**. It opens port 3843 in Windows Firewall; a store that only allowed port 3800 needs this once.

## Notes

- Needs Windows 10 version 1803 or later (.NET Framework 4.7.2) to create the certificate. On older Windows the bridge shows an error at start and quits.
- **Renew HTTPS Certificate** in the tray removes every pairing; all POS must pair again afterwards. The certificate lasts 10 years, so this is for support only.
- Safe to install mid-day: old POS are not affected, and new POS only switch over when paired.

**Full changelog:** v2.52.13...v2.53.0-beta.1
