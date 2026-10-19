# Deploys BridgeApi from this checkout (an unmerged branch) from your PC, then runs setup-owner.ps1, to try the
# owner's agents before the PR is merged. Run it from a separate worktree of the branch, not the relay's folder:
#   powershell -ExecutionPolicy Bypass -File <worktree>\cloud\setup\deploy-branch.ps1
# Needs: the AWS CLI signed in as an admin (aws sts get-caller-identity), Docker Desktop running (CDK builds the
# agent runner's image), Node 22 and Claude Code. The next Cloud deploy from main puts main's BridgeApi back,
# which removes the runner again until this branch is merged.
param([string]$RelayDir = (Join-Path $env:USERPROFILE 'Projects\claude-voice-relay'))
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
docker info *> $null; $dockerOk = -not $LASTEXITCODE
aws sts get-caller-identity *> $null; $awsOk = -not $LASTEXITCODE
$ErrorActionPreference = $prev
if (-not $dockerOk) { throw 'Docker is not running. Start Docker Desktop and run this again.' }
if (-not $awsOk) { throw 'The AWS CLI is not signed in (aws sts get-caller-identity failed).' }

Push-Location (Join-Path $root 'cloud\infra')
try {
  npm ci
  if ($LASTEXITCODE) { throw 'npm ci failed' }
  Write-Host 'Deploying BridgeApi (the first run builds the runner image; it takes several minutes)...'
  npx cdk deploy BridgeApi --require-approval never
  if ($LASTEXITCODE) { throw 'cdk deploy failed' }
} finally { Pop-Location }

& (Join-Path $PSScriptRoot 'setup-owner.ps1') -RelayDir $RelayDir
