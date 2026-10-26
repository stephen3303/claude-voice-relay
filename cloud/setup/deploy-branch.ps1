# Deploys BridgeApi from this checkout (an unmerged branch) from your PC, then runs setup-owner.ps1, to try the
# owner's agents before the PR is merged. Run it from a separate worktree of the branch, not the relay's folder:
#   powershell -ExecutionPolicy Bypass -File <worktree>\cloud\setup\deploy-branch.ps1
# Needs: the AWS CLI signed in as an admin (aws sts get-caller-identity), Docker Desktop running (CDK builds the
# agent runner's image), Node 22 and Claude Code. The next Cloud deploy from main puts main's BridgeApi back,
# which removes the runner again until this branch is merged.
# -SkipLogin keeps the claude.ai login already stored (a rerun after a code change). The first run also asks for
# the Sentry DSN, so the branch's Lambdas report errors as main's do.
param([string]$RelayDir = (Join-Path $env:USERPROFILE 'Projects\claude-voice-relay'), [switch]$SkipLogin)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
docker info *> $null; $dockerOk = -not $LASTEXITCODE
aws sts get-caller-identity *> $null; $awsOk = -not $LASTEXITCODE
$ErrorActionPreference = $prev
if (-not $dockerOk) { throw 'Docker is not running. Start Docker Desktop and run this again.' }
if (-not $awsOk) { throw 'The AWS CLI is not signed in (aws sts get-caller-identity failed).' }

# Error reports (cloud/api/sentry.mjs): CDK gives the Lambdas the bridge-cloud project's DSN from SENTRY_DSN_CLOUD, as
# main's Cloud deploy does from its secret. It's an ingest-only key, asked for once and kept in .bridge on this PC;
# Enter skips reports (delete .bridge\sentry-dsn-cloud.txt to be asked again).
if (-not $env:SENTRY_DSN_CLOUD) {
  $dsnFile = Join-Path $env:USERPROFILE '.bridge\sentry-dsn-cloud.txt'
  if (-not (Test-Path $dsnFile)) {
    Write-Host 'Sentry DSN for the bridge-cloud project (Sentry: Settings, Projects, bridge-cloud, Client Keys), or Enter to skip:'
    $dsn = (Read-Host 'DSN').Trim()
    if ($dsn -and $dsn -notmatch '^https://[0-9a-f]+@[A-Za-z0-9.-]+/\d+$') { throw 'That is not a Sentry DSN.' }
    New-Item -ItemType Directory -Force -Path (Split-Path $dsnFile) | Out-Null
    Set-Content -Path $dsnFile -Value $dsn -NoNewline
  }
  $env:SENTRY_DSN_CLOUD = (Get-Content $dsnFile -Raw -ErrorAction SilentlyContinue)
  if ($env:SENTRY_DSN_CLOUD) { $env:SENTRY_DSN_CLOUD = $env:SENTRY_DSN_CLOUD.Trim() }
}
Write-Host "Error reports: $(if ($env:SENTRY_DSN_CLOUD) { 'on' } else { 'off' })."

Push-Location (Join-Path $root 'cloud\infra')
try {
  npm ci
  if ($LASTEXITCODE) { throw 'npm ci failed' }
  Write-Host 'Deploying BridgeApi (the first run builds the runner image; it takes several minutes)...'
  npx cdk deploy BridgeApi --require-approval never
  if ($LASTEXITCODE) { throw 'cdk deploy failed' }
} finally { Pop-Location }

& (Join-Path $PSScriptRoot 'setup-owner.ps1') -RelayDir $RelayDir -SkipLogin:$SkipLogin
