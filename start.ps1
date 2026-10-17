# Started at logon by the ClaudeVoiceRelay scheduled task.
# Starts the relay right away: Docker is only needed when an agent launches,
# and a hung Docker engine must not keep the relay (and its voice endpoint) down.
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force logs | Out-Null
node --env-file=.env relay.mjs *>> logs\console.log
