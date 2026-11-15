#!/usr/bin/env bash
# A screenshot for an agent that cannot open a browser.
#
# Codex runs under a seccomp sandbox with `network: restricted`: launching
# Chrome dies on `setsockopt: Operation not permitted` and Vite cannot even
# `listen` on loopback. So a delegated agent can read every line of the CSS and
# still never see the page — which is exactly the half of a layout bug that
# reading cannot settle.
#
# This runs OUTSIDE that sandbox and does the one thing the sandbox forbids.
# The agent writes a screen name into a spool file; this takes the picture and
# writes it back. The only thing that crosses the boundary is a screen name,
# validated against `[A-Za-z0-9_-]+` — not a command, not a path, not a flag.
# Widening that is how a convenience becomes a sandbox escape.
#
#   Server (outside the sandbox):  bash web/scripts/shot-broker.sh
#   Client (inside it):            bash web/scripts/shot-request.sh <screen>
#
# Results land in $SPOOL/res/<id>/ — the PNGs and the geometry JSON that
# `shot.mjs` writes beside them.
set -uo pipefail

SPOOL="${SHOT_SPOOL:-/tmp/shot-broker}"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${CHROME_PATH:=/root/.cache/puppeteer/chrome/linux-144.0.7559.96/chrome-linux64/chrome}"
export CHROME_PATH

mkdir -p "$SPOOL/req" "$SPOOL/res"
# World-writable spool: the requesting agent may run as another user, and the
# sandbox can write /tmp but nothing else shared.
chmod 777 "$SPOOL" "$SPOOL/req" "$SPOOL/res" 2>/dev/null || true

echo "[broker] watching $SPOOL/req  (web=$WEB)"
echo "[broker] chrome=$CHROME_PATH"

while true; do
  shopt -s nullglob
  for req in "$SPOOL"/req/*; do
    id="$(basename "$req")"
    screen="$(head -c 100 "$req" | tr -d '\r\n' )"
    rm -f "$req"
    out="$SPOOL/res/$id"
    mkdir -p "$out"
    # The validation IS the boundary. Anything that is not a bare screen name
    # is refused rather than sanitised — a name that needed cleaning up is a
    # name that was trying to be something else.
    if [[ ! "$screen" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "refused: screen name must match [A-Za-z0-9_-]+, got: $screen" > "$out/log.txt"
      : > "$out/.done"
      echo "[broker] $id refused ($screen)"
      continue
    fi
    echo "[broker] $id -> $screen"
    ( cd "$WEB" && npm run shot "$screen" ) > "$out/log.txt" 2>&1
    echo "$?" > "$out/exit"
    # Only this screen's artefacts, so a caller cannot fish the whole gallery
    # out of one request.
    cp "$WEB/.shots/$screen"-*.png "$out/" 2>/dev/null
    cp "$WEB/.shots/$screen"-*.json "$out/" 2>/dev/null
    chmod -R a+rX "$out" 2>/dev/null || true
    : > "$out/.done"
    echo "[broker] $id done ($(ls "$out" | wc -l) files)"
  done
  sleep 2
done
