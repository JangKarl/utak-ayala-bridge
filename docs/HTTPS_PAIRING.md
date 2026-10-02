# HTTPS pairing (Android pilot)

This branch changes the bridge protocol to authenticated HTTPS on TCP 3843.
It does not listen on HTTP 3800. Install matching desktop and Android builds together.
Existing HTTP POS versions, iOS, and browser requests cannot use this listener.
The POS needs a new native build; CodePush alone is not enough.
No release or production configuration change is part of this work.

## Pairing

1. Keep the bridge computer and Android POS on the same reachable LAN. Allow inbound TCP 3843 from the local subnet on the computer's private/domain network. The bundled Fix Bridge Connection tool uses this port.
2. Save the POS account's Ayala tenant code, contract number and bridge IPv4 address. The address remains a number such as 192.168.1.6, without a URL scheme or port.
3. On the bridge tray, select **Pair / Revoke POS**. Enter the concatenated tenant code and contract number (CCCODE), preserving leading zeros. Create a pairing code.
4. On the POS, open **Ayala Settings → Secure bridge** and either scan the QR with **Scan bridge pairing code**, or type the six-character code shown under it (e.g. `K7P-M2X`) and tap **Enter pairing code**. A 2D barcode scanner can also type the QR into the code field.
5. Keep the pairing window open until pairing succeeds. Each code expires in five minutes and authorizes one POS. Generate a new one for each additional POS.
6. Use **Bridge Status → Manual Check**. Both the bridge log/registry and the POS status should show the authenticated heartbeat.

The invitation authorizes the configured store; possession of the displayed QR is the enrollment authority. Do not distribute screenshots of active codes.
A lost pairing response or failed local credential write can require generating another invitation.

### Typed codes (POS without a camera, e.g. iMin Dual)

The code is six Crockford base32 characters (no I, L, O or U; the POS reads O as 0 and I/L as 1). It is never sent over the network.
The POS reads the certificate at the configured IP and derives `K = PBKDF2-SHA256(code, "ayala-pair-v1|" + pin + "|" + CCCODE + "|" + nonce, 600000 iterations)` with a random nonce.
It sends `HMAC(K, "pos")`; the bridge recomputes K with its own pin, checks it, and answers `HMAC(K, "bridge")`, which the POS verifies before saving the pairing. K itself is never sent.
A fake bridge at that IP receives a proof bound to its own certificate: the real bridge rejects it, and answering the POS correctly would require cracking the code (2^30 slow hashes) before the POS's 10-second timeout.
After pairing, the POS pins the certificate it saw, exactly like QR pairing. Five wrong attempts cancel the invitation; create a new code.
Pairing takes a few seconds on slow devices because of the deliberate slow hash.

## Offline operation and IP changes

Pairing and subsequent bridge requests use local TLS and local credentials. Neither public DNS nor Firebase token refresh is part of the bridge transport.
The POS must already have its account/store configuration available offline; first-time account login and mall/cloud delivery remain separate internet-dependent features.
Keep Wi-Fi/LAN connected when disconnecting internet.

A paired bridge has its own stable hostname and public-key pin. Android resolves that hostname only to the current configured IPv4 address.
After a DHCP address change, update the POS IP; no re-pairing is needed while the bridge identity is unchanged.
Reinstalling the POS, changing its device identity, changing the tenant/contract, or replacing the bridge identity requires pairing again.
Switching accounts selects a separate locally encrypted credential.

## Revocation, certificates and recovery

Use **Pair / Revoke POS → Revoke** to reject that credential on the next request. An already accepted request can finish.
Certificates last ten years; the tray shows their expiry. A POS clock far off (e.g. reset after a dead battery) rejects the certificate until the clock is corrected.
**Renew HTTPS Certificate** explicitly creates a new identity, revokes all pairings and restarts the bridge. Re-pair every POS after renewal.
There is no automatic certificate renewal or automatic HTTP fallback.

The bridge stores its private key and token hashes in Windows-user-bound encrypted `https-security.bin` under Electron userData.
Android encrypts credentials with Android Keystore; credentials never reach JavaScript, logs or request URLs.
Do not copy the encrypted bridge file to another Windows account expecting it to decrypt. Protect backups and verify recovery before replacing a store PC.
Corrupt encrypted state stops startup instead of silently changing trust. A missing file provisions a new identity; existing POS pins will reject it.

## Verification

- Bridge: `npm test` (includes actual Windows certificate provisioning and TLS pairing).
- Android: from `android`, run `gradlew.bat :app:testDebugUnitTest --tests com.utakmobile24.AyalaBridgeTlsTest --no-daemon`.
- Mobile transport: `npx jest src/mall/ayala/_shared/helpers/constant.test.ts --runInBand`.
- Native TLS tests generate short-lived local test keys with the JDK's keytool, then test the real OkHttp client against a loopback TLS server.
- Test positive pairing/heartbeat, wrong key/hostname, expired cert, revoked credentials, replayed invitation, cross-store uploads and unsupported platform. Never bypass TLS checks to make a test pass.

Before rollout, test on the actual POS: pair, reboot both devices without internet, confirm heartbeat, queue and replay a sample transaction/hourly/EOD, revoke/re-pair, and change the bridge IP.
Verify expected CSV content and no duplicates. Do not treat a green heartbeat as proof of mall delivery.
iOS transport and unattended renewal remain outside this Android pilot.

