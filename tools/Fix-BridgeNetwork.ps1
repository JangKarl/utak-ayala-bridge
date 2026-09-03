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

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Right-click 'Fix Bridge Connection' and choose 'Run as administrator'." -ForegroundColor Red
  Read-Host "Press Enter to close" | Out-Null; exit 1
}

# ============================ 1. The bridge app ==============================
Head "Ayala Bridge app"

$proc = Get-Process -Name 'ayala-bridge' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path } | Select-Object -First 1

$Port = 3800
$portFrom = 'default'
# main.js reads .env from path.dirname(process.execPath) - beside the exe, not
# inside resources/ (the app itself is packed into app.asar).
$envPaths = @()
if ($proc) { $envPaths += (Join-Path (Split-Path $proc.Path) '.env') }
$envPaths += "$env:LOCALAPPDATA\Programs\ayala-bridge\.env"
$envPaths += "$env:ProgramFiles\ayala-bridge\.env"
foreach ($p in $envPaths) {
  if (Test-Path $p) {
    $m = Select-String -Path $p -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value; $portFrom = '.env' }
    break
  }
}
Note 'OK' "Port $Port (from $portFrom)"

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
  Select-Object -First 1
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

if (-not $broken) {
  Note 'OK' "IP $($ip4.IPAddress)/$($ip4.PrefixLength), gateway $gw reachable"
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
  Remove-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
  New-NetIPAddress -InterfaceIndex $idx -IPAddress $target -PrefixLength $prefix -DefaultGateway $gw | Out-Null
  Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $gw, '8.8.8.8'
  Note 'FIXED' "Address set to $target/$prefix, gateway $gw"
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
$blocked = @()
foreach ($r in (Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue)) {
  $p = ($r | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
  if ($p -and $p -match 'ayala') { $blocked += $r }
}
if ($blocked) {
  $blocked | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Note 'FIXED' "Removed $($blocked.Count) firewall rule(s) that were blocking the bridge."
}
else {
  Note 'OK' "No blocking rule for the bridge"
}

if (-not (Get-NetFirewallRule -DisplayName "Ayala Bridge $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Ayala Bridge $Port" -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
  Note 'FIXED' "Opened port $Port for incoming connections"
}
else {
  Note 'OK' "Port $Port is already open"
}

foreach ($cls in 'FirewallProduct', 'AntiVirusProduct') {
  foreach ($p in (Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName $cls -ErrorAction SilentlyContinue)) {
    if ($p.displayName -notmatch 'Windows Defender|Windows Firewall|Microsoft Defender') {
      Note 'WARN' "Other security software found: $($p.displayName). If the POS still cannot connect, allow port $Port in it too."
    }
  }
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

$gwNow = (Get-NetIPConfiguration -InterfaceIndex $idx).IPv4DefaultGateway
if ($gwNow -and (Test-Connection $($gwNow[0].NextHop) -Count 2 -Quiet -ErrorAction SilentlyContinue)) {
  Note 'OK' "Router is reachable"
}
else {
  Note 'FAIL' "Router is still unreachable. The Wi-Fi itself is down - reboot the router."
}

try {
  $r = Invoke-WebRequest -Uri "http://${MyIp}:$Port/heartbeat" -UseBasicParsing -TimeoutSec 8
  Note 'OK' "Bridge answered /heartbeat with HTTP $($r.StatusCode)"
}
catch {
  Note 'FAIL' "Bridge did not answer /heartbeat on ${MyIp}:$Port - restart the Ayala Bridge app."
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

Write-Host "`nNow set $MyIp in BOTH:" -ForegroundColor White
Write-Host "  1. Ayala Bridge tray icon -> Bridge IP" -ForegroundColor White
Write-Host "  2. The POS tablet -> Ayala settings -> IP address" -ForegroundColor White
Write-Host "`nOn the tablet's browser this must show a reply:" -ForegroundColor White
Write-Host "  http://${MyIp}:$Port/heartbeat" -ForegroundColor White
Write-Host "`nSend this file to UTAK support: $Log`n" -ForegroundColor White

try { Stop-Transcript | Out-Null } catch {}
Read-Host "Press Enter to close" | Out-Null
