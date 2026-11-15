#!/usr/bin/env bash
# Hegai Code — connect this machine with one command:
#
#   curl -fsSL https://code.acme.test/go | bash
#
# Installs the agent (macOS: LaunchAgent; Linux: systemd, system or --user)
# with no credential. The agent then asks the hub for a short code and this
# script prints it: approve it on https://code.acme.test/link from any device
# where you are signed in — nothing to copy from a website into a terminal,
# nothing that expires in your clipboard. Re-running is safe: an already
# connected machine keeps its credential and just updates the bundle.
set -euo pipefail

BASE="${HEGAI_URL:-https://code.acme.test}"
WS="wss://${BASE#https://}"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
TMP="$TMPD/cc-remote-install.sh"

case "$(uname -s)" in
  Darwin)
    curl -fsSL "$BASE/install/install-mac.sh" -o "$TMP"
    bash "$TMP" --link --url "$WS" "$@"
    ;;
  Linux)
    curl -fsSL "$BASE/install/install-linux.sh" -o "$TMP"
    bash "$TMP" --link --url "$WS" "$@"
    ;;
  *)
    echo "Windows: open PowerShell and run" >&2
    echo "  irm $BASE/go.ps1 | iex" >&2
    exit 2
    ;;
esac
