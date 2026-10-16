# Started at logon by the ClaudeVoiceRelay scheduled task.
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force logs | Out-Null
# Wait for Docker Desktop so agent containers can start.
for ($i = 0; $i -lt 60; $i++) { docker info *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 5 }
node --env-file=.env relay.mjs *>> logs\console.log
