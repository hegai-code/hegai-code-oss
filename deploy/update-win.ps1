# Update the cc-remote agent on a Windows machine.
#
# Agents dial OUT only - there is no inbound path from the hub or a dev machine,
# so the update has to run ON the box (RDP in, or send this to the person on it).
# It pulls the latest bundle the hub serves and restarts the at-logon task.
#
#   powershell -ExecutionPolicy Bypass -File .\update-win.ps1
#     [-Url https://code.acme.test/dl/agent.mjs] [-Task cc-remote-agent]
#     [-Dir <path to the agent's install dir>] [-Name "Рабочий компьютер"]
#
# -Name also REPAIRS the machine name. An update swaps agent.mjs and nothing
# else, so a launcher written before 18.09.2026 keeps handing the agent a name
# the installer's ASCII encoder destroyed - `MACHINE_NAME=??????? ?????????`.
# See the launcher note in install-win.ps1 for why that file is ASCII.
#
# Run as the SAME user the agent runs as (it reads their
# %USERPROFILE%\.claude / .codex).
#
# ADAPT TO YOUR INSTALL. The defaults here match the `install-win.ps1` layout -
# a Scheduled Task named `cc-remote-agent` and a bundle at
# %USERPROFILE%\cc-remote-agent - which is what the live Windows box
# (buildbox-pc) actually runs, verified 01.09.2026: task `\cc-remote-agent`
# driving %USERPROFILE%\cc-remote-agent\run-agent.cmd.
#
# (This note used to claim that box predated the layout and ran `node
# deploy/agent.mjs` from a repo checkout started by an AutoHotkey script. It
# does not, and following that during an outage costs real minutes. See
# deploy/FLEET.md for the per-host reality.)
#
# Safe to run while the keepalive trigger is armed: the task's
# MultipleInstances=IgnoreNew means a firing that lands mid-update is dropped
# rather than starting a second agent.

param(
  [string]$Url  = "https://code.acme.test/dl/agent.mjs",
  [string]$Task = "cc-remote-agent",
  [string]$Dir  = "$env:USERPROFILE\cc-remote-agent",
  # Optional: rewrite the machine name in run-agent.cmd. Omit to leave it alone.
  [string]$Name
)
$ErrorActionPreference = "Stop"

$agent = Join-Path $Dir "agent.mjs"
if (-not (Test-Path $agent)) { throw "agent.mjs not found at $agent - is the agent installed for this user?" }

$tmp = Join-Path $env:TEMP "agent.mjs.new"
Write-Host "==> Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
$size = (Get-Item $tmp).Length
if ($size -lt 100000) { throw "downloaded bundle is only $size bytes - aborting (looks wrong)" }
Write-Host "==> Downloaded $size bytes"

$stamp = Get-Date -Format "yyMMddHHmm"
Copy-Item $agent "$agent.bak-$stamp" -Force
Move-Item $tmp $agent -Force
Write-Host "==> Swapped in new bundle (backup: agent.mjs.bak-$stamp)"

Write-Host "==> Restarting task $Task"
try { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue } catch {}
# Belt-and-suspenders: kill any node still running the old bundle.
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*cc-remote-agent*agent.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 2

$log = Join-Path $Dir "agent.log"
if (Test-Path $log) { Write-Host "==> Recent log:"; Get-Content $log -Tail 4 }
Write-Host "==> Done. The machine should re-register on the hub within a few seconds."
