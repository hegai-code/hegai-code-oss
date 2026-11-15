#!/usr/bin/env bash
# Unwedge an agent that a runaway SIBLING process has throttled to a halt.
#
# The failure this exists for, 21.09.2026 on stage: a session's `ugrep` hit
# catastrophic backtracking, sat on one file for six hours and grew to 2.7 GB.
# It lives in the AGENT's cgroup, so the group crossed MemoryHigh (then 3G); the kernel
# then throttled everything in it — `memory.events: high 10900569`,
# `memory.pressure: full avg10=92.85`, i.e. the group was stalled in reclaim 93%
# of the time. Node's event loop could no longer finish a WebSocket handshake, so
# the agent logged `Opening handshake has timed out` every 20s forever, the hub
# marked the machine offline, and every session on it went "Machine offline" and
# would not load. The agent process was alive and `systemctl is-active` said
# `active` the whole time.
#
# What makes it worth automating is where the evidence ISN'T: the hub is healthy,
# every other machine is fine, and `ps` shows the agent itself using 359 MB. The
# 2.7 GB is a grandchild, and `MemoryCurrent` on the unit is the only place the
# real number shows up.
#
# So: kill the hog, not the agent. A restart would have taken the three live runs
# down with it (KillMode=control-group); killing the hog let the agent reconnect
# in 40s and the hub re-adopt all three ("re-adopted 3 run(s)").
#
# Deliberately NOT here: restarting a wedged agent when there is no hog to blame.
# That is the case where somebody's work gets destroyed to fix a symptom nobody
# has diagnosed, and it is exactly the move that cost this fleet a machine for a
# month. No hog => say so loudly and stop.
#
# Usage:
#   agent-watchdog.sh              # check every agent unit, kill hogs
#   agent-watchdog.sh --dry-run    # say what it would kill, touch nothing
#   agent-watchdog.sh --unit U     # one unit only
set -uo pipefail

DRY=0
ONLY_UNIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=1 ;;
    --unit) ONLY_UNIT="${2:-}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

# A group stalled this much of the time is not "busy", it is not running.
PRESSURE_MIN="${CC_WATCHDOG_PRESSURE:-50}"
# Floor for calling a process a hog. A legitimate build (cargo, tsc, vite) can
# pass this, which is why it is never the only condition — the group has to be
# throttled as well.
HOG_MIN_KB="${CC_WATCHDOG_HOG_MIN_KB:-1048576}"        # 1 GiB
# ...and it has to have been at it long enough that a short spike cannot qualify.
HOG_MIN_AGE="${CC_WATCHDOG_HOG_MIN_AGE:-600}"          # 10 minutes
# With no memory ceiling on the unit there is no memory.high throttling to read,
# so the bar for blaming a process is higher.
HOG_MIN_KB_NOLIMIT="${CC_WATCHDOG_HOG_MIN_KB_NOLIMIT:-2097152}"  # 2 GiB
# How many fresh `memory.events: high` counts since the previous run mean "the
# kernel is throttling this group right now".
THROTTLE_EVENTS_MIN="${CC_WATCHDOG_EVENTS:-500}"
STATE_DIR="${CC_WATCHDOG_STATE:-/var/lib/cc-remote-watchdog}"
# Most fleet machines run their agent with NO memory ceiling, so there is no
# memory.high to cross and `memory.events: high` stays at zero forever — the
# signal that caught the stage incident does not exist there. What happens
# instead is that a runaway eats the BOX until the OOM killer picks a victim,
# and it picks by size, which on these machines is usually the agent. So: treat
# the machine running out of memory as the same emergency.
MEM_AVAIL_MIN_PCT="${CC_WATCHDOG_MEM_AVAIL_PCT:-10}"

log() { echo "[agent-watchdog] $*"; }

# Percent of RAM the kernel thinks is still obtainable without swapping.
# MemAvailable, not MemFree: page cache is free for practical purposes and
# MemFree reads near zero on every healthy long-lived box.
mem_available_pct() {
  awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{ if (t>0) printf "%d", a*100/t }' /proc/meminfo 2>/dev/null
}

# Processes that are the POINT of the cgroup. Killing one of these is destroying
# work, which is the caller's decision and never this script's: the agent is what
# we are trying to save, and a `claude`/`codex` binary IS somebody's live run.
is_protected() {
  case "$1" in
    *"/agent.mjs"*|*" agent.mjs"*) return 0 ;;
    *"claude-agent-sdk-"*"/claude"*) return 0 ;;
    *"/codex-"*|*"/codex "*|*"bin/codex"*) return 0 ;;
  esac
  return 1
}

agent_units() {
  if [ -n "$ONLY_UNIT" ]; then echo "$ONLY_UNIT"; return; fi
  systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null |
    awk '{print $1}' |
    grep -E '^(cc-remote-agent|cc-remote-agent-.*|cc-remote-sandbox@.*)\.service$'
}

# memory.pressure "full avg60" — the share of time EVERY task in the group was
# stalled. "some" counts one task stalling; "full" is the one that means the
# group is not making progress.
pressure_full_avg60() {
  local cg="$1" line
  line=$(grep '^full ' "$cg/memory.pressure" 2>/dev/null) || return 1
  echo "$line" | sed -n 's/.*avg60=\([0-9.]*\).*/\1/p'
}

# Anonymous memory: the part the kernel CANNOT free without swap. Page cache
# also counts toward the cgroup's ceiling, and an agent that reads transcripts
# all day keeps it pinned near the limit as a matter of course — reading total
# usage would call that an emergency every minute. Anon over the ceiling is the
# real thing, and it is what the 21.09 incident looked like: anon 3418MB
# against MemoryHigh=3G (stage has 10G since 29.09).
anon_bytes() {
  awk '/^anon /{print $2; exit}' "$1/memory.stat" 2>/dev/null
}

# How many times the kernel has throttled this group for crossing memory.high.
# The value is cumulative for the life of the cgroup, so only the DELTA between
# runs says anything — a box up for months carries the scars of old incidents.
throttle_events() {
  awk '/^high /{print $2; exit}' "$1/memory.events" 2>/dev/null
}

# Delta since the previous run, and remember the new value. First ever run for a
# unit reports 0: with no baseline the honest answer is "ask me again in a minute",
# not a number that would fire on a counter someone else earned.
throttle_delta() {
  local unit="$1" now="$2" prev delta
  local file="$STATE_DIR/${unit}.high"
  [ -n "$now" ] || return 1
  mkdir -p "$STATE_DIR" 2>/dev/null
  prev=$(cat "$file" 2>/dev/null)
  printf '%s\n' "$now" > "$file" 2>/dev/null
  case "$prev" in ''|*[!0-9]*) echo 0; return ;; esac
  # A cgroup that was recreated (service restart) starts counting from zero.
  [ "$now" -lt "$prev" ] && { echo 0; return; }
  delta=$((now - prev))
  echo "$delta"
}

cgroup_path() {
  local unit="$1" rel
  rel=$(systemctl show "$unit" -p ControlGroup --value 2>/dev/null)
  [ -n "$rel" ] || return 1
  echo "/sys/fs/cgroup${rel}"
}

# Largest non-protected process in the group, old enough and big enough to blame.
find_hog() {
  local cg="$1" floor="$2" pid rss age cmd best_pid="" best_rss=0 best_cmd="" best_age=0
  [ -r "$cg/cgroup.procs" ] || return 1
  while read -r pid; do
    [ -n "$pid" ] || continue
    rss=$(awk '/^VmRSS:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null) || continue
    [ -n "$rss" ] || continue
    [ "$rss" -ge "$floor" ] || continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    [ -n "$cmd" ] || continue
    is_protected "$cmd" && continue
    age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$age" ] || continue
    [ "$age" -ge "$HOG_MIN_AGE" ] || continue
    if [ "$rss" -gt "$best_rss" ]; then
      best_pid="$pid"; best_rss="$rss"; best_cmd="$cmd"; best_age="$age"
    fi
  done < "$cg/cgroup.procs"
  [ -n "$best_pid" ] || return 1
  echo "$best_pid|$best_rss|$best_age|$best_cmd"
}

check_unit() {
  local unit="$1" cg current high max limit floor pressure throttled hog events delta reason anon shown_limit shown_anon
  cg=$(cgroup_path "$unit") || { log "$unit: no cgroup, skipping"; return; }
  [ -d "$cg" ] || { log "$unit: cgroup $cg is gone, skipping"; return; }

  current=$(systemctl show "$unit" -p MemoryCurrent --value 2>/dev/null)
  high=$(systemctl show "$unit" -p MemoryHigh --value 2>/dev/null)
  max=$(systemctl show "$unit" -p MemoryMax --value 2>/dev/null)
  pressure=$(pressure_full_avg60 "$cg")
  case "$current" in ''|*[!0-9]*) log "$unit: MemoryCurrent unreadable, skipping"; return ;; esac

  # The ceiling that actually throttles: memory.high first, memory.max second.
  limit=""
  case "$high" in ''|infinity|*[!0-9]*) : ;; *) limit="$high" ;; esac
  if [ -z "$limit" ]; then
    case "$max" in ''|infinity|*[!0-9]*) : ;; *) limit="$max" ;; esac
  fi

  # Stalled at all? Three independent tells, because each one alone has a blind
  # spot:
  #  - `memory.events: high` climbing is the kernel saying outright that it is
  #    throttling this group. The most direct signal there is.
  #  - pressure, for a group being held down without crossing a ceiling of its
  #    own (the box itself is short on memory).
  #  - current >= limit, which is how the real incident presented: anonymous
  #    memory with no swap CANNOT be reclaimed, so the group overshoots and sits
  #    there. Where the memory is reclaimable the kernel instead pins `current`
  #    just under the limit and this test never fires — which is why it is not
  #    the only one.
  events=$(throttle_events "$cg")
  delta=$(throttle_delta "$unit" "$events")
  throttled=0
  reason=""
  if [ -n "$delta" ] && [ "$delta" -ge "$THROTTLE_EVENTS_MIN" ]; then
    throttled=1; reason="+$delta throttle events since last check"
  fi
  # `awk` because these are decimals and the shell cannot compare them.
  if [ -n "$pressure" ] && awk -v p="$pressure" -v m="$PRESSURE_MIN" 'BEGIN{exit !(p>=m)}'; then
    throttled=1; reason="${reason:+$reason, }stalled ${pressure}% of the last minute"
  fi
  if [ -n "$avail_pct" ] && [ "$avail_pct" -lt "$MEM_AVAIL_MIN_PCT" ]; then
    throttled=1; reason="${reason:+$reason, }machine down to ${avail_pct}% free memory"
  fi
  anon=$(anon_bytes "$cg")
  case "$anon" in ''|*[!0-9]*) anon="" ;; esac
  if [ -n "$limit" ] && [ -n "$anon" ] && [ "$anon" -ge "$limit" ]; then
    throttled=1; reason="${reason:+$reason, }unreclaimable memory over the ceiling"
  fi

  local shown_limit="none" shown_anon="?"
  [ -n "$limit" ] && shown_limit="$((limit/1048576))MB"
  [ -n "$anon" ] && shown_anon="$((anon/1048576))MB"

  if [ "$throttled" -eq 0 ]; then
    log "$unit: ok (mem $((current/1048576))MB, anon $shown_anon, limit $shown_limit, full/avg60 ${pressure:-n/a}%, throttle +${delta:-?})"
    return
  fi

  floor="$HOG_MIN_KB"
  [ -n "$limit" ] || floor="$HOG_MIN_KB_NOLIMIT"

  log "$unit: THROTTLED ($reason) — mem $((current/1048576))MB, anon $shown_anon, limit $shown_limit, full/avg60 ${pressure:-n/a}%"

  if ! hog=$(find_hog "$cg" "$floor"); then
    # The honest dead end. Something else is holding the group down — a genuinely
    # oversized run, a transcript scan, global memory pressure on the box — and
    # none of it is safe to kill from a timer.
    log "$unit: NO HOG to blame (nothing over $((floor/1024))MB and older than ${HOG_MIN_AGE}s that is not the agent or a live run)."
    log "$unit: leaving it alone — a wedged agent with no culprit is a human's call, not a timer's."
    return
  fi

  local pid rss age cmd
  IFS='|' read -r pid rss age cmd <<<"$hog"
  log "$unit: hog pid=$pid rss=$((rss/1024))MB age=${age}s cmd=${cmd:0:200}"
  if [ "$DRY" -eq 1 ]; then
    log "$unit: --dry-run, not killing"
    return
  fi
  if kill -9 "$pid" 2>/dev/null; then
    log "$unit: killed $pid"
  else
    log "$unit: could not kill $pid (already gone?)"
    return
  fi
  sleep 3
  current=$(systemctl show "$unit" -p MemoryCurrent --value 2>/dev/null)
  case "$current" in
    ''|*[!0-9]*) : ;;
    *) log "$unit: memory now $((current/1048576))MB" ;;
  esac
}

avail_pct=$(mem_available_pct)
units=$(agent_units)
if [ -z "$units" ]; then
  log "no running agent units on this machine"
  exit 0
fi
for unit in $units; do
  check_unit "$unit"
done
