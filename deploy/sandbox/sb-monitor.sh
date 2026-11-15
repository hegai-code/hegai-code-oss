#!/usr/bin/env bash
# Sandbox host monitor → Telegram, in the shape of the other server monitor
# bots (message prefix `🛡 Sandbox [<host>]`, one line per finding).
#
# Checks: failed / crash-looping cc-remote-sandbox@* units, the heaviest
# sandboxes by memory (systemd-cgtop on sandboxes.slice, ps as fallback),
# per-home disk use, host memory and /home free space, and the provisioner
# unit (active? journal fresh?). Sends only when something is wrong, or the
# whole report when --daily is passed. Always prints the report to stdout.
#
# Cron (root):
#   */5 * * * * /opt/cc-remote-agent/sandbox/sb-monitor.sh >> /var/log/sb-monitor.log 2>&1
#   0 9 * * *   /opt/cc-remote-agent/sandbox/sb-monitor.sh --daily >> /var/log/sb-monitor.log 2>&1
#
# Env (or /etc/cc-remote/sb-monitor.env): TG_BOT_TOKEN, TG_CHAT_ID, thresholds
# SB_MEM_WARN_MB SB_DISK_WARN_GB SB_HOME_WARN_GB SB_RESTARTS_WARN SB_PROVISIONER_STALE_MIN.
set -uo pipefail

ENV_FILE="${SB_MONITOR_ENV:-/etc/cc-remote/sb-monitor.env}"
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

DAILY=0
for arg in "$@"; do
  case "$arg" in
    --daily) DAILY=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

HOST="${SANDBOX_HOST:-$(hostname)}"

# A threshold that is not a number turns every comparison below into a shell
# error the missing `set -e` then walks past — the check is skipped and the
# report still exits 0. Fall back to the default and say so instead.
threshold() { # value default name
  if [[ "$1" =~ ^[0-9]+$ ]]; then
    printf '%s' "$1"
  else
    printf '%s' "$2"
    echo "sb-monitor: $3=«$1» is not a number — using $2" >&2
  fi
}
MEM_WARN_MB="$(threshold "${SB_MEM_WARN_MB:-1500}" 1500 SB_MEM_WARN_MB)"
DISK_WARN_GB="$(threshold "${SB_DISK_WARN_GB:-5}" 5 SB_DISK_WARN_GB)"
HOME_WARN_GB="$(threshold "${SB_HOME_WARN_GB:-10}" 10 SB_HOME_WARN_GB)"
RESTARTS_WARN="$(threshold "${SB_RESTARTS_WARN:-3}" 3 SB_RESTARTS_WARN)"
STALE_MIN="$(threshold "${SB_PROVISIONER_STALE_MIN:-20}" 20 SB_PROVISIONER_STALE_MIN)"

problems=()
lines=()
add()  { lines+=("$1"); }
warn() { problems+=("$1"); lines+=("🔴 $1"); }

html_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# --- units ------------------------------------------------------------------
# `mapfile < <(...)` cannot see the command's exit status, so a systemctl that
# fails would read as "this host has no sandboxes" — a silent all-clear, which
# is the worst thing a monitor can say. Capture first, check, then split.
units=()
if unit_list="$(systemctl list-units 'cc-remote-sandbox@*' --all --no-legend --plain 2>/dev/null)"; then
  while read -r name _rest; do
    [ -n "$name" ] && units+=("$name")
  done <<< "$unit_list"
else
  warn "systemctl could not list cc-remote-sandbox@* — this report cannot see the sandboxes"
fi
active=0
# `${a[@]+"${a[@]}"}` and not `"${a[@]}"`: under `set -u` an empty array is an
# unbound variable on bash before 4.4, and a host with no sandboxes yet is the
# normal case — the monitor must not die on it.
for u in ${units[@]+"${units[@]}"}; do
  # ONE call, parsed by key. `systemctl show -p A -p B --value` prints the values
  # in ITS order, not the order asked for (NRestarts came out first), so reading
  # three of them positionally reported a healthy unit as "0/active" and counted
  # zero sandboxes. Reading `Key=Value` is order-proof, and one call is also one
  # consistent snapshot — three calls can straddle a restart and report
  # "failed (running)".
  if ! props="$(systemctl show "$u" -p ActiveState -p SubState -p NRestarts 2>/dev/null)"; then
    warn "<b>$u</b> — systemctl show failed, state unknown"
    continue
  fi
  state="$(sed -n 's/^ActiveState=//p' <<< "$props")"
  sub="$(sed -n 's/^SubState=//p' <<< "$props")"
  restarts="$(sed -n 's/^NRestarts=//p' <<< "$props")"
  case "$state" in
    active) active=$((active + 1)) ;;
    failed) warn "<b>$u</b> failed ($sub)" ;;
    inactive) : ;; # suspended sandboxes are inactive on purpose
    "") warn "<b>$u</b> — systemd reported no ActiveState" ;;
    *) warn "<b>$u</b> $state/$sub" ;;
  esac
  # A missing or non-numeric count is itself worth saying out loud: quietly
  # treating it as 0 is how a crash-looping sandbox stays invisible.
  if [[ "$restarts" =~ ^[0-9]+$ ]]; then
    [ "$restarts" -gt "$RESTARTS_WARN" ] && warn "<b>$u</b> restarted ${restarts}× since last start"
  else
    warn "<b>$u</b> — could not read NRestarts (got «${restarts}»)"
  fi
done
add "Sandboxes: <b>$active</b> active of ${#units[@]} unit(s)"

# --- memory per sandbox -----------------------------------------------------
if command -v systemd-cgtop >/dev/null 2>&1 && systemctl -q is-active sandboxes.slice 2>/dev/null; then
  top="$(systemd-cgtop -b -n1 -m --raw sandboxes.slice 2>/dev/null \
    | awk 'NR>1 && $1 ~ /cc-remote-sandbox@/ { n=$1; sub(/.*\//,"",n); sub(/\.service$/,"",n); printf "%s %d MB\n", n, $4/1048576 }' | head -5)"
else
  top="$(ps -eo user:32,rss --no-headers 2>/dev/null | awk '$1 ~ /^sb-/ { m[$1]+=$2 } END { for (u in m) printf "%s %d MB\n", u, m[u]/1024 }' | sort -k2 -rn | head -5)"
fi
if [ -n "$top" ]; then
  add "Top memory:"
  while IFS= read -r l; do add "  $l"; done <<< "$top"
fi

# --- disk per home ----------------------------------------------------------
# Needs its own heading: these lines are indented like the memory list above, so
# without one a home's size reads as another sandbox's memory.
homes="$(du -sh /home/sb-* 2>/dev/null | sort -rh)"
if [ -n "$homes" ]; then
  add "Disk per sandbox:"
  while read -r size home; do
    add "  $home $size"
    gb="$(du -sb "$home" 2>/dev/null | awk '{printf "%d", $1/1073741824}')"
    if [ "${gb:-0}" -ge "$HOME_WARN_GB" ]; then warn "<b>$home</b> uses ${size} (limit ${HOME_WARN_GB}G, no quotas on this host)"; fi
  done <<< "$homes"
fi

# --- host memory / disk -----------------------------------------------------
mem_avail="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)"
if [[ "$mem_avail" =~ ^[0-9]+$ ]]; then
  add "Host RAM available: <b>${mem_avail} MB</b>"
  [ "$mem_avail" -lt "$MEM_WARN_MB" ] && warn "Host RAM available ${mem_avail} MB < ${MEM_WARN_MB} MB — sandboxes.slice is squeezing the platform"
else
  warn "could not read MemAvailable from /proc/meminfo"
fi

disk_free_gb="$(df -BG --output=avail /home 2>/dev/null | tail -1 | tr -dc '0-9')"
if [[ "$disk_free_gb" =~ ^[0-9]+$ ]]; then
  add "Free on /home: <b>${disk_free_gb} GB</b>"
  [ "$disk_free_gb" -lt "$DISK_WARN_GB" ] && warn "Free space on /home ${disk_free_gb} GB < ${DISK_WARN_GB} GB"
else
  warn "could not read free space on /home"
fi

# --- provisioner -------------------------------------------------------------
pstate="$(systemctl is-active cc-remote-provisioner 2>/dev/null || true)"
if [ "$pstate" != "active" ]; then
  warn "cc-remote-provisioner is <b>${pstate:-missing}</b>"
else
  last_ts="$(journalctl -u cc-remote-provisioner -n1 -o short-unix --no-pager 2>/dev/null | awk '{print int($1)}')"
  if [ -n "$last_ts" ] && [ "$last_ts" -gt 0 ]; then
    age_min=$(( ( $(date +%s) - last_ts ) / 60 ))
    add "Provisioner: active, last journal line ${age_min} min ago"
    [ "$age_min" -gt "$STALE_MIN" ] && warn "Provisioner journal is ${age_min} min old (> ${STALE_MIN}) — it logs an idle line every ~10 min, so it is probably stuck"
  else
    add "Provisioner: active, no journal lines yet"
  fi
fi

# --- report ------------------------------------------------------------------
title="🛡 <b>Sandbox</b> [${HOST}]"
if [ "${#problems[@]}" -gt 0 ]; then
  title="$title — ${#problems[@]} problem(s)"
elif [ "$DAILY" -eq 1 ]; then
  title="$title — daily, all clear"
fi
report="$(printf '%s\n' "$title" "${lines[@]}")"
printf '%s\n%s\n' "$(date -Is)" "$report"

if [ "${#problems[@]}" -eq 0 ] && [ "$DAILY" -eq 0 ]; then exit 0; fi
if [ -z "${TG_BOT_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then
  echo "(TG_BOT_TOKEN / TG_CHAT_ID unset — not sent)"; exit 0
fi
msg="$(printf '%s' "$report" | head -c 3900)"
curl -fsS -m 20 -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TG_CHAT_ID}" \
  --data-urlencode "text=${msg}" \
  -d parse_mode=HTML -d disable_web_page_preview=true >/dev/null \
  || echo "(telegram send failed)" >&2
