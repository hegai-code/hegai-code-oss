#!/bin/bash
# Moves one launchd autossh tunnel onto hegai-uplink.sh, and puts the old plist
# back if the new job does not stay up. Run it detached: moving the tunnel that
# carries your own session cuts that session.
#   nohup rebind-tunnel.sh <label> >log 2>&1 &
set -u
label=$1
plist=$HOME/Library/LaunchAgents/$label.plist
domain=gui/$(id -u)
backup=$plist.bak-before-uplink
uplink=$HOME/bin/hegai-mini/hegai-uplink.sh

running() { launchctl print "$domain/$label" 2>/dev/null | grep -q 'state = running'; }
reload() {
  launchctl bootout "$domain/$label" 2>/dev/null
  sleep 2
  launchctl bootstrap "$domain" "$plist"
}

if [ ! -e "$backup" ]; then
  tmp=$backup.$$
  { cp "$plist" "$tmp" && mv "$tmp" "$backup"; } || exit 1
fi
/usr/bin/python3 -I - "$plist" "$uplink" <<'PY'
import os, plistlib, sys
path, uplink = sys.argv[1:]
with open(path, "rb") as f:
    job = plistlib.load(f)
args = job["ProgramArguments"]
if args[0].endswith("autossh"):
    if args[1:3] != ["-M", "0"]:
        sys.exit(f"unexpected autossh arguments: {args[1:3]}")
    job["ProgramArguments"] = [uplink] + args[3:]
    with open(path + ".new", "wb") as f:
        plistlib.dump(job, f)
    os.replace(path + ".new", path)
elif args[0] != uplink:
    sys.exit(f"unexpected tunnel program: {args[0]}")
PY
[ $? = 0 ] || exit 1

reload
# launchd respawns a dying job, so running once proves little. Sample it.
sleep 25
pid1=$(launchctl print "$domain/$label" | awk '/^\tpid = / { print $3 }')
sleep 20
pid2=$(launchctl print "$domain/$label" | awk '/^\tpid = / { print $3 }')
if running && [ -n "$pid1" ] && [ "$pid1" = "$pid2" ]; then
  echo "OK $label pid $pid2"
  exit 0
fi
echo "FAILED $label, restoring the old plist"
cp "$backup" "$plist"
reload
exit 1
