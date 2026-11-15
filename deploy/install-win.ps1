<#
  Install the cc-remote agent on Windows as a per-USER Scheduled Task (at logon,
  and every few minutes after that so a dead agent comes back - see the task
  registration below for why that repetition is the Windows KeepAlive).

  The agent runs as the logged-in person, in their session, so it can read THEIR
  %USERPROFILE%\.claude (Claude Code) and %USERPROFILE%\.codex (Codex) sessions
  and use their existing logins. That is why this is an at-logon Scheduled Task
  in the user's context, NOT a SYSTEM service (which would see the wrong profile).

  Prereqs: the person already uses Claude Code and/or Codex (logins in place).
  Node is auto-fetched if a suitable one isn't on PATH.

  Run from a downloaded copy of this script. It fetches the current agent
  bundle from the hub when agent.mjs/package.json are not present next to it:
    powershell -ExecutionPolicy Bypass -File .\install-win.ps1 `
      -Name "Anna PC" -EnrollmentCode <ONE_TIME_CODE> [-Url wss://code.acme.test]
#>
param(
  [string]$Token,
  [string]$EnrollmentCode,
  # No credential: the agent asks the hub for a code and this script prints it;
  # approve it on code.acme.test/link from any device where you are signed in.
  [switch]$Link,
  [string]$Name = "$env:USERNAME@$env:COMPUTERNAME",
  [string]$Url  = "wss://code.acme.test",
  [string]$NodeVersion = "v22.11.0",
  # The machine owner's switches (agent/src/policy.ts): -ChatOnly turns off the
  # terminal, file/git writes, process kill, runtime install/login and
  # no-approval modes; -SyncAll keeps the old 'every session syncs'.
  [switch]$ChatOnly,
  [switch]$SyncAll,
  # How long a dead agent may stay dead. Five minutes is the same order as the
  # hub's own inventory staleness, and the check costs nothing when the agent is
  # healthy - the scheduler just drops the firing.
  [int]$KeepAliveMinutes = 5
)
$ErrorActionPreference = "Stop"
if (-not $Link -and -not $Token -and -not $EnrollmentCode) { throw "Pass -EnrollmentCode, -Link or legacy -Token" }
if ($Token -and $EnrollmentCode) { throw "Pass only one of -EnrollmentCode or -Token" }

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:USERPROFILE "cc-remote-agent"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$downloadBase = (($Url -replace '^wss://', 'https://') -replace '^ws://', 'http://').TrimEnd('/')
$localAgent = Join-Path $src "agent.mjs"
$localPackage = Join-Path $src "package.json"
if ((Test-Path $localAgent) -and (Test-Path $localPackage)) {
  Write-Host "[install] copying local agent bundle -> $dest"
  Copy-Item $localAgent (Join-Path $dest "agent.mjs") -Force
  Copy-Item $localPackage (Join-Path $dest "package.json") -Force
} else {
  Write-Host "[install] downloading current agent bundle from $downloadBase"
  Invoke-WebRequest -Uri "$downloadBase/install/agent.mjs" -OutFile (Join-Path $dest "agent.mjs") -UseBasicParsing
  Invoke-WebRequest -Uri "$downloadBase/install/package.json" -OutFile (Join-Path $dest "package.json") -UseBasicParsing
}

# --- resolve a supported Node 20..24 runtime ----------------------------------
function Get-NodeMajor($exe) {
  try { return [int]((& $exe -p "process.versions.node.split('.')[0]") 2>$null) } catch { return 0 }
}
$nodeExe = $null
$sysNode = (Get-Command node -ErrorAction SilentlyContinue)
if ($sysNode) {
  $sysMajor = Get-NodeMajor $sysNode.Source
  if ($sysMajor -ge 20 -and $sysMajor -lt 25) { $nodeExe = $sysNode.Source }
}
$vendored = Join-Path $dest "node\node.exe"
if (-not $nodeExe -and (Test-Path $vendored)) {
  $vendoredMajor = Get-NodeMajor $vendored
  if ($vendoredMajor -ge 20 -and $vendoredMajor -lt 25) { $nodeExe = $vendored }
}
if (-not $nodeExe) {
  $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
  $zip  = "node-$NodeVersion-win-$arch.zip"
  Write-Host "[install] no supported Node 20..24 found - fetching portable $NodeVersion ($arch)"
  $tmp = Join-Path $env:TEMP $zip
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/$zip" -OutFile $tmp -UseBasicParsing
  } catch { throw "Could not download Node. Install Node 20..24 and re-run. ($_)" }
  if (Test-Path (Join-Path $dest "node")) { Remove-Item -Recurse -Force (Join-Path $dest "node") }
  Expand-Archive -Path $tmp -DestinationPath $dest -Force
  Rename-Item (Join-Path $dest "node-$NodeVersion-win-$arch") (Join-Path $dest "node")
  $nodeExe = $vendored
}
$nodeDir = Split-Path -Parent $nodeExe
Write-Host "[install] node: $nodeExe ($(& $nodeExe --version))"

Write-Host "[install] npm install (2 runtime deps: sdk, node-pty)"
Push-Location $dest
$env:PATH = "$nodeDir;$env:PATH"
& (Join-Path $nodeDir "npm.cmd") install --omit=dev --no-audit --no-fund 2>&1 | Out-File "$env:TEMP\ccr-install.log"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install failed - see $env:TEMP\ccr-install.log" }
Pop-Location

# --- what this machine allows (~/.cc-remote/policy.json) ------------------------
# A NEW machine syncs nothing until its owner picks folders or starts a session
# in one; a reinstall keeps whatever was chosen.
$stateDir = Join-Path $env:USERPROFILE ".cc-remote"
$agentMjs = Join-Path $dest "agent.mjs"
if (-not (Test-Path (Join-Path $stateDir "policy.json")) -and -not (Test-Path (Join-Path $stateDir "agent.json")) -and -not $SyncAll) {
  & $nodeExe $agentMjs policy sync selected | Out-Null
}
if ($SyncAll) { & $nodeExe $agentMjs policy sync all | Out-Null }
if ($ChatOnly -or $env:HEGAI_CHAT_ONLY -eq "1") { & $nodeExe $agentMjs policy chat-only on | Out-Null }

# --- launcher .cmd (sets env, then runs the agent) -----------------------------
#
# This file is written 7-bit ASCII on purpose, and that has a cost worth naming.
# It has TWO readers that disagree about encoding: cmd.exe reads it in the
# console's OEM codepage (866 on a Russian Windows), and the Hegai Code tray app
# parses it as STRICT UTF-8 (`read_to_string` in
# windows/src-tauri/src/agent/config.rs - non-UTF-8 bytes there are not mojibake,
# they are "launcher unreadable, agent cannot start"). ASCII is the only encoding
# both read identically.
#
# PowerShell's ASCII encoder maps every character it cannot represent to a
# literal '?'. So a Cyrillic `-Name` (e.g. "Rabochiy kompyuter", spelled in
# Cyrillic on the box where this was found) used to be written here as
# `set "MACHINE_NAME=??????? ?????????"`, and that is what the hub stored and
# every client showed - the machine's whole identity replaced by question marks
# (found 18.09.2026 on Marat's box).
#
# The name therefore travels base64'd: ASCII in the file, UTF-8 after the agent
# decodes it (agent/src/config.ts). A plain MACHINE_NAME is still written when
# the name is already ASCII - it keeps the file readable by a human and keeps an
# older agent bundle working.
$runCmd = Join-Path $dest "run-agent.cmd"
$ascii = '^[\x20-\x7E]*$'

# PATHS have no base64 escape hatch - cmd.exe needs them literal. A Cyrillic
# %USERPROFILE% would be written as '?', and the launcher would point at a
# directory that does not exist: an install that prints OK and never starts.
# Fail here instead, where the message is still on screen.
foreach ($p in @($dest, $nodeExe)) {
  if ($p -notmatch $ascii) {
    throw "Path contains non-ASCII characters, which run-agent.cmd cannot carry: $p`nInstall the agent under a profile whose path is ASCII-only."
  }
}

$nameB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Name))
$nameLines = "set `"MACHINE_NAME_B64=$nameB64`""
if ($Name -match $ascii) { $nameLines = "set `"MACHINE_NAME=$Name`"`r`n$nameLines" }
$credentialLine = if ($EnrollmentCode) { "set `"CC_REMOTE_ENROLLMENT_CODE=$EnrollmentCode`"" } elseif ($Token) { "set `"CC_REMOTE_TOKEN=$Token`"" } else { "rem no credential: the agent asks the hub for a connection code (link mode)" }
@"
@echo off
$credentialLine
set "CENTRAL_URL=$Url"
$nameLines
"$nodeExe" "$dest\agent.mjs" >> "$dest\agent.log" 2>&1
"@ | Set-Content -Encoding ASCII $runCmd

# --- windowless wrapper --------------------------------------------------------
#
# The task must not put a console on screen. An Exec action pointed at a .cmd
# runs it through the console host in the INTERACTIVE session, so every firing
# flashes a window - and a window appearing, even for a second, takes the screen
# from a fullscreen game. On buildbox-pc that was one interruption every
# KeepAliveMinutes, all day (found 05.09.2026, caught in the act: the foreground
# window changed to a short-lived cmd.exe at the exact second the task fired).
#
# It fires that often only when the agent was started by SOMETHING ELSE - the
# Hegai Code app supervises it too. See the note on the keepalive below: the
# IgnoreNew guard covers a firing that lands on a live TASK INSTANCE, not one
# that lands on a live agent someone else started, and then run-agent.cmd starts
# a node that exits immediately because the machine is already claimed.
#
# wscript is a GUI-subsystem host, so it gets no console of its own, and window
# style 0 hides the cmd it launches.
$runVbs = Join-Path $dest "run-agent-hidden.vbs"
@"
' Zapusk agenta BEZ konsolnogo okna. Sozdayotsya install-win.ps1 - pravit zdes.
'
' bWaitOnReturn = True - OBYAZATELNO, na nyom derzhitsya vsya keepalive-shema:
' wscript blokiruetsya, poka zhiv agent, poetomu zadacha stoit v sostoyanii
' Running i MultipleInstances=IgnoreNew molcha otbrasyvaet kazhdoe srabatyvanie,
' popavshee na zhivoy agent. S False wscript vyhodil by srazu, zadacha
' zavershalas by, i keepalive podnimal by NOVYY agent kazhdye neskolko minut -
' dva pisatelya v odin transkript, to est to, chto zapreshcheno pravilom N1.
Dim sh
Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run("""$runCmd""", 0, True)
"@ | Set-Content -Encoding ASCII $runVbs

# --- register the Scheduled Task (current user) --------------------------------
#
# TWO triggers, and the second one is the whole point. Windows used to be the
# only platform in the fleet with no restart-on-failure:
#
#   macOS   launchd, KeepAlive true      deploy/install-mac.sh
#   Linux   systemd, Restart=always      deploy/cc-remote-agent.service
#   Windows schtasks /SC ONLOGON         - nothing
#
# A dead agent stayed dead until the next logon. buildbox-pc spent 16 hours out
# of the fleet that way on 31.08.2026, after the agent caught a Ctrl-C.
#
# The repetition trigger IS the KeepAlive, and it works because `run-agent.cmd`
# BLOCKS for as long as the agent lives: the task instance is "Running" exactly
# while the agent is up, so MultipleInstances=IgnoreNew silently drops every
# firing that lands on a healthy agent. When the agent dies the instance ends,
# and the next firing starts it again. No service, no supervisor process, and
# nothing to install - the scheduler already had the semantics.
#
# It is a second, separate trigger rather than repetition attached to the logon
# one on purpose: repetition on a logon trigger only starts after a logon fires,
# so a machine that was already logged in when the agent died would wait for the
# next login - the exact hole being closed.
#
# CAVEAT, and it is the reason the action goes through a hidden wrapper above:
# IgnoreNew drops a firing that lands on a live TASK INSTANCE. It says nothing
# about an agent started by someone else - and on Windows the Hegai Code app
# supervises the same agent. When the app started it, this task has no instance
# to collide with, so it fires on every interval, run-agent.cmd starts a node
# that exits at once, and the instance ends. Harmless, but it happens forever,
# so it must happen INVISIBLY.
$taskName = "cc-remote-agent"
Write-Host "[install] registering Scheduled Task '$taskName' (at logon + keepalive every ${KeepAliveMinutes}m)"
$action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$runVbs`""
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# No -RepetitionDuration: omitting it means "repeat indefinitely". Do NOT pass
# [TimeSpan]::MaxValue for that - the scheduler rejects the task outright
# ("P99999999DT23H59M59S ... out of range").
$keepAlive = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $KeepAliveMinutes)
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero)   # PT0S = no limit; the agent is a daemon
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $keepAlive) `
  -Settings $settings -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Host "[install] OK agent '$Name' -> $Url  (task: $state)"
Write-Host "[install]    logs: $dest\agent.log"

# --- link mode: show the code the agent asked for -------------------------------
$agentJson = Join-Path $env:USERPROFILE ".cc-remote\agent.json"
$hasToken = (Test-Path $agentJson) -and (Select-String -Path $agentJson -Pattern '"deviceToken"' -Quiet)
if ($Link -and -not $hasToken) {
  $log = Join-Path $dest "agent.log"
  for ($i = 0; $i -lt 40; $i++) {
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern "/link" -Quiet)) { break }
    Start-Sleep -Seconds 1
  }
  Write-Host ""
  Get-Content $log -Encoding UTF8 | Select-String -Pattern "\[agent\] [|\u250c\u2502\u2514]" | Select-Object -Last 4 | ForEach-Object { $_.Line -replace '^\[agent\] ', '' } | Write-Host
  Write-Host ""
  Write-Host "[install] Confirm the code on the site - from this computer or your phone. The machine will appear in "Machines" by itself."
}
