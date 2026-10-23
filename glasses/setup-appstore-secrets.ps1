# Stores the App Store upload secrets in the GitHub repo's "appstore" environment, so the "Glasses App Store
# upload" and "Glasses subscriptions" workflows can sign and send the app. Values go straight from this
# prompt to GitHub: the .p8 key never passes through chat or a file in the repo.
#   powershell -ExecutionPolicy Bypass -File glasses\setup-appstore-secrets.ps1
# The key is an Admin key, so it lives in an environment that only main can use: a workflow on any other
# branch can't read it. Repository-level copies from an earlier run are deleted for the same reason.
$ErrorActionPreference = 'Stop'
$repo = 'stephen3303/claude-voice-relay'
$envName = 'appstore'

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

# 1. The environment, accepting deployments from main only (same rule as aws-deploy).
'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/$repo/environments/$envName" --input - | Out-Null
if ($LASTEXITCODE) { throw "creating the $envName environment failed" }
# Parse the JSON here: Windows PowerShell splits a quoted --jq filter into several arguments.
$rules = (gh api "repos/$repo/environments/$envName/deployment-branch-policies" | ConvertFrom-Json).branch_policies
if ($LASTEXITCODE) { throw 'reading the branch rules failed' }
$hasMain = $false
foreach ($rule in @($rules | Where-Object { $_ })) {
  if ($rule.type -eq 'branch' -and $rule.name -eq 'main') { $hasMain = $true; continue }
  # Any other rule (a pattern like * or a tag) would let more than main read the key.
  gh api -X DELETE "repos/$repo/environments/$envName/deployment-branch-policies/$($rule.id)" | Out-Null
  if ($LASTEXITCODE) { throw "removing the branch rule '$($rule.name)' failed" }
}
if (-not $hasMain) {
  gh api -X POST "repos/$repo/environments/$envName/deployment-branch-policies" -f name=main -f type=branch | Out-Null
  if ($LASTEXITCODE) { throw 'adding the main branch rule failed' }
}
Write-Host "Environment ${envName}: main only"

# 2. The secrets, in that environment. $ErrorActionPreference doesn't stop on a failed gh, so check each one:
#    step 3 must never delete a repository copy whose replacement didn't land.
function Set-EnvSecret($name, $value) {
  gh secret set $name -R $repo --env $envName -b $value
  if ($LASTEXITCODE) { throw "setting $name in $envName failed; nothing was deleted" }
}
Set-EnvSecret APPLE_TEAM_ID     $team.Trim()
Set-EnvSecret ASC_KEY_ID        $keyId.Trim()
Set-EnvSecret ASC_ISSUER_ID     $issuer.Trim()
Set-EnvSecret ASC_KEY_P8_BASE64 $b64
if ($metaId.Trim() -and $metaToken.Trim()) {
  Set-EnvSecret META_APP_ID       $metaId.Trim()
  Set-EnvSecret META_CLIENT_TOKEN $metaToken.Trim()
}

# 3. Repository-level copies, which any branch's workflow could read. Only those the environment now holds:
#    skipped Meta prompts leave earlier repository values in place rather than dropping them.
$envSecrets = (gh secret list -R $repo --env $envName --json name | ConvertFrom-Json).name
if ($LASTEXITCODE) { throw "listing the $envName secrets failed; nothing was deleted" }
$repoSecrets = (gh secret list -R $repo --json name | ConvertFrom-Json).name
if ($LASTEXITCODE) { throw 'listing the repository secrets failed; nothing was deleted' }
foreach ($name in 'APPLE_TEAM_ID', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_BASE64', 'META_APP_ID', 'META_CLIENT_TOKEN') {
  if ($repoSecrets -contains $name -and $envSecrets -contains $name) {
    gh secret delete $name -R $repo
    if ($LASTEXITCODE) { throw "deleting the repository secret $name failed" }
    Write-Host "Removed the repository-level $name"
  }
}

gh secret list -R $repo --env $envName
Write-Host "`nDone. Keep the .p8 somewhere safe; Apple won't let you download it again."
