#!/bin/bash
# Root LaunchDaemon, once a minute: the only thing on the mini allowed to restart
# it. mini-watchdog.sh, which runs as the user, only asks by touching a file. Any
# process of that user can touch it too, so the request proves nothing: pressure,
# uptime and the cooldown are measured here, in root-owned state.
set -u
export PATH=${MINI_RG_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}
state_dir=${MINI_RG_STATE_DIR:-/var/db/mini-reboot-guard}
request=${MINI_RG_REQUEST:-/Users/devuser-0001/.hegai-mini-watchdog/reboot_request}
reboot_cooldown=21600
reboot_min_uptime=1800
request_fresh=300

mkdir -p "$state_dir"
chmod 700 "$state_dir"
read_state() {
  local value
  value=$(cat "$state_dir/$1" 2>/dev/null)
  case "$value" in '' | *[!0-9]*) echo 0 ;; *) echo "$value" ;; esac
}

# The counters mean consecutive minutes: a gap in sampling or a failed reading
# starts them over.
now=$(date +%s)
if [ $((now - $(read_state last_sample))) -gt 180 ]; then
  echo 0 >"$state_dir/critical"
  echo 0 >"$state_dir/pressure"
fi
echo "$now" >"$state_dir/last_sample"

level=$(sysctl -n kern.memorystatus_vm_pressure_level)
case "$level" in
  1) critical=0 pressure=0 ;;
  2) critical=0 pressure=$(($(read_state pressure) + 1)) ;;
  4) critical=$(($(read_state critical) + 1)) pressure=$(($(read_state pressure) + 1)) ;;
  *) critical=0 pressure=0 ;;
esac
echo "$critical" >"$state_dir/critical"
echo "$pressure" >"$state_dir/pressure"

[ "$critical" -ge 10 ] || [ "$pressure" -ge 30 ] || exit 0
[ -f "$request" ] || exit 0

requested_at=$(stat -f %m "$request" 2>/dev/null || echo 0)
age=$((now - requested_at))
[ "$age" -ge 0 ] && [ "$age" -le "$request_fresh" ] || exit 0
boot=$(sysctl -n kern.boottime | sed -E 's/^[{] sec = ([0-9]+).*/\1/')
[ $((now - boot)) -ge "$reboot_min_uptime" ] || exit 0
[ $((now - $(read_state last_reboot))) -ge "$reboot_cooldown" ] || exit 0

logger -t mini-reboot-guard "restart: pressure $level, critical $critical min, any $pressure min"
previous_reboot=$(read_state last_reboot)
echo "$now" >"$state_dir/last_reboot"
if ! "${MINI_RG_SHUTDOWN:-/sbin/shutdown}" -r now; then
  echo "$previous_reboot" >"$state_dir/last_reboot" # a failed restart must not use up the cooldown
fi
