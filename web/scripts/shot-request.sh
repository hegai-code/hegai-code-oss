#!/usr/bin/env bash
# Ask for a screenshot from inside a sandbox that cannot open a browser.
#
# Pairs with `shot-broker.sh`, which must already be running outside the
# sandbox. See the long note there for why this exists and why the only thing
# that crosses the boundary is a screen name.
#
#   bash web/scripts/shot-request.sh sessionBusyInset
#
# Prints where the results landed. The PNGs and the geometry JSON that
# `shot.mjs` writes are in that directory; read the JSON, look at the PNG.
set -uo pipefail

SPOOL="${SHOT_SPOOL:-/tmp/shot-broker}"
screen="${1:-}"
timeout="${2:-240}"

if [[ -z "$screen" ]]; then
  echo "usage: shot-request.sh <screen> [timeout-seconds]" >&2
  exit 2
fi
if [[ ! -d "$SPOOL/req" ]]; then
  echo "no broker: $SPOOL/req does not exist — ask the parent session to start web/scripts/shot-broker.sh" >&2
  exit 3
fi

id="$$-$(date +%s)"
printf '%s' "$screen" > "$SPOOL/req/$id"

waited=0
while [[ ! -f "$SPOOL/res/$id/.done" ]]; do
  sleep 2
  waited=$((waited + 2))
  if (( waited >= timeout )); then
    echo "timed out after ${timeout}s waiting for $SPOOL/res/$id/.done" >&2
    exit 4
  fi
done

out="$SPOOL/res/$id"
echo "--- broker log ---"
cat "$out/log.txt" 2>/dev/null
echo "--- files in $out ---"
ls -1 "$out"
exit "$(cat "$out/exit" 2>/dev/null || echo 0)"
