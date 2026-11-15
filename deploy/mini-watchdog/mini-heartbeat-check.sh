#!/bin/bash
# Hub box, cron every 2 minutes: says when the Mac mini stops touching its
# heartbeat (mini-watchdog.sh) and when it comes back. It cannot restart it:
# a frozen machine needs a person or a smart plug.
set -u
dir=${MINI_HB_DIR:-/var/lib/mini-watchdog}
quiet_after=${MINI_HB_QUIET_AFTER:-480}
env_file=${MINI_HB_ENV:-/etc/hegai-ops/monitoring.env}

# No heartbeat yet: start the clock, so a mini that never reports is noticed too.
mkdir -p "$dir"
[ -e "$dir/heartbeat" ] || touch "$dir/heartbeat"
age=$(($(date +%s) - $(stat -c %Y "$dir/heartbeat")))

send() {
  # shellcheck disable=SC1090
  . "$env_file"
  printf '%s' "$1" | curl -fsS -m 15 -o /dev/null -K /dev/fd/3 --data-urlencode text@- \
    -d "chat_id=$MONITORING_TELEGRAM_CHAT_ID" 3<<CONF
url = "https://api.telegram.org/bot$MONITORING_BOT_TOKEN/sendMessage"
CONF
}

if [ "$age" -ge "$quiet_after" ]; then
  [ -e "$dir/alerted" ] && exit 0
  send "🔴 Мини молчит $((age / 60)) мин: завис, выключен или пропал интернет. Сама себя не поднимет, если зависла." &&
    touch "$dir/alerted"
elif [ -e "$dir/alerted" ] && [ "$age" -lt 180 ]; then
  send "✅ Мини снова на связи." && rm -f "$dir/alerted"
fi
exit 0
