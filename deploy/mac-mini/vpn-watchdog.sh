#!/bin/bash
# One check of the mini's VPN; launchd runs it every minute. A failed tunnel
# gets restarted and Owner gets one Telegram message. It never leaves the mini
# without the VPN on purpose: Claude and Codex must not go out directly.
set -u
here=$(cd "$(dirname "$0")" && pwd)
state_dir=${VPN_WD_STATE_DIR:-$HOME/.hegai-vpn-watchdog}
trace_url=${VPN_WD_TRACE_URL:-https://www.cloudflare.com/cdn-cgi/trace}
fallback_url=${VPN_WD_FALLBACK_URL:-https://api.anthropic.com/}
service=${VPN_WD_SERVICE:-Happ}
hub=root@198.51.100.233
mkdir -p "$state_dir"

log() { echo "$(/bin/date '+%F %T') $*" >>"$state_dir/watchdog.log"; }
read_state() { cat "$state_dir/$1" 2>/dev/null || echo "$2"; }
write_state() { echo "$2" >"$state_dir/$1"; }

iface=$("$here/physical-iface.sh")

# The hub holds the bot token, and Telegram is blocked on the office line. The
# URL goes to curl through fd 3: an argument would show the token in ps there.
alert() {
  [ -n "${VPN_WD_NO_ALERT:-}" ] && return 0
  [ -n "$iface" ] || return 1
  printf '%s' "$1" | /usr/bin/ssh -B "$iface" -o BatchMode=yes -o ConnectTimeout=8 "$hub" '
. /etc/hegai-ops/monitoring.env
curl -fsS -m 15 -o /dev/null -K /dev/fd/3 --data-urlencode text@- -d "chat_id=$MONITORING_TELEGRAM_CHAT_ID" 3<<CONF
url = "https://api.telegram.org/bot$MONITORING_BOT_TOKEN/sendMessage"
CONF
'
}

# Any HTTP answer counts: only 000 means nothing came back.
reaches() { # <url> [curl args]
  local url=$1 code
  shift
  code=$(/usr/bin/curl -s -m 8 -o /dev/null -w '%{http_code}' "$@" "$url")
  [ "$code" != 000 ]
}

office_line_up() {
  [ -n "$iface" ] || return 1
  reaches https://www.gstatic.com/generate_204 --interface "$iface" ||
    reaches https://www.cloudflare.com/cdn-cgi/trace --interface "$iface"
}

trace_ip() { # [curl args]
  /usr/bin/curl -s -m 8 "$@" "$trace_url" | /usr/bin/awk -F= '$1 == "ip" { print $2 }'
}

# Connected is not enough: traffic must leave from another address than the
# office line. If either trace fails, Anthropic decides: it is closed from the office.
vpn_path_up() {
  local via_default direct
  via_default=$(trace_ip)
  direct=$(trace_ip --interface "$iface")
  if [ -z "$via_default" ] || [ -z "$direct" ]; then
    reaches "$fallback_url"
    return
  fi
  [ "$via_default" != "$direct" ]
}

status=$(/usr/sbin/scutil --nc status "$service" | /usr/bin/head -1)

if ! office_line_up; then
  # Not the VPN's fault, and a restart cannot help. Do not count it. The physical
  # route also blinks while the tunnel reconnects, so keep the counter.
  log "office line down"
  exit 0
fi

# A tunnel we restarted two checks ago and that stays down is our failure, not
# a person's choice: it has to reach the alert below.
fails=$(read_state fails 0)
restart_at=$(read_state restart_at 0)
restart_failing=
if [ "$restart_at" -gt 0 ] && [ $((fails - restart_at)) -lt 2 ]; then
  restart_failing=1
fi

if [ "$status" = Disconnected ] && [ -z "$restart_failing" ]; then
  # Turned off by hand, usually: do not fight the person. Say so once.
  if [ "$(read_state off_alerted 0)" = 0 ]; then
    log "$service is disconnected"
    alert "⚠️ Мини: $service выключен, Claude и Codex без VPN. Сам не включаю." && write_state off_alerted 1
  fi
  write_state fails 0
  write_state restart_at 0
  exit 0
fi
write_state off_alerted 0

if [ "$status" = Connected ] && vpn_path_up; then
  [ "$fails" = 0 ] || log "vpn path back after $fails failed checks"
  if [ "$(read_state alerted 0)" = 1 ]; then
    alert "✅ Мини: VPN снова работает." && write_state alerted 0
  fi
  write_state fails 0
  write_state restart_at 0
  exit 0
fi

fails=$((fails + 1))
write_state fails "$fails"
log "vpn path down (status=$status), failed checks: $fails"

# First restart after 3 minutes, then every 15.
if [ "$fails" = 3 ] || { [ "$fails" -gt 3 ] && [ $((fails % 15)) = 0 ]; }; then
  log "restarting $service"
  write_state restart_at "$fails"
  /usr/sbin/scutil --nc stop "$service"
  /bin/sleep 3
  /usr/sbin/scutil --nc start "$service" || log "start refused"
fi

# The first restart had two minutes to work. Retries until the hub takes it.
if [ "$fails" -ge 5 ] && [ "$(read_state alerted 0)" = 0 ]; then
  alert "🔴 Мини: VPN не работает, перезапуск $service не помог. Вход на мини жив, ждёт новых кредов." && write_state alerted 1
fi
exit 0
