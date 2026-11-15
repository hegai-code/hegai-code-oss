#!/usr/bin/env bash
# Keep every sandbox agent on the bundle the hub serves — the sandbox half of
# «a hub deploy IS the agent rollout» (agent/src/self-update.ts).
#
# Sandbox agents cannot update themselves: they run the shared root-owned
# release under ProtectSystem=strict, and their self-update switches itself off
# for exactly that reason. So this runs from cron on the sandbox host:
#
#   1. hub's /install/agent.mjs.sha256 names a release we do not have →
#      `sb-agent-update.sh --no-restart` installs it and flips `current`;
#   2. every sandbox unit started BEFORE the flip is restarted — but only when
#      it is quiet: no Claude child whose pid file says busy/waiting, and no
#      Codex rollout written in the last 10 min. A busy sandbox is left for a
#      later tick; nobody loses a turn to an update.
#
# cron: */5 * * * * root /opt/cc-remote-agent/sandbox/sb-agent-autoupdate.sh >> /var/log/sb-agent-autoupdate.log 2>&1
set -u
HUB="${CC_REMOTE_HUB_URL:-https://code.acme.test}"
ROOT=/opt/cc-remote-agent
say() { echo "$(date '+%F %T') $*"; }

want="$(curl -fsS -m 20 "$HUB/install/agent.mjs.sha256" | cut -c1-12)" || exit 0
[[ "$want" =~ ^[0-9a-f]{12}$ ]] || { say "no usable hash from $HUB"; exit 0; }
cur="$(basename "$(readlink -f "$ROOT/current")")"
if [ "$cur" != "$want" ]; then
  say "hub serves $want, current is $cur — installing"
  bash "$ROOT/sandbox/sb-agent-update.sh" --no-restart || { say "install failed"; exit 1; }
  cur="$(basename "$(readlink -f "$ROOT/current")")"
  [ "$cur" = "$want" ] || { say "installed $cur, hub still says $want — next tick"; exit 0; }
fi

flip="$(stat -c %Y "$ROOT/current")"   # the symlink's own mtime: when it last flipped
for unit in $(systemctl list-units --no-legend --plain 'cc-remote-sandbox@*' | awk '$3=="active"{print $1}'); do
  user="${unit#cc-remote-sandbox@}"; user="${user%.service}"
  started="$(date -d "$(systemctl show "$unit" -p ActiveEnterTimestamp --value)" +%s 2>/dev/null || echo 0)"
  [ "$started" -ge "$flip" ] && continue
  main="$(systemctl show "$unit" -p MainPID --value)"
  quiet=1
  for k in $(ps -e -o pid=,ppid=,args= | awk -v m="$main" '$2==m && /claude-agent-sdk/ {print $1}'); do
    s="$(sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' "/home/$user/.claude/sessions/$k.json" 2>/dev/null)"
    [ "$s" = idle ] || quiet=0
  done
  if ps -e -o ppid=,args= | awk -v m="$main" '$1==m && /codex/' | grep -q .; then
    [ -z "$(find "/home/$user/.codex/sessions" -name '*.jsonl' -mmin -10 2>/dev/null | head -1)" ] || quiet=0
  fi
  if [ $quiet = 1 ]; then
    say "restarting $unit onto $cur"; systemctl restart "$unit"; sleep 2
  else
    say "$unit busy — next tick"
  fi
done
