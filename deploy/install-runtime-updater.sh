#!/usr/bin/env bash
# Install the nightly runtime updater on THIS machine: a systemd timer that runs
# `update-runtimes.sh`, keeps a log, and is quiet unless something broke.
#
# Why a timer per machine rather than a loop from one box: agents dial out only,
# there is no inbound path to most of the fleet (deploy/FLEET.md), and three
# machines cannot be reached headlessly from anywhere at all. A machine that
# updates itself needs no route in.
#
# The hour is staggered by machine name rather than fixed, so the whole fleet
# does not pull npm — and restart its agents — in the same minute. Restarting
# every agent at once is a real interruption; DEPLOY-RULES rule 7 says so about
# the hub, and it is no less true here.
#
# Usage:
#   install-runtime-updater.sh                 # install + enable, do not run now
#   install-runtime-updater.sh --run-now       # …and run one pass immediately
#   install-runtime-updater.sh --agent-dir D --unit U --name N   # second agent
#   install-runtime-updater.sh --uninstall
set -uo pipefail

# The Mac agent lives in the user's home, not /root: without this a plain
# re-install on the mini (28.09.2026) wrote a job that failed every night with
# «нет каталога агента /home/cc-remote-agent».
if [ "$(uname -s)" = Darwin ]; then AGENT_DIR="${AGENT_DIR:-$HOME/cc-remote-agent}"; fi
AGENT_DIR="${AGENT_DIR:-/home/cc-remote-agent}"
UNIT="${UNIT:-cc-remote-agent}"
RUN_AS=''
NAME=''
RUN_NOW=0
UNINSTALL=0
SRC="$(cd "$(dirname "$0")" && pwd)/update-runtimes.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="${2:-}"; shift 2 ;;
    --unit)      UNIT="${2:-}"; shift 2 ;;
    --user)      RUN_AS="${2:-}"; shift 2 ;;
    --name)      NAME="${2:-}"; shift 2 ;;
    --run-now)   RUN_NOW=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "не понимаю аргумент «$1»" >&2; exit 2 ;;
  esac
done

# macOS schedules with launchd and runs the agent as a LaunchAgent in the
# logged-in user's session, so there is nothing for root to do there — and
# `sudo launchctl` would target the wrong domain. One installer, two branches,
# because the thing being installed is the same on both.
MAC=0; [ "$(uname -s)" = 'Darwin' ] && MAC=1
[ "$MAC" = 1 ] || [ "$(id -u)" -eq 0 ] || { echo "нужен root" >&2; exit 2; }
NAME="${NAME:-$UNIT-runtimes}"
SVC="/etc/systemd/system/${NAME}.service"
TMR="/etc/systemd/system/${NAME}.timer"
DEST=/usr/local/sbin/cc-remote-update-runtimes
LOG=/var/log/cc-remote-runtimes.log

if [ "$UNINSTALL" = 1 ]; then
  systemctl disable --now "${NAME}.timer" 2>/dev/null
  rm -f "$SVC" "$TMR"; systemctl daemon-reload
  echo "снято: ${NAME}.timer"; exit 0
fi

[ -f "$SRC" ] || { echo "рядом нет update-runtimes.sh ($SRC)" >&2; exit 1; }
if [ "$MAC" = 1 ]; then
  DEST="$HOME/cc-remote-agent/update-runtimes.sh"
  LOG="$HOME/cc-remote-agent/runtimes-update.log"
  PLIST="$HOME/Library/LaunchAgents/ai.heg.ccremote.runtimes.plist"
  LABEL='ai.heg.ccremote.runtimes'
  AGENT_LOG="$HOME/cc-remote-agent/agent.log"
  [ "$UNINSTALL" = 1 ] && { launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$PLIST"; echo "снято: $LABEL"; exit 0; }
  # All three parts, not `--only sdk` (as it was until 28.09.2026): the Mac's
  # codex is an npm package under Homebrew's prefix, and the updater now
  # installs into the prefix of the codex it finds and checks `--version`, so
  # the old reason to keep it out — `npm -g` on PATH pointing at some other
  # node — is gone. The mini sat on codex 0.154 and `claude` 2.1.123 because
  # of that flag. PATH is spelled out: `bash -l` reads a bash profile, and a
  # zsh user's Homebrew PATH is not in it.
  install -m755 "$SRC" "$DEST"
  H="$(hostname | cksum | awk '{print $1}')"; HOUR=$(( 3 + H % 3 )); MIN=$(( H / 7 % 60 ))
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string>
    <string>PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH $DEST --agent-dir $AGENT_DIR --restart-cmd 'launchctl kickstart -k gui/\$(id -u)/ai.heg.ccremote.agent' --log-file $AGENT_LOG >> $LOG 2>&1</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>RunAtLoad</key><false/>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null
  echo "поставлено: $LABEL -> ${HOUR}:$(printf '%02d' "$MIN") ежедневно, лог $LOG"
  if [ "$RUN_NOW" = 1 ]; then
    echo "--- один проход сейчас:"
    PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" "$DEST" --agent-dir "$AGENT_DIR" \
      --restart-cmd "launchctl kickstart -k gui/$(id -u)/ai.heg.ccremote.agent" \
      --log-file "$AGENT_LOG" 2>&1 | tee -a "$LOG"
  fi
  exit 0
fi
install -m755 "$SRC" "$DEST"

# Stagger: a stable hash of the hostname, so the same box always lands on the
# same minute and two boxes rarely share one. Deliberately not random — a time
# that moves every install is a time nobody can correlate a failure with.
H="$(hostname | cksum | awk '{print $1}')"
HOUR=$(( 3 + H % 3 ))         # 03:00–05:00, the quiet window on this fleet
MIN=$(( H / 7 % 60 ))

cat > "$SVC" <<EOF
[Unit]
Description=cc-remote: обновить рантаймы сессий ($UNIT)
Documentation=file://$DEST

[Service]
Type=oneshot
# The updater restarts the agent itself and verifies it reconnected; it must not
# be killed halfway through that, or the box is left on a half-installed runtime.
TimeoutStartSec=900
ExecStart=/bin/bash -lc '$DEST --agent-dir $AGENT_DIR --unit $UNIT${RUN_AS:+ --user $RUN_AS} >> $LOG 2>&1'
EOF

cat > "$TMR" <<EOF
[Unit]
Description=cc-remote: ночное обновление рантаймов ($UNIT)

[Timer]
OnCalendar=*-*-* ${HOUR}:$(printf '%02d' "$MIN"):00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "${NAME}.timer" >/dev/null 2>&1
echo "поставлено: ${NAME}.timer -> ${HOUR}:$(printf '%02d' "$MIN") ежедневно, лог $LOG"
systemctl list-timers "${NAME}.timer" --no-pager 2>/dev/null | sed -n '2p'

if [ "$RUN_NOW" = 1 ]; then
  echo "--- один проход сейчас:"
  "$DEST" --agent-dir "$AGENT_DIR" --unit "$UNIT" ${RUN_AS:+--user "$RUN_AS"} 2>&1 | tee -a "$LOG"
fi
