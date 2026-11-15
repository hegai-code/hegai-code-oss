# Nightly runtime update for a Windows fleet machine — CODEX (and `claude` on
# PATH), never the SDK, on purpose.
#
# Why not the Claude SDK here. Updating it means replacing node_modules under
# the agent and restarting it, and buildbox-pc is the one box with NO inbound
# path at all (deploy/FLEET.md): if the new runtime does not come up and the
# rollback also fails, there is no second way in. This fleet has already lost
# that machine for a month once, by killing its agent remotely. Codex needs no
# restart — the agent spawns `codex app-server` per turn — so it carries none of
# that risk and gets automated; the SDK there stays a supervised change.
#
# The npm shim trap this works around: `codex` on Windows resolves to codex.ps1,
# which PowerShell refuses to run under the default execution policy, so every
# check goes through cmd.exe — which uses codex.cmd — exactly as the agent does
# (`shell: process.platform === 'win32'` in agent/src/codex-run.ts).
#
#   powershell -ExecutionPolicy Bypass -File update-runtimes-win.ps1 [-DryRun]
param([switch]$DryRun)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:USERPROFILE 'cc-remote-agent\runtimes-update.log'
function Say($m) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Output $line
  Add-Content -Path $log -Value $line -ErrorAction SilentlyContinue
}

# `claude` on PATH: sessions run the SDK's own binary, but the «Войти» button
# on «Железо» runs THIS one (`claude auth login`), and buildbox-pc had 2.1.104
# on 28.09.2026 — ~180 versions behind. `claude update` knows how it was
# installed; no agent restart, nothing a run depends on. Failure is logged and
# does not stop the Codex half.
$cl = (cmd /c claude --version 2>$null | Select-Object -First 1)
if ($cl) {
  $clBefore = ("$cl" -split ' ')[0]
  if ($DryRun) { Say "claude в PATH: $clBefore — запустил бы claude update" }
  else {
    # Bounded: the Scheduled Task has a 30-minute limit, and a `claude update`
    # hung on the network or a prompt must not take the Codex half down with
    # it night after night. Its stderr tail goes into the log when nothing moved.
    $err = "$log.claude.err"
    $p = Start-Process cmd -ArgumentList '/c', 'claude update' -NoNewWindow -PassThru `
      -RedirectStandardOutput "$log.claude.out" -RedirectStandardError $err
    if (-not $p.WaitForExit(300000)) {
      & taskkill /T /F /PID $p.Id | Out-Null
      Say 'claude в PATH: update завис дольше 5 минут — убит, иду к codex'
    }
    $clAfter = ((cmd /c claude --version 2>$null | Select-Object -First 1) -split ' ')[0]
    if (-not $clAfter) { Say "claude в PATH: после update не отвечает — нужен человек" }
    elseif ($clAfter -ne $clBefore) { Say "claude в PATH: $clBefore -> $clAfter" }
    else {
      $tail = (Get-Content $err -Tail 1 -ErrorAction SilentlyContinue)
      Say "claude в PATH: $clAfter$(if ($tail) { " ($tail)" })"
    }
  }
} else { Say 'claude в PATH: нет — пропускаю' }

$have = (cmd /c codex --version 2>$null) -replace '^codex-cli\s+', ''
$want = (cmd /c npm view '@openai/codex' version 2>$null)
$have = "$have".Trim(); $want = "$want".Trim()
Say "codex: стоит $have, в npm $want"

if (-not $want) { Say 'codex: npm не ответил — пропускаю'; exit 0 }
if ($have -eq $want) { Say 'codex: уже свежий'; exit 0 }
if ($DryRun) { Say "codex: обновил бы $have -> $want"; exit 0 }

Say "codex: ставлю $want"
cmd /c npm install -g "@openai/codex@$want" 2>$null | Out-Null
$now = (cmd /c codex --version 2>$null) -replace '^codex-cli\s+', ''
$now = "$now".Trim()
if ($now -eq $want) {
  Say "codex: готово, $now"
  exit 0
}
# A global npm package that cannot report its own version is a broken runtime
# for every future turn, so it is put back rather than left in place.
Say "codex: $want не запускается (получили '$now') — ОТКАТ на $have"
cmd /c npm install -g "@openai/codex@$have" 2>$null | Out-Null
$back = (cmd /c codex --version 2>$null) -replace '^codex-cli\s+', ''
if ("$back".Trim() -eq $have) { Say 'codex: откат удался' } else { Say 'codex: ОТКАТ ТОЖЕ СЛОМАН — нужен человек' }
exit 1
