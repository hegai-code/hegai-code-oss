#!/bin/bash
# Runs one ssh tunnel bound to the physical interface, so it does not depend on
# the VPN: a dead Happ server takes the default route with it, and these two
# tunnels are the only way into the mini. launchd's KeepAlive restarts us, and
# the interface is looked up again on each start.
#   hegai-uplink.sh <ssh arguments>
here=$(cd "$(dirname "$0")" && pwd)
iface=$("$here/physical-iface.sh")
if [ -z "$iface" ]; then
  echo "hegai-uplink: no physical default route" >&2
  sleep 10
  exit 1
fi
exec /usr/bin/ssh -B "$iface" "$@"
