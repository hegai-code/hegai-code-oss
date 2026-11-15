#!/bin/bash
# Run once by a person on the mini: sudo bash ~/bin/hegai-mini/install-reboot-guard.sh
# Copies the guard into root-owned paths, so nothing the user can write runs as root.
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
install -d -o root -g wheel -m 755 /usr/local/libexec
install -o root -g wheel -m 755 "$here/mini-reboot-guard.sh" /usr/local/libexec/mini-reboot-guard
install -o root -g wheel -m 644 "$here/ai.heg.mini-reboot-guard.plist" /Library/LaunchDaemons/ai.heg.mini-reboot-guard.plist
launchctl bootout system/ai.heg.mini-reboot-guard 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/ai.heg.mini-reboot-guard.plist
launchctl print system/ai.heg.mini-reboot-guard | grep -m1 state
echo "installed"
