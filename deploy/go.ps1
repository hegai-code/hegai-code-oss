# Hegai Code - connect this computer with one command (PowerShell):
#
#   irm https://code.acme.test/go.ps1 | iex
#
# Installs the agent as a Scheduled Task with no credential. The agent then
# asks the hub for a short code and this script prints it: approve it on
# https://code.acme.test/link from any device where you are signed in.
# Re-running is safe: a connected machine keeps its credential.
$ErrorActionPreference = 'Stop'
$base = if ($env:HEGAI_URL) { $env:HEGAI_URL } else { 'https://code.acme.test' }
$ws = 'wss://' + $base.Substring(8)
$installer = Join-Path $env:TEMP 'cc-remote-install.ps1'
Invoke-WebRequest "$base/install/install-win.ps1" -OutFile $installer
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Link -Url $ws
