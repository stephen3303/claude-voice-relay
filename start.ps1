# Started at logon by the ClaudeVoiceRelay scheduled task.
# Starts the relay right away: Docker is only needed when an agent launches,
# and a hung Docker engine must not keep the relay (and its voice endpoint) down.
# If the relay exits or is killed, it is restarted after a short pause.
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force logs | Out-Null
while ($true) {
  node --env-file=.env relay.mjs *>> logs\console.log
  "[$((Get-Date).ToUniversalTime().ToString('o'))] relay exited (code $LASTEXITCODE); restarting in 10s" *>> logs\console.log
  Start-Sleep -Seconds 10
}
