# Moves your own Bridge use from the relay on this PC to Bridge Cloud (cloud/api/owner.mjs, cloud/runner).
# Run it once after the BridgeApi stack with the agent runner is deployed, and again to add projects or
# replace the claude.ai login:
#   powershell -ExecutionPolicy Bypass -File cloud\setup\setup-owner.ps1
# It stores, straight from this PC to AWS (never through chat or the repo):
#   bridge/owner         the SHA-256 of your owner token: by default the relay's VOICE_TOKEN, so the app keeps its token,
#                        and your Apple account id, so the Claude connector reaches your agents (-AppleAccount to re-pick)
#   bridge/owner-claude  a claude.ai login made just for Bridge Cloud (a browser window opens), plus the relay's
#                        project routine and ntfy settings from its .env
#   bridge/owner-routine the claude.ai routine new tasks start as ({ url, token }), asked for once (-TaskRoutine to replace it)
#   PROJECT# items       one per git folder in your projects folder, so "in <project>, ..." works as it did,
#                        with a tag from the name's initials (the orchestrator's registry)
# Then point the app at Bridge Cloud: Settings, relay address, set it to the address this script prints.
param(
  [string]$ProjectsRoot = (Join-Path $env:USERPROFILE 'Projects'),
  [string]$RelayDir = '',
  [switch]$SkipLogin,
  [switch]$SkipProjects,
  [switch]$TaskRoutine,
  [switch]$AppleAccount
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
if (-not $token -or $token -notmatch '^[\x21-\x7e]{24,512}$') {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $newToken = $true
}
$sha = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
$hash = -join ($sha | ForEach-Object { $_.ToString('x2') })

# ---------- your Apple account, for the Claude connector ----------
# The connector signs in with Sign in with Apple, as Bridge account "apple.<id>". Saving yours here lets Claude on
# claude.ai reach your agents too. Picked from the accounts that connected Claude, by when they did.
$appleSub = $null
if (-not (Quiet-Exit { aws secretsmanager describe-secret --region $region --secret-id 'bridge/owner' })) {
  $appleSub = (aws secretsmanager get-secret-value --region $region --secret-id 'bridge/owner' --query SecretString --output text | ConvertFrom-Json).appleSub
}
if ($AppleAccount -or -not $appleSub) {
  $values = New-TemporaryFile
  try {
    Set-Content -Path $values -Value '{":u":{"S":"USER#apple."},":rt":{"S":"RT#"}}' -NoNewline
    $scan = aws dynamodb scan --region $region --table-name $table --output json `
      --filter-expression 'begins_with(pk, :u) AND begins_with(sk, :rt)' --expression-attribute-values "file://$values" | ConvertFrom-Json
    if ($LASTEXITCODE) { throw 'Could not read the Claude connector sign-ins.' }
  } finally { Remove-Item $values -Force }
  $seen = @{}
  foreach ($i in $scan.Items) {
    $sub = $i.pk.S.Substring('USER#'.Length)
    $at = [long]$i.data.M.auth_time.N
    if (-not $seen.ContainsKey($sub) -or $seen[$sub] -lt $at) { $seen[$sub] = $at }
  }
  $accounts = @($seen.GetEnumerator() | Sort-Object Value -Descending)
  if (-not $accounts.Count) {
    Write-Host 'No Apple account has connected Bridge in Claude yet. Connect it in Claude (Settings, Connectors), then run this again with -AppleAccount.'
  } else {
    Write-Host ''
    Write-Host 'Accounts that connected Bridge in Claude, newest first. Which one is you?'
    for ($n = 0; $n -lt $accounts.Count; $n++) {
      $when = [DateTimeOffset]::FromUnixTimeSeconds($accounts[$n].Value).LocalDateTime.ToString('ddd d MMM yyyy, h:mm tt')
      $id = $accounts[$n].Key
      Write-Host "  $($n + 1). connected $when (account ending $($id.Substring([Math]::Max(0, $id.Length - 6))))"
    }
    $pick = (Read-Host 'Number (Enter to skip)').Trim()
    if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $accounts.Count) {
      $appleSub = $accounts[[int]$pick - 1].Key
    } elseif ($pick) { throw 'That is not one of the numbers.' }
  }
}
$owner = @{ tokenHash = $hash }
if ($appleSub) { $owner.appleSub = $appleSub }
Save-Secret 'bridge/owner' ($owner | ConvertTo-Json -Compress)
Write-Host "Saved bridge/owner (the token's hash only$(if ($appleSub) { ', and your Apple account for the Claude connector' }))."

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

# ---------- the task routine ----------
# Claude Code can't start a new cloud session from a script, so each new task fires this routine with the task as
# its text. Its URL and token are typed here, never pasted into chat.
if ($TaskRoutine -or (Quiet-Exit { aws secretsmanager describe-secret --region $region --secret-id 'bridge/owner-routine' })) {
  Set-Clipboard -Value (Get-Content (Join-Path $PSScriptRoot 'task-routine-prompt.txt') -Raw)
  Write-Host ''
  Write-Host 'Set up the Bridge task routine (the routine prompt is on your clipboard now):'
  Write-Host '  1. Open https://claude.ai/code/routines and click New task. If a menu opens, pick Set up manually.'
  Write-Host '  2. Name it Bridge task, and paste the prompt from your clipboard.'
  Write-Host '  3. Add the API trigger. Under Advanced settings, select every repository you will talk to.'
  Write-Host '  4. Click Create, and copy the token it shows (it is shown once). Then copy the Fire URL from the API trigger.'
  $url = (Read-Host 'Fire URL').Trim()
  if ($url -notmatch '^https://api\.anthropic\.com/v1/claude_code/routines/trig_[A-Za-z0-9_-]{1,64}/fire$') { throw 'That is not a routine Fire URL.' }
  Write-Host 'Token (right-click to paste; nothing shows as you paste):'
  $secure = Read-Host -AsSecureString
  $routineToken = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
  if (-not $routineToken) { throw 'No token was pasted.' }
  Save-Secret 'bridge/owner-routine' (@{ url = $url; token = $routineToken } | ConvertTo-Json -Compress)
  Write-Host 'Saved bridge/owner-routine.'
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
    # The tag thread titles use ([CVR] for claude voice relay): the words' initials, or a one-word name's first three letters.
    $words = @($name -split '\s+' | Where-Object { $_ })
    $tag = if ($words.Count -gt 1) { -join ($words | ForEach-Object { $_.Substring(0, 1) }) } else { $name.Substring(0, [Math]::Min(3, $name.Length)) }
    $item = @{
      pk = @{ S = 'USER#owner' }; sk = @{ S = "PROJECT#$key" }
      name = @{ S = $name }; repo = @{ S = $repo }; branch = @{ S = [string]$branch }; tag = @{ S = $tag.ToUpper() }
    }
    if ($aliases[$d.Name]) { $item.aliases = @{ L = @($aliases[$d.Name] | ForEach-Object { @{ S = $_ } }) } }
    $file = New-TemporaryFile
    try {
      Set-Content -Path $file -Value ($item | ConvertTo-Json -Compress -Depth 6) -NoNewline
      aws dynamodb put-item --region $region --table-name $table --item "file://$file" | Out-Null
      if ($LASTEXITCODE) { throw "Saving project $name failed" }
    } finally { Remove-Item $file -Force }
    Write-Host "Project: $name [$($tag.ToUpper())] ($repo$(if ($branch) { ", $branch" }))"
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
