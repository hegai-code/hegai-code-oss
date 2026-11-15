# Register the nightly runtime update as a Scheduled Task on a Windows fleet
# machine. Codex only — see the header of update-runtimes-win.ps1 for why the
# Claude SDK is deliberately left out on the one box with no inbound path.
#
# Run it through the machine's own agent terminal (server/src/cli/term-run.ts);
# there is no SSH to these boxes by design.
#
#   powershell -ExecutionPolicy Bypass -File install-runtime-updater-win.ps1
#   powershell -ExecutionPolicy Bypass -File install-runtime-updater-win.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$taskName = 'cc-remote-runtimes'
$dir      = Join-Path $env:USERPROFILE 'cc-remote-agent'
$script   = Join-Path $dir 'update-runtimes-win.ps1'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "снято: $taskName"
  exit 0
}

# Always refresh the updater itself, so a machine that has drifted gets the
# current one rather than whatever it was installed with.
Invoke-WebRequest -UseBasicParsing 'https://code.acme.test/dl/update-runtimes-win.ps1' -OutFile $script
if (-not (Test-Path $script)) { throw "не скачался $script" }

# Same staggering idea as the systemd/launchd installers: a stable hash of the
# machine name, so the fleet does not all wake at once and the same box always
# lands on the same minute — a time that moves every install is a time nobody
# can correlate a failure with.
$h = 0; foreach ($c in [char[]]$env:COMPUTERNAME) { $h = ($h * 31 + [int]$c) % 100000 }
$hour = 3 + ($h % 3)
$min  = [math]::Floor($h / 7) % 60
$at   = Get-Date -Hour $hour -Minute $min -Second 0

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $at
# StartWhenAvailable: this is a desktop that sleeps. Without it a machine that
# was off at 3am simply skips the update forever, which is the failure mode the
# whole exercise exists to end.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'cc-remote: ночное обновление codex' -Force | Out-Null

$t = Get-ScheduledTask -TaskName $taskName
Write-Output ("поставлено: {0} -> {1:D2}:{2:D2} ежедневно, состояние {3}" -f $taskName, $hour, $min, $t.State)
Write-Output ("лог: {0}" -f (Join-Path $dir 'runtimes-update.log'))
