$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$certHost = $env:AYALA_CERT_HOST
if ($certHost -notmatch '^ayala-[a-f0-9]{32}\.invalid$' -or $env:AYALA_CERT_PASSWORD -notmatch '^[a-f0-9]{64}$') {
  throw 'Invalid certificate provisioning input'
}
# Generate in memory: no CA installation, certificate-store access or admin rights.
$rsa = [Security.Cryptography.RSA]::Create(2048)
$cert = $null
try {
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=$certHost", $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName($certHost)
  $request.CertificateExtensions.Add($san.Build())
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
  $usages = [Security.Cryptography.OidCollection]::new()
  [void]$usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $true))
  # Trust is the pinned key, not the dates: a long life avoids a fleet-wide expiry,
  # and the day of back-dating absorbs POS clocks running slightly behind.
  $cert = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddYears(10))
  @{
    certificate = [Convert]::ToBase64String($cert.RawData)
    pfx = [Convert]::ToBase64String($cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:AYALA_CERT_PASSWORD))
  } | ConvertTo-Json -Compress
} finally {
  if ($cert) { $cert.Dispose() }
  $rsa.Dispose()
}

