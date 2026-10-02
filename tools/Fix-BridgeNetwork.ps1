<#
  Ayala Bridge - Fix Connection
  Diagnoses and repairs why a POS tablet cannot reach this PC's bridge.
  Safe to re-run: a healthy setting is reported, never churned.
  Optional: -PosIp <tablet ip> to also test the tablet side.
#>
param([string]$PosIp)

$ErrorActionPreference = 'Stop'
$Log = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ayala-bridge-check.txt'
try { Start-Transcript -Path $Log -Force | Out-Null } catch {}

$Findings = @()
function Note($state, $text) {
  $script:Findings += [pscustomobject]@{ State = $state; Text = $text }
  $c = switch ($state) { 'OK' { 'Green' } 'FIXED' { 'Cyan' } 'WARN' { 'Yellow' } default { 'Red' } }
  Write-Host ("[{0,-5}] {1}" -f $state, $text) -ForegroundColor $c
}
function Head($t) { Write-Host "`n== $t ==" -ForegroundColor White }
function NetworkOf($ip, $prefix) {
  # Decimal literals, not 0xFFFFFFFF - PowerShell reads that as Int32 -1 and the
  # mask silently becomes null, which makes every subnet compare equal.
  $b = ([Net.IPAddress]::Parse($ip)).GetAddressBytes()
  $v = ([uint64]$b[0] -shl 24) -bor ([uint64]$b[1] -shl 16) -bor ([uint64]$b[2] -shl 8) -bor [uint64]$b[3]
  $m = (4294967295 -shl (32 - $prefix)) -band 4294967295
  return ($v -band $m)
}
function MaskOf($prefix) {
  # 24 -> 255.255.255.0. Built from the bit string rather than shifted ints, for
  # the same reason NetworkOf above avoids 0xFFFFFFFF.
  $bits = ('1' * $prefix).PadRight(32, '0')
  return ((0, 8, 16, 24 | ForEach-Object { [Convert]::ToInt32($bits.Substring($_, 8), 2) }) -join '.')
}

# netsh, NOT New-NetIPAddress. v2.52.11 used the Net* cmdlets here and they wrote
# only the runtime store: the address read back as Manual and the tool reported
# "it cannot change by itself", but the registry under
#   ...\Tcpip\Parameters\Interfaces\{GUID}
# still said EnableDHCP=1 with no IPAddress, so the very next reboot handed the PC
# a fresh lease. Reproduced on two machines a week apart. netsh applies AND
# persists in one step, which is also what the Windows settings UI does.
#
# It replaces the address outright, so unlike the old Remove-then-New there is no
# window where the adapter has no address at all.
#
# Returns $true only if the address really took.
function PinStatic($idx, $ip, $prefix, $gw) {
  $name = (Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue).Name
  if (-not $name) {
    Note 'WARN' "Could not read the Wi-Fi adapter name - address left as it is."
    return $false
  }
  # No 2>&1: redirecting a native command's stderr turns it into error records,
  # which $ErrorActionPreference='Stop' would throw on. netsh reports failure
  # through its exit code, so use that.
  $out = netsh interface ip set address name="$name" static $ip (MaskOf $prefix) $gw
  if ($LASTEXITCODE -ne 0) {
    netsh interface ip set address name="$name" dhcp | Out-Null
    netsh interface ip set dns name="$name" dhcp | Out-Null
    Note 'WARN' "Could not fix the address in place: $out. Put this PC back on DHCP - nothing was made worse, but the address can still change."
    return $false
  }
  netsh interface ip set dns name="$name" static $gw primary | Out-Null
  netsh interface ip add dns name="$name" 8.8.8.8 index=2 | Out-Null
  return $true
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Right-click 'Fix Bridge Connection' and choose 'Run as administrator'." -ForegroundColor Red
  Read-Host "Press Enter to close" | Out-Null; exit 1
}

# ============================ 1. The bridge app ==============================
Head "Ayala Bridge app"

$proc = Get-Process -Name 'ayala-bridge' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path } | Select-Object -First 1
# Quoted verbatim into the third-party firewall steps, so the operator never has
# to go hunting for the exe. Falls back to the default install path.
$BridgeExe = if ($proc) { $proc.Path } else { "$env:ProgramFiles\ayala-bridge\ayala-bridge.exe" }

$Port = 3843
Note 'OK' "Secure bridge port $Port"

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
$listener = $listeners | Select-Object -First 1
if (-not $listener) {
  Note 'FAIL' "Nothing is listening on port $Port - the Ayala Bridge app is not running."
  Write-Host "`n  ACTION: start Ayala Bridge from the desktop shortcut, then run this again." -ForegroundColor Red
  try { Stop-Transcript | Out-Null } catch {}
  Read-Host "Press Enter to close" | Out-Null; exit 1
}
$owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
if ($owner -and $owner.ProcessName -notmatch 'ayala') {
  Note 'FAIL' "Port $Port is taken by '$($owner.ProcessName)', not the bridge. Close it and restart the bridge."
}
else {
  Note 'OK' "Bridge is listening on port $Port"
}

# Listening is NOT the same as reachable. A socket bound only to loopback still
# answers this PC's own /heartbeat and refuses every tablet - indistinguishable
# from here, opposite for the store. Check WHERE it is bound, not just that
# something is.
$openBind = $listeners |
  Where-Object { $_.LocalAddress -notmatch '^(127\.|::1$)' } | Select-Object -First 1
if (-not $openBind) {
  Note 'FAIL' "Port $Port is bound to this PC only (loopback). No tablet can ever reach it - restart the Ayala Bridge app."
}
else {
  Note 'OK' "Port $Port is bound to $($openBind.LocalAddress) - open to the network"
}

# ============================ 2. Wi-Fi adapter ===============================
Head "Network"

$nic = Get-NetAdapter -Physical | Where-Object {
  $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'Wi-?Fi|Wireless|802\.11'
} | Select-Object -First 1
if (-not $nic) {
  Note 'FAIL' "No Wi-Fi adapter is connected. Connect this PC to the store Wi-Fi first."
  try { Stop-Transcript | Out-Null } catch {}
  Read-Host "Press Enter to close" | Out-Null; exit 1
}
$idx = $nic.ifIndex
Note 'OK' "Adapter $($nic.Name)  MAC $($nic.MacAddress)"

$cfg = Get-NetIPConfiguration -InterfaceIndex $idx
$ip4 = $cfg.IPv4Address | Select-Object -First 1
$gw = if ($cfg.IPv4DefaultGateway) { $cfg.IPv4DefaultGateway[0].NextHop } else { $null }

# Why the current address might be unusable.
$broken = $null
if (-not $ip4) { $broken = 'no IPv4 address at all' }
elseif ($ip4.IPAddress -like '169.254.*') { $broken = 'an APIPA address (169.254.x.x) - DHCP never answered' }
elseif (-not $gw) { $broken = 'no default gateway' }
elseif ((Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4).AddressState -contains 'Duplicate') {
  $broken = 'a duplicate IP - another device already uses it'
}
elseif (-not (Test-Connection $gw -Count 2 -Quiet -ErrorAction SilentlyContinue)) {
  $broken = "an unreachable gateway ($gw) - this address belongs to a different network"
}

if (-not $broken -and $ip4.PrefixOrigin -eq 'Dhcp') {
  # A healthy address is still a MOVING one while it comes from DHCP. The lease
  # renews, the router hands out a different number, and every stored copy of the
  # old one - tray, POS Ayala settings, RTDB - now points at nothing, with no
  # symptom on this PC to show for it. Freeze it exactly where it is: nothing to
  # re-type anywhere, and a re-run reports OK because the origin is then Manual.
  # ponytail: the address stays inside the router's DHCP pool, so a lapsed lease
  # could still be re-offered to another device. That surfaces as a duplicate IP,
  # which the repair below already detects and moves off on the next run.
  if (PinStatic $idx $ip4.IPAddress $ip4.PrefixLength $gw) {
    Note 'FIXED' "IP $($ip4.IPAddress) came from DHCP and would have changed by itself - pinned so it stays."
  }
}
elseif (-not $broken) {
  Note 'OK' "IP $($ip4.IPAddress)/$($ip4.PrefixLength) is fixed, gateway $gw reachable"
}
else {
  Note 'WARN' "This PC has $broken. Repairing..."

  # Ask the router what the network really is, then re-apply it statically. Nobody
  # types a gateway, and the address still stays put for the POS's stored IP.
  Set-NetIPInterface -InterfaceIndex $idx -Dhcp Enabled
  Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses
  ipconfig /renew "$($nic.Name)" | Out-Null

  $cfg = $null
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    $c = Get-NetIPConfiguration -InterfaceIndex $idx
    if ($c.IPv4Address -and $c.IPv4DefaultGateway) { $cfg = $c; break }
  }
  if (-not $cfg) {
    Note 'FAIL' "The router handed out no IPv4 address. This is a router/internet fault, not a PC fault."
    Write-Host "`n  ACTION: reboot the Wi-Fi router, or call the internet provider." -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    Read-Host "Press Enter to close" | Out-Null; exit 1
  }

  $dhcpIp = $cfg.IPv4Address[0].IPAddress
  $prefix = $cfg.IPv4Address[0].PrefixLength
  $gw = $cfg.IPv4DefaultGateway[0].NextHop
  $target = $dhcpIp
  if ($prefix -eq 24) {
    # ponytail: /24 only, and "free" is one ping - a sleeping device answers nothing.
    # Swap in an ARP sweep if a collision ever turns up in the field.
    $net = ($gw -split '\.')[0..2] -join '.'
    foreach ($hostNum in 171, 200, 240, 250) {
      $cand = "$net.$hostNum"
      if ($cand -eq $gw) { continue }
      if ($cand -eq $dhcpIp) { $target = $cand; break }
      if (-not (Test-Connection $cand -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
        $target = $cand; break
      }
    }
  }
  if (PinStatic $idx $target $prefix $gw) {
    Note 'FIXED' "Address set to $target/$prefix, gateway $gw"
  }
  $cfg = Get-NetIPConfiguration -InterfaceIndex $idx
  $ip4 = $cfg.IPv4Address | Select-Object -First 1
}
$MyIp = $ip4.IPAddress

# --- a second default gateway (typically the mall Ethernet link) --------------
foreach ($r in (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceIndex -ne $idx })) {
  $n = (Get-NetAdapter -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue).Name
  Note 'WARN' "'$n' also has a default gateway ($($r.NextHop)). Two gateways make Windows drop the Wi-Fi."
  Write-Host "         ACTION: clear ONLY the 'Default gateway' box on '$n' - keep its IP and mask." -ForegroundColor Yellow
}

# --- another adapter sitting on the same subnet -------------------------------
$myNet = NetworkOf $MyIp $ip4.PrefixLength
foreach ($a in (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceIndex -ne $idx -and $_.IPAddress -notlike '127.*' })) {
  if ((NetworkOf $a.IPAddress $a.PrefixLength) -eq $myNet) {
    $n = (Get-NetAdapter -InterfaceIndex $a.InterfaceIndex -ErrorAction SilentlyContinue).Name
    Note 'WARN' "'$n' ($($a.IPAddress)) is on the SAME network as Wi-Fi. Unplug it or change its subnet."
  }
}

# ============================ 3. Firewall ====================================
Head "Firewall"

Set-NetConnectionProfile -InterfaceIndex $idx -NetworkCategory Private -ErrorAction SilentlyContinue
$prof = (Get-NetConnectionProfile -InterfaceIndex $idx -ErrorAction SilentlyContinue).NetworkCategory
Note 'OK' "Network profile: $prof"

# Clicking Cancel on the first Windows popup leaves a BLOCK rule behind, and a
# block always beats an allow. This is the invisible one.
# A block can name the PROGRAM or the PORT. Only checking the program missed the
# port-scoped kind entirely, which looks exactly the same from the tablet.
$blocked = @()
$broad = @()
foreach ($r in (Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue)) {
  $p = ($r | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
  if ($p -and $p -match 'ayala') { $blocked += $r; continue }
  $lp = ($r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue).LocalPort
  if ($lp -contains "$Port") { $blocked += $r; continue }
  # A rule blocking EVERY inbound port may be deliberate policy on a shared PC.
  # Name it, never delete it - removing it could open far more than this bridge.
  if (-not $p -and $lp -contains 'Any') { $broad += $r }
}
if ($blocked) {
  $blocked | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Note 'FIXED' "Removed $($blocked.Count) firewall rule(s) that were blocking the bridge."
}
else {
  Note 'OK' "No blocking rule for the bridge"
}
foreach ($r in $broad) {
  Note 'WARN' "Rule '$($r.DisplayName)' blocks ALL incoming connections. Left in place on purpose - check whether it is meant to be there."
}

if (-not (Get-NetFirewallRule -DisplayName "Ayala Bridge $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Ayala Bridge $Port" -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Private,Domain | Out-Null
  Note 'FIXED' "Opened port $Port for incoming connections"
}
else {
  Note 'OK' "Port $Port is already open"
}

# The HTTP-era rule opened 3800 on every profile; nothing listens there any more.
$legacy = @(Get-NetFirewallRule -DisplayName 'Ayala Bridge 3800' -ErrorAction SilentlyContinue)
if ($legacy.Count) {
  $legacy | Remove-NetFirewallRule
  Note 'FIXED' "Closed the old HTTP port 3800 rule"
}

# A third-party suite keeps its OWN firewall, which the rule above does not touch.
# Consumer McAfee/Norton ship no supported CLI to add a rule through, so the most
# we can do is name the product and spell out the clicks in the summary.
# productState is 0xPPSSUU; the middle byte's 0x10 bit means "this product is ON".
# An expired or switched-off trial stays REGISTERED here, and warning about one
# sends the reader hunting through settings that are blocking nothing.
$ThirdParty = @()
$ThirdPartyExe = $null
$ThirdPartyOff = @()
foreach ($cls in 'FirewallProduct', 'AntiVirusProduct') {
  foreach ($p in (Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName $cls -ErrorAction SilentlyContinue)) {
    if ($p.displayName -match 'Windows Defender|Windows Firewall|Microsoft Defender') { continue }
    $on = $false
    if ($null -ne $p.productState) {
      $on = ((([int]$p.productState -shr 8) -band 0xFF) -band 0x10) -ne 0
    }
    if ($on) {
      $ThirdParty += $p.displayName
      if (-not $ThirdPartyExe -and $p.pathToSignedProductExe) {
        $ThirdPartyExe = $p.pathToSignedProductExe
      }
    }
    else {
      $ThirdPartyOff += $p.displayName
    }
  }
}
$ThirdParty = @($ThirdParty | Sort-Object -Unique)
$ThirdPartyOff = @($ThirdPartyOff | Sort-Object -Unique |
  Where-Object { $ThirdParty -notcontains $_ })
foreach ($n in $ThirdParty) {
  Note 'WARN' "$n keeps its own firewall and it is ON - if the POS still cannot connect, this is almost always why."
}
foreach ($n in $ThirdPartyOff) {
  Note 'OK' "$n is installed but switched OFF - it is not what is blocking the POS."
}

# ============================ 4. Staying awake ===============================
Head "Power"

# A laptop that sleeps, or a Wi-Fi card that powers down when idle, is the usual
# cause of a bridge that works and then goes Offline by itself.
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /setacvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 `
  12bbebe6-58d6-4636-95bb-3217ef867c1a 0 | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null
Note 'FIXED' "Sleep disabled while plugged in; Wi-Fi set to maximum performance"

# Device Manager's "Allow the computer to turn off this device" has no cmdlet on
# every build, so set the adapter's PnPCapabilities directly (0x18 = never power down).
$netClass = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}'
$key = Get-ChildItem $netClass -ErrorAction SilentlyContinue | Where-Object {
  (Get-ItemProperty $_.PSPath -Name NetCfgInstanceId -ErrorAction SilentlyContinue).NetCfgInstanceId -eq $nic.InterfaceGuid
} | Select-Object -First 1
if ($key) {
  Set-ItemProperty -Path $key.PSPath -Name PnPCapabilities -Value 24 -Type DWord -ErrorAction SilentlyContinue
  Note 'FIXED' "Wi-Fi card set to never power down to save power (applies after the next restart)"
}
else {
  Note 'WARN' "Could not reach the Wi-Fi card's power setting - untick 'Allow the computer to turn off this device' in Device Manager if the bridge keeps dropping."
}

$ssid = (netsh wlan show interfaces | Select-String '^\s+SSID\s+:\s+(.+)$').Matches |
  ForEach-Object { $_.Groups[1].Value.Trim() } | Select-Object -First 1
if ($ssid) {
  netsh wlan set profileparameter name="$ssid" randomization=disabled | Out-Null
  Note 'OK' "Wi-Fi '$ssid' will always use the real MAC (needed for a router IP reservation)"
}

# ============================ 5. Proof it works ==============================
Head "Verification"

# Two different questions, and v2.52.11 only asked the first one. Get-NetIPAddress
# reads the ACTIVE store - what is true this second. The registry is what Windows
# reads back after a restart. Checking only the active store is how the tool came
# to promise "it cannot change by itself" about a pin the next reboot discarded.
$liveOrigin = (Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -eq $MyIp }).PrefixOrigin
$reg = Get-ItemProperty ("HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\" +
  $nic.InterfaceGuid) -ErrorAction SilentlyContinue
$persisted = $reg -and $reg.EnableDHCP -eq 0 -and ($reg.IPAddress -contains $MyIp)

if ($liveOrigin -eq 'Manual' -and $persisted) {
  Note 'OK' "$MyIp is fixed and stays fixed after a restart"
}
elseif ($liveOrigin -eq 'Manual') {
  Note 'WARN' "$MyIp is set now but was NOT saved - restarting this PC will put it back on a router-assigned address. Ask whoever owns the router to reserve $MyIp for MAC $($nic.MacAddress)."
}
else {
  Note 'WARN' "$MyIp still comes from the router and can change on its own. Ask whoever owns the router to reserve it for MAC $($nic.MacAddress)."
}

$gwNow = (Get-NetIPConfiguration -InterfaceIndex $idx).IPv4DefaultGateway
if ($gwNow -and (Test-Connection $($gwNow[0].NextHop) -Count 2 -Quiet -ErrorAction SilentlyContinue)) {
  Note 'OK' "Router is reachable"
}
else {
  Note 'FAIL' "Router is still unreachable. The Wi-Fi itself is down - reboot the router."
}

# HTTPS requires the POS pairing key and credential. Test TCP reachability here;
# only the paired POS heartbeat proves certificate trust and inbound connectivity.
if (Test-NetConnection -ComputerName $MyIp -Port $Port -InformationLevel Quiet) {
  Note 'OK' "Secure bridge TCP port $Port is reachable locally. Verify heartbeat on the paired POS."
} else {
  Note 'FAIL' "Secure bridge TCP port $Port is unreachable."
}
# Registry timestamps indicate the most recent POS heartbeat.
$RegFile = 'C:\UTAK\Temp\terminal_registry.json'
$lastSeen = $null
if (Test-Path $RegFile) {
  try {
    $reg = Get-Content $RegFile -Raw | ConvertFrom-Json
    foreach ($cc in $reg.PSObject.Properties) {
      foreach ($ter in $cc.Value.PSObject.Properties) {
        $ms = if ($ter.Value.lastSeenAt) { $ter.Value.lastSeenAt } else { $ter.Value.updatedAt }
        if ($ms) {
          $when = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ms).LocalDateTime
          if (-not $lastSeen -or $when -gt $lastSeen) { $lastSeen = $when }
        }
      }
    }
  }
  catch { Note 'WARN' "Could not read the terminal registry: $($_.Exception.Message)" }
}
if (-not $lastSeen) {
  Note 'WARN' "No tablet has EVER reached this bridge. If this store worked before, something is blocking incoming connections."
}
elseif ($lastSeen -gt (Get-Date).AddMinutes(-15)) {
  Note 'OK' "A tablet reached this bridge at $($lastSeen.ToString('h:mm tt')) - incoming connections work."
}
else {
  Note 'WARN' "No tablet has reached this bridge since $($lastSeen.ToString('d MMM, h:mm tt')) - incoming connections look blocked."
}

if ($PosIp) {
  $sameNet = $false
  try { $sameNet = (NetworkOf $PosIp $ip4.PrefixLength) -eq (NetworkOf $MyIp $ip4.PrefixLength) } catch {}
  if (-not $sameNet) {
    Note 'FAIL' "The tablet ($PosIp) is on a DIFFERENT network than this PC ($MyIp)."
    Write-Host "         ACTION: put the tablet on the same Wi-Fi as this PC - not guest Wi-Fi, not mobile data." -ForegroundColor Red
  }
  elseif (Test-Connection $PosIp -Count 2 -Quiet -ErrorAction SilentlyContinue) {
    Note 'OK' "Tablet $PosIp is reachable from this PC"
  }
  elseif (arp -a $PosIp | Select-String $PosIp) {
    Note 'FAIL' "The tablet is on this network but will not answer. The router most likely has AP/Client Isolation or Guest Mode ON."
    Write-Host "         ACTION: in the router settings turn OFF AP Isolation / Client Isolation / Guest network." -ForegroundColor Red
  }
  else {
    Note 'WARN' "No reply from $PosIp. Check the tablet is awake and joined to this Wi-Fi."
  }
}

# ============================ Summary ========================================
$bad = $Findings | Where-Object { $_.State -eq 'FAIL' }
$warn = $Findings | Where-Object { $_.State -eq 'WARN' }

Write-Host "`n=============================================" -ForegroundColor Cyan
Write-Host "  BRIDGE IP:  $MyIp        PORT: $Port" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

if ($bad) {
  Write-Host "`nSTILL BROKEN - do this:" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "  * $($_.Text)" -ForegroundColor Red }
}
elseif ($warn) {
  Write-Host "`nThe bridge is reachable, but check these:" -ForegroundColor Yellow
  $warn | ForEach-Object { Write-Host "  * $($_.Text)" -ForegroundColor Yellow }
}
else {
  Write-Host "`nAll checks passed." -ForegroundColor Green
}

if ($ThirdParty) {
  $sec = $ThirdParty[0]
  Write-Host "`n---- IF THE TABLET STILL CANNOT CONNECT ----" -ForegroundColor Yellow
  Write-Host "  Windows Firewall is already set. $sec has a SEPARATE one" -ForegroundColor Yellow
  Write-Host "  that this tool is not allowed to change." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  FAST TEST: switch the $sec firewall OFF for 2 minutes and let" -ForegroundColor Yellow
  Write-Host "  the tablet try again. If it connects, that was the cause." -ForegroundColor Yellow
  Write-Host "  Turn it back ON, then do the 3 steps below." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  1. $sec -> Firewall -> Network Connections" -ForegroundColor Yellow
  if ($ssid) {
    Write-Host "     Set '$ssid' to TRUSTED / HOME (not Public)." -ForegroundColor Yellow
  }
  else {
    Write-Host "     Set this Wi-Fi to TRUSTED / HOME (not Public)." -ForegroundColor Yellow
  }
  Write-Host "  2. $sec -> Firewall -> Internet Connections for Programs -> Add" -ForegroundColor Yellow
  Write-Host "     Pick this file: $BridgeExe" -ForegroundColor Yellow
  Write-Host "     Give it FULL access (incoming AND outgoing)." -ForegroundColor Yellow
  Write-Host "  3. $sec -> Firewall -> Ports and System Services -> Add" -ForegroundColor Yellow
  Write-Host "     Name it 'Ayala Bridge', TCP port $Port, incoming." -ForegroundColor Yellow
  if ($ThirdPartyExe -and (Test-Path $ThirdPartyExe)) {
    Write-Host "`n  Opening $sec for you..." -ForegroundColor Yellow
    Start-Process $ThirdPartyExe -ErrorAction SilentlyContinue
  }
  Write-Host ""
}

Write-Host "`nNow set $MyIp in BOTH:" -ForegroundColor White
Write-Host "  1. Ayala Bridge tray icon -> Bridge IP" -ForegroundColor White
Write-Host "  2. The POS tablet -> Ayala settings -> IP address" -ForegroundColor White
# This address is fixed on the PC, but the router does not know that and may hand
# the same number to a new device once the old lease lapses. A reservation is the
# only place that can be made impossible, and only its owner can set it.
Write-Host "`nBest done once, by whoever manages the router:" -ForegroundColor White
Write-Host "  reserve $MyIp for MAC $($nic.MacAddress) in the router's DHCP settings." -ForegroundColor White
Write-Host "`nPair the POS using the bridge tray menu, then run Manual Check in POS Bridge Status." -ForegroundColor White
Write-Host "  HTTPS port $Port requires the paired POS; a browser cannot authenticate." -ForegroundColor White
Write-Host "`nSend this file to UTAK support: $Log`n" -ForegroundColor White

try { Stop-Transcript | Out-Null } catch {}
Read-Host "Press Enter to close" | Out-Null
