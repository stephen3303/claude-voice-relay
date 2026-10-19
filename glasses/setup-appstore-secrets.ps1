# Stores the App Store upload secrets in the GitHub repo, so the "Glasses App Store upload"
# workflow can sign and send the app. Values go straight from this prompt to GitHub: the
# .p8 key never passes through chat or a file in the repo.
#   powershell -ExecutionPolicy Bypass -File glasses\setup-appstore-secrets.ps1
$ErrorActionPreference = 'Stop'
$repo = 'stephen3303/claude-voice-relay'

$team   = Read-Host 'Apple Team ID (developer.apple.com/account > Membership details)'
$keyId  = Read-Host 'App Store Connect Key ID'
$issuer = Read-Host 'App Store Connect Issuer ID'
$p8     = Read-Host 'Path to the AuthKey_XXXX.p8 file (e.g. C:\Users\steph\Downloads\AuthKey_ABC123.p8)'
$p8     = $p8.Trim('"')
if (-not (Test-Path $p8)) { throw "No file at $p8" }
# The Meta values can wait: left empty, the build uses "0" (Meta Developer Mode), fine for TestFlight.
$metaId    = Read-Host 'Meta App ID (Wearables Developer Center > your app; Enter to skip for now)'
$metaToken = if ($metaId.Trim()) { Read-Host 'Meta Client Token (same page)' } else { '' }

$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p8))

gh secret set APPLE_TEAM_ID      -R $repo -b $team.Trim()
gh secret set ASC_KEY_ID         -R $repo -b $keyId.Trim()
gh secret set ASC_ISSUER_ID      -R $repo -b $issuer.Trim()
gh secret set ASC_KEY_P8_BASE64  -R $repo -b $b64
if ($metaId.Trim()) {
  gh secret set META_APP_ID        -R $repo -b $metaId.Trim()
  gh secret set META_CLIENT_TOKEN  -R $repo -b $metaToken.Trim()
}

gh secret list -R $repo
Write-Host "`nDone. Keep the .p8 somewhere safe; Apple won't let you download it again."
