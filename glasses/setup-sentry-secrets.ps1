# Stores the Sentry settings in the GitHub repo, so the iPhone app builds send crash and error reports
# (glasses/ios/GlassesRelay/ErrorReporting.swift) and the release workflows upload symbols for them.
# Values go straight from this prompt to GitHub, never through chat or a file in the repo.
#   powershell -ExecutionPolicy Bypass -File glasses\setup-sentry-secrets.ps1
$ErrorActionPreference = 'Stop'
$repo = 'stephen3303/claude-voice-relay'

# The DSN ships inside every app, so anyone with the IPA can send events to it; keeping it a secret only
# keeps it out of the repo. In Sentry, set a rate limit on the key (Client Keys > Configure) and turn on the
# inbound filters (Project Settings > Inbound Filters).
# site/privacy.html promises Sentry keeps no IP addresses; that's a setting on the Sentry side.
$ip = Read-Host 'In Sentry, Settings > Security & Privacy: is "Prevent Storing of IP Addresses" on? (y/n)'
if ($ip.Trim().ToLower() -ne 'y') { throw 'Turn on "Prevent Storing of IP Addresses" first; the privacy policy depends on it.' }

$dsn     = Read-Host 'DSN (Sentry > Settings > Projects > your project > Client Keys (DSN))'
$org     = Read-Host 'Organization slug (the part after sentry.io/organizations/ in the address bar)'
$project = Read-Host 'Project slug (e.g. bridge-ios)'
$secure  = Read-Host 'Organization auth token (Settings > Auth Tokens > Create New Token), or Enter to skip symbol upload' -AsSecureString
$token   = [Net.NetworkCredential]::new('', $secure).Password

if (-not $dsn.Trim().StartsWith('https://')) { throw 'A DSN starts with https://' }

gh secret set SENTRY_DSN       -R $repo -b $dsn.Trim()
gh variable set SENTRY_ORG     -R $repo -b $org.Trim()
gh variable set SENTRY_PROJECT -R $repo -b $project.Trim()
if ($token.Trim()) { gh secret set SENTRY_AUTH_TOKEN -R $repo -b $token.Trim() }

gh secret list -R $repo
gh variable list -R $repo
Write-Host "`nDone. The next build of the app reports to Sentry."
