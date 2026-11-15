# Update the Claude Agent SDK (and with it the bundled claude.exe) under a
# Windows agent - the supervised change deploy/update-runtimes-win.ps1 refuses
# to automate. First done this way on buildbox-pc 28.09.2026 (0.3.220 -> 0.3.283).
#
# Run it DETACHED, never in the foreground of the agent's own terminal: the
# swap stops the agent, the agent owns that terminal, and term-run gives up
# after 180 s anyway. From dev-box-1:
#
#   deploy/term.sh buildbox-pc 20 'Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File C:\Users\buildbox\update-sdk-win.ps1 -Version 0.3.283"'
#   deploy/term.sh buildbox-pc 15 'Get-Content $env:USERPROFILE\cc-remote-sdk-update.log -Tail 20'
#
# (put the file there first - CAPABILITIES.md section 3.7 shows how). -DryRun stages
# and checks everything and stops before touching the agent.
#
# Steps, each one a lesson:
#  1. npm install into a SEPARATE directory. The running agent is not touched.
#  2. The platform binary (claude-agent-sdk-win32-x64, ~110 MB tgz) is an
#     OPTIONAL dependency. On buildbox's link (150-250 KB/s) npm hits its fetch
#     timeout, drops the package silently and still prints "added N packages",
#     exit 0. So the binary is fetched with curl.exe (resumable), checked
#     against the registry's sha512 and unpacked by hand when npm lost it.
#  3. The whole node_modules is swapped, not just @anthropic-ai: 0.3.220 ->
#     0.3.283 moved 17 packages (zod, @anthropic-ai/sdk, hono, MCP sdk, ...).
#     It can only be renamed with the agent stopped: node-pty's .node is mapped.
#  4. Restart through the Scheduled Task; proof is "[agent] connected" in a log
#     written AFTER the swap. No proof in 150 s -> old node_modules back.
param([Parameter(Mandatory = $true)][string]$Version, [switch]$DryRun)
# A bare semver only: the value becomes an npm spec, and `github:x/y` or a URL
# there would install arbitrary code before any check below could object.
if ($Version -notmatch '^\d+\.\d+\.\d+$') { Write-Output "bad -Version '$Version' (want x.y.z)"; exit 64 }
$ErrorActionPreference = 'Continue'
$ag  = "$env:USERPROFILE\cc-remote-agent"
$st  = "$env:USERPROFILE\cc-remote-sdk-stage-$Version"
$log = "$env:USERPROFILE\cc-remote-sdk-update.log"
function Say($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Ver($dir) { try { (Get-Content "$dir\package.json" -Raw -EA Stop | ConvertFrom-Json).version } catch { $null } }
function AgentProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'cc-remote-agent\\agent\.mjs' }) }
function StopAgent {
  Stop-ScheduledTask -TaskName cc-remote-agent -EA SilentlyContinue
  AgentProcs | % { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
}
function StartAgent { Start-ScheduledTask -TaskName cc-remote-agent -EA SilentlyContinue }
$script:agentLogLen = 0
# Remember where agent.log ends RIGHT BEFORE a start: only a "connected" written
# after that counts. Taken once up front, it let the OLD agent's connect (the
# Hegai Code app restarts it between stop and rename) pass as the new one's.
function MarkLog { try { $script:agentLogLen = (Get-Content "$ag\agent.log" -Raw -EA Stop).Length } catch { $script:agentLogLen = 0 } }
function StartAndProve($secs) { MarkLog; $t = Get-Date; StartAgent; return (WaitConnected $t $secs) }
# Park a tree in ANOTHER folder: Rename-Item cannot, Move-Item can.
function Park($from, $to) {
  for ($i = 0; $i -lt 15 -and (Test-Path $from); $i++) {
    try { Move-Item $from $to -ErrorAction Stop; return $true }
    catch { Say "park try ${i}: $($_.Exception.Message)"; StopAgent; Start-Sleep 1 }
  }
  return -not (Test-Path $from)
}
function WaitConnected($since, $secs) {
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep 5
    foreach ($f in @(Get-ChildItem "$ag\logs\agent-*.log" -EA SilentlyContinue | ? { $_.CreationTime -gt $since })) {
      if (Select-String -Path $f.FullName -Pattern '\[agent\] connected' -Quiet) { return $f.Name }
    }
    try {  # the app's own supervisor writes agent.log instead
      $txt = Get-Content "$ag\agent.log" -Raw -EA Stop
      if ($txt.Length -gt $script:agentLogLen -and $txt.Substring($script:agentLogLen) -match '\[agent\] connected') { return 'agent.log' }
    } catch {}
  }
  return $null
}

Say "=== update-sdk-win $Version$(if ($DryRun) { ' (dry run)' })"
$an = "$ag\node_modules\@anthropic-ai"
$oldVer = Ver "$an\claude-agent-sdk"
Say "installed: $oldVer"
if ($oldVer -eq $Version) { Say 'already there'; exit 0 }
$old = "$ag\node_modules.old-$oldVer"
if (Test-Path $old) { Say "ABORT: $old exists (an earlier swap left it) - look before retrying"; exit 1 }

# 1. stage
if (-not (Test-Path "$st\node_modules\@anthropic-ai\claude-agent-sdk")) {
  New-Item -ItemType Directory -Force $st | Out-Null
  $pkg = Get-Content "$ag\package.json" -Raw | ConvertFrom-Json
  $pkg.dependencies.'@anthropic-ai/claude-agent-sdk' = $Version
  $pty = Ver "$ag\node_modules\@homebridge\node-pty-prebuilt-multiarch"
  if ($pty) { $pkg.dependencies.'@homebridge/node-pty-prebuilt-multiarch' = $pty }
  $pkg | ConvertTo-Json -Depth 5 | Set-Content "$st\package.json" -Encoding ascii
  Say 'npm install into stage...'
  Push-Location $st; cmd /c "npm install --no-audit --no-fund 2>&1" | Select -Last 2 | % { Say "npm: $_" }; Pop-Location
}
if ((Ver "$st\node_modules\@anthropic-ai\claude-agent-sdk") -ne $Version) { Say 'ABORT: SDK did not stage'; exit 1 }

# 2. the platform binary npm may have dropped
$bin = "$st\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64"
if ((Ver $bin) -ne $Version -or -not (Test-Path "$bin\claude.exe")) {
  Say 'npm lost the win32 binary - fetching it with curl'
  $u = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-$Version.tgz"
  $integrity = "$(cmd /c npm view "@anthropic-ai/claude-agent-sdk-win32-x64@$Version" dist.integrity 2>$null)".Trim()
  if ($integrity -notmatch '^sha512-') { Say "ABORT: no integrity from npm ('$integrity')"; exit 1 }
  $want = (([Convert]::FromBase64String($integrity.Substring(7)) | % { $_.ToString('x2') }) -join '')
  $f = "$env:USERPROFILE\cc-remote-sdk-win32-$Version.tgz"
  $h = ''
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Path $f) { $h = (Get-FileHash $f -Algorithm SHA512).Hash.ToLower(); if ($h -eq $want) { break } }
    if ((Test-Path $f) -and (Get-Item $f).Length -ge 200MB) { Remove-Item $f }  # never resume onto garbage forever
    & curl.exe -fsSL -C - --retry 5 --connect-timeout 30 -o $f $u 2>&1 | % { Say "curl: $_" }
    Say "try ${i}: $((Get-Item $f -EA SilentlyContinue).Length) bytes"
  }
  if ($h -ne $want -and (Test-Path $f)) { $h = (Get-FileHash $f -Algorithm SHA512).Hash.ToLower() }
  if ($h -ne $want) { Remove-Item $f -EA SilentlyContinue }
  if ($h -ne $want) { Say 'ABORT: tarball never matched its sha512'; exit 1 }
  if (Test-Path $bin) { Remove-Item -Recurse -Force $bin }
  New-Item -ItemType Directory -Force $bin | Out-Null
  & tar.exe -xzf $f -C $bin --strip-components=1 2>&1 | % { Say "tar: $_" }
}
$wantCli = (Get-Content "$st\node_modules\@anthropic-ai\claude-agent-sdk\package.json" -Raw | ConvertFrom-Json).claudeCodeVersion
$v = "$(& "$bin\claude.exe" --version 2>&1)".Trim()
Say "staged claude.exe: $v (want $wantCli)"
if (-not $wantCli -or -not $v.StartsWith($wantCli)) { Say 'ABORT: staged runtime does not run'; exit 1 }
# node-pty is what the terminal - the only way into this box - runs on, and the
# agent loads it lazily, so "[agent] connected" proves nothing about it. It is
# pinned to the installed version anyway: carry the known-good tree over rather
# than trust npm's download on this link, and prove it loads.
$ptyRel = 'node_modules\@homebridge\node-pty-prebuilt-multiarch'
if (Test-Path "$st\$ptyRel") { Remove-Item -Recurse -Force "$st\$ptyRel" }
Copy-Item -Recurse "$ag\$ptyRel" "$st\$ptyRel"
$node = (AgentProcs | Select -First 1).ExecutablePath; if (-not $node) { $node = 'node' }
& $node -e "require(process.argv[1]); console.log('pty loads')" "$st\$ptyRel" 2>&1 | % { Say "pty: $_" }
if ($LASTEXITCODE -ne 0) { Say 'ABORT: staged node-pty does not load'; exit 1 }
if ($DryRun) { Say 'dry run: staged and verified, agent untouched'; exit 0 }

# 3. swap - only between turns
$live = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ? { $_.ExecutablePath -like "$ag\node_modules\*" })
if ($live.Count) { Say "ABORT: $($live.Count) live claude run(s) - try again when idle"; exit 1 }
StopAgent; Start-Sleep 2
Say "survived stop; agents left: $(@(AgentProcs).Count)"
for ($i = 0; $i -lt 15 -and (Test-Path "$ag\node_modules"); $i++) {
  try { Rename-Item "$ag\node_modules" $old -ErrorAction Stop; Say 'old node_modules parked' }
  catch { Say "rename try ${i}: $($_.Exception.Message)"; StopAgent; Start-Sleep 1 }
}
if (Test-Path "$ag\node_modules") { Say 'ABORT: node_modules stayed locked, starting the old agent'; StartAgent; exit 1 }
Move-Item "$st\node_modules" "$ag\node_modules" -EA SilentlyContinue
if (-not (Test-Path "$ag\node_modules\@anthropic-ai\claude-agent-sdk\package.json")) {
  Say 'move failed, restoring'
  if ((Test-Path "$ag\node_modules") -and -not (Park "$ag\node_modules" "$st\node_modules.partial-$(Get-Date -Format HHmmss)")) {
    Say 'RESTORE BLOCKED: partial tree locked - needs a human'; exit 1
  }
  Move-Item $old "$ag\node_modules"
  if (StartAndProve 150) { Say 'restored, the old agent is connected' } else { Say 'RESTORE NOT CONNECTED - needs a human' }
  exit 1
}
Copy-Item "$ag\package.json" "$ag\package.json.bak-$oldVer" -Force
Copy-Item "$ag\package-lock.json" "$ag\package-lock.json.bak-$oldVer" -Force -EA SilentlyContinue
Copy-Item "$st\package.json" "$ag\package.json" -Force
Copy-Item "$st\package-lock.json" "$ag\package-lock.json" -Force -EA SilentlyContinue
Say 'new node_modules in place, starting the task'

# 4. prove it, or put the old one back
$ok = StartAndProve 150
if ($ok) { Say "OK: connected ($ok), agents: $(@(AgentProcs).Count). Old tree kept at $old"; Say '=== done'; exit 0 }
Say 'NOT connected in 150 s -> ROLLBACK'
StopAgent; Start-Sleep 2
if (-not (Park "$ag\node_modules" "$st\node_modules.failed-$(Get-Date -Format HHmmss)")) {
  Say 'ROLLBACK BLOCKED: new tree stays locked, restarting on it - needs a human'; StartAgent; exit 1
}
Move-Item $old "$ag\node_modules"
Copy-Item "$ag\package.json.bak-$oldVer" "$ag\package.json" -Force
Copy-Item "$ag\package-lock.json.bak-$oldVer" "$ag\package-lock.json" -Force -EA SilentlyContinue
if (StartAndProve 150) { Say 'rolled back, the old agent is connected' } else { Say 'ROLLBACK ALSO NOT CONNECTED - needs a human' }
Say '=== done'
exit 1
