#!/bin/bash
# Runs once a minute on the Mac mini (LaunchAgent ai.heg.mini-watchdog). Keeps
# the machine usable without a person at it:
#   - after a boot: Happ up and connected, Chrome open;
#   - Chrome lost its ExtChrome link: restart it, at most 3 times a day;
#   - memory pressure: stop heavy jobs one per check, cheapest loss first;
#     macvps only under critical pressure, simulators at once while it runs;
#   - nothing left to stop and it still hurts: ask mini-reboot-guard.sh (root) for
#     a restart;
#   - every check touches a heartbeat on the hub, so the hub can say when the
#     mini has gone silent. A frozen machine cannot report or save itself.
# Stop it for a while: touch ~/.hegai-mini-watchdog/off
set -u
export PATH=${MINI_WD_PATH:-/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin}
state_dir=${MINI_WD_STATE_DIR:-$HOME/.hegai-mini-watchdog}
iface_cmd=${MINI_WD_IFACE_CMD:-$HOME/bin/hegai-mini/physical-iface.sh}
vps=${MINI_WD_VPS:-$HOME/macvps/vps}
service=Happ
hub=root@198.51.100.233
ext_env=${MINI_WD_EXT_ENV:-$HOME/extchrome/.env}
guard=${MINI_WD_GUARD:-/usr/local/libexec/mini-reboot-guard}

boot_grace=300            # Chrome is still restoring its tabs
happ_boot_window=900      # give up on Happ and tell Owner after this

mkdir -p "$state_dir"

log() { echo "$(date '+%F %T') $*" >>"$state_dir/watchdog.log"; }
read_state() {
  local value
  value=$(cat "$state_dir/$1" 2>/dev/null)
  echo "${value:-$2}"
}
write_state() { echo "$2" >"$state_dir/$1.tmp" && mv "$state_dir/$1.tmp" "$state_dir/$1"; }

# perl's alarm survives exec. A command that ran out of time exits with 142.
with_timeout() { # <seconds> <command...>
  local seconds=$1
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' "$seconds" "$@"
}

iface=$(with_timeout 20 "$iface_cmd" 2>/dev/null)

# The hub holds the bot token, and Telegram is blocked on the office line, the
# same way as in vpn-watchdog.sh. The URL goes to curl through fd 3: an argument
# would show the token in ps there.
alert() {
  [ -n "$iface" ] || return 1
  printf '%s' "$1" | with_timeout 30 ssh -B "$iface" -o BatchMode=yes -o ConnectTimeout=8 "$hub" '
. /etc/hegai-ops/monitoring.env
curl -fsS -m 15 -o /dev/null -K /dev/fd/3 --data-urlencode text@- -d "chat_id=$MONITORING_TELEGRAM_CHAT_ID" 3<<CONF
url = "https://api.telegram.org/bot$MONITORING_BOT_TOKEN/sendMessage"
CONF
'
}

heartbeat() {
  [ -n "$iface" ] || return 0
  with_timeout 12 ssh -B "$iface" -o BatchMode=yes -o ConnectTimeout=8 "$hub" \
    'mkdir -p /var/lib/mini-watchdog && touch /var/lib/mini-watchdog/heartbeat' </dev/null >/dev/null 2>&1
}

top_memory() {
  ps -Ao rss=,comm= -m | head -5 | awk '{ rss = $1; $1 = ""; sub(/.*\//, ""); sub(/^ /, ""); printf "%.1f ГБ %s\n", rss / 1048576, $0 }'
}

top_cpu() {
  ps -Ao %cpu=,comm= -r | head -5 | awk '{ cpu = $1; $1 = ""; sub(/.*\//, ""); sub(/^ /, ""); printf "%s%% %s\n", cpu, $0 }'
}

# A paused watchdog is not a silent machine: the heartbeat goes on.
heartbeat
# Counters of a past episode must not carry over a pause or a boot.
forget_episode() {
  rm -f "$state_dir/trouble" "$state_dir/critical" "$state_dir/tried" "$state_dir/reboot_request" \
    "$state_dir/episode_alerted" "$state_dir/request_alerted" "$state_dir/refused_alerted" \
    "$state_dir/protected_alerted"
}
[ -e "$state_dir/off" ] && {
  forget_episode
  exit 0
}

now=$(date +%s)
boot=$(sysctl -n kern.boottime | sed -E 's/^[{] sec = ([0-9]+).*/\1/')
uptime=$((now - boot))
# The counters mean consecutive minutes, so a gap in checks starts them over too.
if [ "$(read_state pressure_boot 0)" != "$boot" ] || [ $((now - $(read_state last_check 0))) -gt 180 ]; then
  forget_episode
  write_state load_high 0
  write_state pressure_boot "$boot"
fi
write_state last_check "$now"

# Owner's Chrome, not the headless one that shares its bundle: render-chrome
# (ixbt-resolver, 13.11.2026) runs /Applications/Google Chrome.app --headless,
# and LaunchServices takes it for "Google Chrome". After the 27.11.2026 reboot
# it started first: pgrep said "Chrome is up", the real one was never opened,
# and a click on Chrome only activated the windowless instance. Hence `open -n`.
real_chrome_pids() {
  local pid
  for pid in $(pgrep -x "Google Chrome"); do
    ps -o command= -p "$pid" 2>/dev/null | grep -q -- '--headless' || echo "$pid"
  done
}

after_boot() {
  [ "$(read_state boot_chrome 0)" = "$boot" ] || {
    if [ "$uptime" -ge 120 ]; then
      if [ -n "$(real_chrome_pids)" ]; then
        write_state boot_chrome "$boot"
      else
        log "boot: opening Chrome"
        with_timeout 20 open -n -gj -a "Google Chrome" && write_state boot_chrome "$boot"
      fi
    fi
  }

  # Only until the first Connected of this boot. A Happ switched off by hand
  # later stays off: vpn-watchdog.sh says so, nobody fights the person.
  [ "$(read_state boot_happ 0)" = "$boot" ] && return 0
  pgrep -x Happ >/dev/null || { log "boot: opening Happ"; with_timeout 20 open -gj -a Happ; }
  local status
  status=$(with_timeout 20 scutil --nc status "$service" | head -1)
  if [ "$status" = Connected ]; then
    log "boot: $service connected after ${uptime}s"
    write_state boot_happ "$boot"
    return 0
  fi
  if [ "$uptime" -ge "$happ_boot_window" ]; then
    log "boot: $service still $status after ${uptime}s"
    alert "🔴 Мини после перезагрузки: $service не подключился за 15 минут (статус $status), Claude и Codex без VPN." &&
      write_state boot_happ "$boot"
    return 0
  fi
  if [ "$status" = Disconnected ]; then
    log "boot: starting $service"
    with_timeout 20 scutil --nc start "$service" || log "boot: start refused"
  fi
}

restart_chrome() {
  log "chrome hung, restarting"
  local pids
  pids=$(real_chrome_pids)
  [ -n "$pids" ] && kill -TERM $pids 2>/dev/null
  sleep 5
  pids=$(real_chrome_pids)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
  sleep 1
  # A failed open goes back to the boot opener, which retries every minute.
  with_timeout 20 open -n -gj -a "Google Chrome" || rm -f "$state_dir/boot_chrome"
}

# AppleEvents are no probe here: from a launchd job osascript just hangs on TCC
# (06.11.2026, rc 142 on a healthy Chrome). ExtChrome's link is the signal: lost
# while Chrome runs, after having been up for this Chrome, means it stopped
# working. A server that does not answer says nothing about Chrome.
probe_chrome() {
  local pid health chrome_fails restarts day
  chrome_fails=$(read_state chrome_fails 0)
  pid=$(real_chrome_pids | head -1)
  if [ "$uptime" -lt "$boot_grace" ] || [ -z "$pid" ]; then
    write_state chrome_fails 0
    return 0
  fi
  # The key goes to curl on stdin: an argument would show it in ps.
  health=$(sed -n 's/^API_KEY=//p' "$ext_env" 2>/dev/null | tr -d "\"'" |
    awk '{ printf "header = \"Authorization: Bearer %s\"\n", $0 }' |
    curl -s -m 5 -K - http://127.0.0.1:3847/api/v1/status | tr -d ' ')
  case "$health" in
    *'"extensionConnected":true'*)
      write_state chrome_seen "$pid"
      chrome_fails=0
      ;;
    *'"extensionConnected":false'*)
      if [ "$(read_state chrome_seen 0)" = "$pid" ]; then
        chrome_fails=$((chrome_fails + 1))
        log "chrome lost its extension link, failed checks: $chrome_fails"
      fi
      ;;
  esac
  write_state chrome_fails "$chrome_fails"
  [ "$chrome_fails" -ge 3 ] || return 0

  write_state chrome_fails 0
  day=$(date +%F)
  restarts=$(read_state "chrome_restarts_$day" 0)
  if [ "$restarts" -ge 3 ]; then
    log "chrome restart skipped, already $restarts today"
    return 0
  fi
  write_state "chrome_restarts_$day" $((restarts + 1))
  restart_chrome
  alert "🟡 Мини: Chrome перестал отвечать расширению, перезапустил." || true
}

rung_present() {
  case "$1" in
    whisper) pgrep -x whisper-cli >/dev/null ;;
    android) pgrep -f '^[^ ]*qemu-system-aarch64( |$)' >/dev/null ;;
    simulator) pgrep -x Simulator >/dev/null || pgrep -x launchd_sim >/dev/null ;;
    macvps) pgrep -f '^[^ ]*tart run( |$)' >/dev/null ;;
  esac
}

rung_stop() {
  case "$1" in
    whisper) pkill -TERM -x whisper-cli ;;
    android) pkill -TERM -f '^[^ ]*qemu-system-aarch64( |$)' ;;
    simulator)
      with_timeout 30 xcrun simctl shutdown all
      pkill -TERM -x Simulator
      ;;
    macvps) with_timeout 120 "$vps" down ;;
  esac
}

# Each rung once per episode. Safari is Owner's own browser and is never
# stopped (11.11.2026). macvps carries the US exit and is used by hand
# (Owner, 11.11.2026): warning pressure never stops it, only critical does, last,
# right before the restart that would stop it anyway.
stop_next() {
  local rung tried
  tried=$(read_state tried "")
  # whisper-cli is not a rung (Owner, 12.11.2026): it is the meeting recogniser for the
  # platform, and killing it mid-run lost the recording; a job lasts minutes and ends itself.
  for rung in android simulator macvps; do
    case " $tried " in *" $rung "*) continue ;; esac
    # and never in the minute its simulators went: give that a check to free memory
    [ "$rung" = macvps ] && { [ "$level" -lt 4 ] || [ -n "$sims_now" ]; } && continue
    rung_present "$rung" || continue
    log "stopping $rung (pressure $level, trouble for $trouble min)"
    write_state tried "$tried $rung"
    stopped=$rung
    rung_stop "$rung" >>"$state_dir/watchdog.log" 2>&1 || stopped="$rung (команда вернула ошибку)"
    return 0
  done
  return 1
}

# Only asks. mini-reboot-guard.sh (root) checks pressure, uptime and the cooldown
# itself and does the restart, so no sudo rule hands that power to the whole user.
request_restart() {
  if [ ! -e "$guard" ]; then
    log "restart due, guard not installed"
    [ "$(read_state refused_alerted 0)" = 1 ] ||
      { alert "🔴 Мини: нужна перезагрузка, но сторож перезагрузки не установлен. Нужны руки." && write_state refused_alerted 1; }
    return 0
  fi
  log "asking for a restart: pressure $level, trouble for $trouble min"
  touch "$state_dir/reboot_request"
  [ "$(read_state request_alerted 0)" = 1 ] ||
    { alert "🔴 Мини: плохо $trouble мин, гасить больше нечего, запросил перезагрузку. Не чаще раза в 6 часов и не раньше 30 минут после загрузки.
$(top_memory)" && write_state request_alerted 1; }
}

check_pressure() {
  level=$(sysctl -n kern.memorystatus_vm_pressure_level)
  # A failed reading must never look like pressure: this path ends in a restart.
  case "$level" in
    1 | 2 | 4) ;;
    *)
      log "pressure reading unusable: '$level'"
      forget_episode
      return 0
      ;;
  esac
  trouble=$(read_state trouble 0)
  stopped=

  if [ "$level" -lt 2 ]; then
    if [ "$trouble" != 0 ]; then
      log "trouble over after $trouble min"
      if [ "$(read_state episode_alerted 0)" = 1 ]; then
        alert "✅ Мини: отпустило, погашено:$(read_state tried " ничего")." || true
      fi
    fi
    write_state episode_alerted 0
    write_state request_alerted 0
    write_state refused_alerted 0
    write_state protected_alerted 0
    forget_episode
    return 0
  fi

  trouble=$((trouble + 1))
  write_state trouble "$trouble"
  local critical=0
  [ "$level" -lt 4 ] || critical=$(($(read_state critical 0) + 1))
  write_state critical "$critical"

  # The simulators are what pushes a running macvps out (11.11.2026: other
  # sessions kept booting them). While it runs they go at the first sign of
  # pressure and every time they come back, on top of the one rung per check.
  sims_now=
  if rung_present macvps && rung_present simulator; then
    sims_now=1
    log "stopping simulator for macvps (pressure $level)"
    rung_stop simulator >>"$state_dir/watchdog.log" 2>&1
    case " $(read_state tried "") " in *" simulator "*) ;; *) write_state tried "$(read_state tried "") simulator" ;; esac
  fi

  if [ "$level" -ge 4 ] || [ "$trouble" -ge 3 ]; then
    if stop_next; then
      alert "🟡 Мини: давление памяти $level, погасил $stopped.
$(top_memory)" && write_state episode_alerted 1
      return 0
    fi
  else
    return 0
  fi

  if [ "$critical" -ge 10 ]; then
    request_restart
  elif [ "$trouble" -ge 30 ]; then
    # A restart would take macvps down, which warning pressure must not do.
    if [ "$level" -lt 4 ] && rung_present macvps; then
      # an earlier request of this episode must not restart it within the guard's window
      rm -f "$state_dir/reboot_request"
      [ "$(read_state protected_alerted 0)" = 1 ] || {
        log "warning for $trouble min, macvps kept, no restart"
        alert "🟡 Мини: давление памяти $level уже $trouble мин. macvps не трогаю и перезагрузку не прошу, гасить больше нечего.
$(top_memory)" && write_state protected_alerted 1
      }
    else
      request_restart
    fi
  fi
}

# Alert only: a long Xcode build looks the same, so this kills nothing.
check_load() {
  local load load_high
  load=$(sysctl -n vm.loadavg | awk '{ printf "%d", $2 }')
  load_high=$(read_state load_high 0)
  if [ "$load" -ge 30 ] && [ "$uptime" -ge "$boot_grace" ]; then
    load_high=$((load_high + 1))
    if [ "$load_high" -ge 10 ] && [ "$(read_state load_alerted 0)" = 0 ]; then
      alert "🟡 Мини: нагрузка $load уже $load_high мин. Сам не гашу, вот кто ест:
$(top_cpu)" && write_state load_alerted 1
    fi
  else
    load_high=0
    [ "$load" -ge 15 ] || write_state load_alerted 0
  fi
  write_state load_high "$load_high"
}

after_boot
probe_chrome
check_load
check_pressure

if [ "$(wc -c <"$state_dir/watchdog.log" 2>/dev/null || echo 0)" -gt 1000000 ]; then
  tail -2000 "$state_dir/watchdog.log" >"$state_dir/watchdog.log.new" &&
    mv "$state_dir/watchdog.log.new" "$state_dir/watchdog.log"
fi
exit 0
