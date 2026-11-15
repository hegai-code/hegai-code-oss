# Mac mini watchdog

`mini-watchdog.sh` runs every minute on the mini (`~/bin/hegai-mini/`, LaunchAgent
`ai.heg.mini-watchdog`). `mini-heartbeat-check.sh` runs on the hub box
(`/usr/local/bin/mini-heartbeat-check`, `/etc/cron.d/mini-heartbeat`, every 2 min).
Alerts go through the hub's monitoring bot, the same way as `vpn-watchdog.sh`.

| Signal | Action |
|---|---|
| First minutes after a boot | Open Happ and start the tunnel until it first connects, open Chrome |
| ExtChrome link lost for 3 checks | Restart Chrome, at most 3 times a day |
| Pressure critical, or warning for 3 min | Stop one per check: `whisper-cli`, Android emulator, simulators; `macvps` (`vps down`, not restarted) only when critical |
| Any pressure while `macvps` runs | Shut the simulators down at once, and again whenever they come back |
| Critical for 10 min in a row or any pressure for 30, nothing left to stop | Restart, at most once in 6 hours and never within 30 min of a boot. Warning alone with `macvps` running: one alert, no restart |
| Load 30+ for 10 min | Alert only |
| No heartbeat for 8 min | Hub alert. A frozen mini cannot restart itself |

Pause: `touch ~/.hegai-mini-watchdog/off`. Log: `~/.hegai-mini-watchdog/watchdog.log`.

The restart is done by `mini-reboot-guard.sh`, a root LaunchDaemon. The watchdog only
touches a request file; the guard measures pressure itself and keeps the uptime and
cooldown limits in root-owned state, so a user process can ask but cannot force a
restart. Install once, it takes the mini's password:

    sudo bash ~/bin/hegai-mini/install-reboot-guard.sh

Why no AppleEvents: from a launchd job `osascript` hangs on TCC, with no prompt on
screen, so "Chrome answers" reads as hung on a healthy Chrome and a graceful restart
never runs. The ExtChrome link can miss a Chrome whose window hangs while its
extension stays connected.

Tests: `python3 deploy/test/mini_watchdog_test.py`.
