# Stores the APNs key in AWS Secrets Manager (bridge/apns), so Bridge Cloud can ring the app when an
# agent wants to talk. The .p8 goes straight from this PC to AWS: never through chat or the repo.
#   powershell -ExecutionPolicy Bypass -File cloud\setup\setup-apns.ps1
# Make the key first: developer.apple.com > Certificates, IDs & Profiles > Keys > +, tick
# "Apple Push Notifications service (APNs)", environment Sandbox & Production. One key covers
# notifications and VoIP pushes for every app on the team.
$ErrorActionPreference = 'Stop'
$region = 'us-east-1'
$name = 'bridge/apns'

$team  = (Read-Host 'Apple Team ID (developer.apple.com/account > Membership details)').Trim()
$keyId = (Read-Host 'APNs Key ID (shown next to the key)').Trim()
$p8    = (Read-Host 'Path to the AuthKey_XXXX.p8 file').Trim('"')
if (-not (Test-Path $p8)) { throw "No file at $p8" }

$secret = @{ teamId = $team; keyId = $keyId; key = (Get-Content $p8 -Raw) } | ConvertTo-Json -Compress
$file = New-TemporaryFile
try {
  Set-Content -Path $file -Value $secret -NoNewline
  aws secretsmanager describe-secret --region $region --secret-id $name *> $null
  if ($LASTEXITCODE) {
    aws secretsmanager create-secret --region $region --name $name --secret-string "file://$file" | Out-Null
  } else {
    aws secretsmanager put-secret-value --region $region --secret-id $name --secret-string "file://$file" | Out-Null
  }
  if ($LASTEXITCODE) { throw 'Saving the secret failed' }
} finally { Remove-Item $file }
Write-Host "Done. Saved $name. The voice API picks it up on its next cold start (or the next deploy)."
