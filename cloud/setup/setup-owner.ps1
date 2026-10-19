# Moves your own Bridge use from the relay on this PC to Bridge Cloud (cloud/api/owner.mjs, cloud/runner).
# Run it once after the BridgeApi stack with the agent runner is deployed, and again to add projects or
# replace the claude.ai login:
#   powershell -ExecutionPolicy Bypass -File cloud\setup\setup-owner.ps1
# It stores, straight from this PC to AWS (never through chat or the repo):
#   bridge/owner         the SHA-256 of your owner token: by default the relay's VOICE_TOKEN, so the app keeps its token
#   bridge/owner-claude  a claude.ai login made just for Bridge Cloud (a browser window opens), plus the relay's
#                        project routine and ntfy settings from its .env
#   PROJECT# items       one per git folder in your projects folder, so "in <project>, ..." works as it did
# Then point the app at Bridge Cloud: Settings, relay address, set it to the address this script prints.
param(
  [string]$ProjectsRoot = (Join-Path $env:USERPROFILE 'Projects'),
  [string]$RelayDir = '',
  [switch]$SkipLogin,
  [switch]$SkipProjects
)
$ErrorActionPreference = 'Stop'
$region = 'us-east-1'
if (-not $RelayDir) { $RelayDir = Join-Path $ProjectsRoot 'claude-voice-relay' }

# A native command's exit code, ignoring what it writes to stderr: under 'Stop', Windows PowerShell 5.1 turns a
# redirected stderr line into an error that ends the script.
function Quiet-Exit([scriptblock]$cmd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $cmd *> $null; $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
}
# git's first line of output, or $null when it fails.
function Git-Line([string]$dir, [string[]]$gitArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $dir @gitArgs 2>$null
    if ($LASTEXITCODE) { return $null }
    return [string]($out | Select-Object -First 1)
  } finally { $ErrorActionPreference = $prev }
}

function Save-Secret([string]$name, [string]$json) {
  $file = New-TemporaryFile
  try {
    Set-Content -Path $file -Value $json -NoNewline
    if (Quiet-Exit { aws secretsmanager describe-secret --region $region --secret-id $name }) {
      aws secretsmanager create-secret --region $region --name $name --secret-string "file://$file" | Out-Null
    } else {
      aws secretsmanager put-secret-value --region $region --secret-id $name --secret-string "file://$file" | Out-Null
    }
    if ($LASTEXITCODE) { throw "Saving $name failed" }
  } finally { Remove-Item $file -Force }
}

# The relay's .env, as name -> value (only the names asked for).
function Read-Env([string[]]$names) {
  $out = @{}
  $envFile = Join-Path $RelayDir '.env'
  if (-not (Test-Path $envFile)) { return $out }
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$' -and $names -contains $Matches[1]) {
      $out[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
    }
  }
  $out
}

# ---------- where Bridge Cloud is ----------
$stack = aws cloudformation describe-stacks --region $region --stack-name BridgeApi --output json | ConvertFrom-Json
if ($LASTEXITCODE) { throw 'Could not read the BridgeApi stack. Is the AWS CLI signed in (aws sts get-caller-identity)?' }
$outputs = @{}
foreach ($o in $stack.Stacks[0].Outputs) { $outputs[$o.OutputKey] = $o.OutputValue }
if (-not $outputs['TableName']) { throw 'BridgeApi has no agent runner yet. Deploy the branch with the runner first.' }
$apiUrl = $outputs['ApiUrl']
$table = $outputs['TableName']
$relayEnv = Read-Env @('VOICE_TOKEN', 'BRIDGE_ROUTINE_URL', 'BRIDGE_ROUTINE_TOKEN', 'NTFY_URL', 'NTFY_TOKEN')

# ---------- owner token ----------
$token = $relayEnv['VOICE_TOKEN']
$newToken = $false
if (-not $token -or $token -notmatch '^[A-Za-z0-9_-]{24,512}$') {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $newToken = $true
}
$sha = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
$hash = -join ($sha | ForEach-Object { $_.ToString('x2') })
Save-Secret 'bridge/owner' (@{ tokenHash = $hash } | ConvertTo-Json -Compress)
Write-Host 'Saved bridge/owner (the token''s hash only).'

# ---------- a claude.ai login for Bridge Cloud ----------
# Its own sign-in, in a throwaway folder: sharing this PC's login would break one of them each time the
# other refreshed it.
if (-not $SkipLogin) {
  $dir = Join-Path ([IO.Path]::GetTempPath()) ("bridge-claude-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir | Out-Null
  $before = $env:CLAUDE_CONFIG_DIR
  try {
    $env:CLAUDE_CONFIG_DIR = $dir
    Write-Host 'Sign in to claude.ai in the browser window (the account whose subscription the agents should use).'
    claude auth login --claudeai
    if ($LASTEXITCODE) { throw 'claude auth login failed' }
    $credFile = Join-Path $dir '.credentials.json'
    if (-not (Test-Path $credFile)) { throw "No login was saved in $dir. Update Claude Code and try again." }
    $secret = @{ credentials = (Get-Content $credFile -Raw | ConvertFrom-Json) }
    $config = Join-Path $dir '.claude.json'
    if (Test-Path $config) {
      $account = (Get-Content $config -Raw | ConvertFrom-Json).oauthAccount
      if ($account) { $secret.oauthAccount = $account }
    }
    if ($relayEnv['BRIDGE_ROUTINE_URL']) { $secret.routineUrl = $relayEnv['BRIDGE_ROUTINE_URL']; $secret.routineToken = $relayEnv['BRIDGE_ROUTINE_TOKEN'] }
    if ($relayEnv['NTFY_URL']) { $secret.ntfyUrl = $relayEnv['NTFY_URL']; $secret.ntfyToken = $relayEnv['NTFY_TOKEN'] }
    Save-Secret 'bridge/owner-claude' ($secret | ConvertTo-Json -Compress -Depth 10)
    Write-Host 'Saved bridge/owner-claude.'
  } finally {
    $env:CLAUDE_CONFIG_DIR = $before
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---------- projects ----------
# Each git folder with a GitHub origin becomes a project named as the relay says it ("trading-bot" -> "trading bot"),
# plus the relay's aliases.json names that point at it.
if (-not $SkipProjects) {
  $aliases = @{}
  $aliasFile = Join-Path $RelayDir 'aliases.json'
  if (Test-Path $aliasFile) {
    $a = Get-Content $aliasFile -Raw | ConvertFrom-Json
    foreach ($p in $a.PSObject.Properties) {
      $folder = Split-Path ([string]$p.Value) -Leaf
      if (-not $aliases[$folder]) { $aliases[$folder] = @() }
      $aliases[$folder] += [string]$p.Name
    }
  }
  $count = 0
  foreach ($d in Get-ChildItem $ProjectsRoot -Directory | Where-Object { -not $_.Name.StartsWith('.') }) {
    if (-not (Test-Path (Join-Path $d.FullName '.git'))) { continue }
    $url = Git-Line $d.FullName @('remote', 'get-url', 'origin')
    if (-not $url -or $url -notmatch 'github\.com[:/]([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)(\.git)?/?$') { continue }
    $repo = "$($Matches[1])/$($Matches[2])"
    $branch = Git-Line $d.FullName @('rev-parse', '--abbrev-ref', 'HEAD')
    if (-not $branch -or $branch -eq 'HEAD') { $branch = '' }
    $name = ($d.Name -replace '[_\-.]+', ' ').Trim()
    $key = ($name.ToLower() -replace '[^a-z0-9]', '')
    $item = @{
      pk = @{ S = 'USER#owner' }; sk = @{ S = "PROJECT#$key" }
      name = @{ S = $name }; repo = @{ S = $repo }; branch = @{ S = [string]$branch }
    }
    if ($aliases[$d.Name]) { $item.aliases = @{ L = @($aliases[$d.Name] | ForEach-Object { @{ S = $_ } }) } }
    $file = New-TemporaryFile
    try {
      Set-Content -Path $file -Value ($item | ConvertTo-Json -Compress -Depth 6) -NoNewline
      aws dynamodb put-item --region $region --table-name $table --item "file://$file" | Out-Null
      if ($LASTEXITCODE) { throw "Saving project $name failed" }
    } finally { Remove-Item $file -Force }
    Write-Host "Project: $name ($repo$(if ($branch) { ", $branch" }))"
    $count++
  }
  Write-Host "Saved $count projects."
}

Write-Host ''
Write-Host 'Done. In the Bridge app, open Settings and set the relay address to:'
Write-Host "  $apiUrl/api"
if ($newToken) {
  Set-Clipboard -Value $token
  Write-Host 'and the relay token to the new owner token, which is on your clipboard now (it is not shown or saved anywhere else).'
} else {
  Write-Host 'The relay token stays the same (your VOICE_TOKEN).'
}
