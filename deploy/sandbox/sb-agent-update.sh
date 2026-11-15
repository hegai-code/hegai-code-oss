#!/usr/bin/env bash
# Install or refresh the shared agent release every sandbox runs from.
#
# Layout (root-owned, world-readable — sandbox users only execute it):
#   /opt/cc-remote-agent/releases/<sha256 prefix of agent.mjs>/
#       agent.mjs package.json node_modules/ VERSION
#   /opt/cc-remote-agent/current -> releases/<sha>      (flipped atomically)
#
# The bundle is what the hub itself serves at /install/agent.mjs (embedded in
# the binary, so a deploy refreshes it; the same path on a self-hosted hub); package.json comes from /install/package.json and names the
# two runtime deps that stay external (the Claude SDK and node-pty). node-pty
# is a native addon bound to the Node ABI, which is why the install runs under
# the exact /usr/bin/node the units use.
#
# After a flip, running cc-remote-sandbox@* units are restarted 2 s apart so
# the hub does not see the whole set reconnect in the same instant.
#
# Usage: sb-agent-update.sh [--no-restart]
# Env:   CC_REMOTE_HUB_URL (default https://code.acme.test)
#        SANDBOX_NODE      (default /usr/bin/node)
#        SANDBOX_RELEASES_KEEP (default 3)
set -euo pipefail
umask 022

HUB="${CC_REMOTE_HUB_URL:-https://code.acme.test}"; HUB="${HUB%/}"
NODE="${SANDBOX_NODE:-/usr/bin/node}"
ROOT=/opt/cc-remote-agent
KEEP="${SANDBOX_RELEASES_KEEP:-3}"
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 2; }
[ -x "$NODE" ] || { echo "no node at $NODE" >&2; exit 2; }
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || { echo "npm not found next to $NODE or on PATH" >&2; exit 2; }

mkdir -p "$ROOT/releases"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[sb-agent-update] fetching $HUB/install/agent.mjs"
curl -fsSL "$HUB/install/agent.mjs" -o "$tmp/agent.mjs"
# Verify against the hash deploy-hub.sh publishes next to the bundle (the same
# one agents check on self-update). Mismatch: nothing is installed. No usable
# hash (a hub that never published one): warn and go on. A deploy writes the
# bundle and then its hash, so a mismatch right at a deploy is a retry, not an
# attack - the message says so.
want="$(curl -fsSL "$HUB/install/agent.mjs.sha256" 2>/dev/null | head -n 1 | awk '{print $1}' | tr 'A-F' 'a-f')" || want=""
if printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$'; then
  got="$(sha256sum "$tmp/agent.mjs" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "[sb-agent-update] ERROR: agent.mjs checksum mismatch (downloaded $got, hub publishes $want) - nothing installed." >&2
    echo "[sb-agent-update] A hub deploy may be in progress: re-run in a minute. If it repeats, do not install." >&2
    exit 4
  fi
  echo "[sb-agent-update] agent.mjs verified (sha256 ${got:0:12})"
else
  echo "[sb-agent-update] WARNING: $HUB/install/agent.mjs.sha256 is missing or not a sha256 - bundle NOT verified" >&2
fi
curl -fsSL "$HUB/install/package.json" -o "$tmp/package.json"
# A lockfile is optional: the hub serves none today, so `npm ci` (which needs
# one) is used only when it appears; otherwise a plain omit-dev install.
# A 200 is NOT enough to believe one: an unknown path under /install/ falls
# through to the SPA, so curl happily saves index.html here and `npm ci` then
# dies on it ("needs an existing package-lock.json"). Keep the file only when it
# parses as JSON and carries a lockfileVersion.
if curl -fsSL "$HUB/install/package-lock.json" -o "$tmp/package-lock.json" 2>/dev/null; then
  "$NODE" -e "const l=require(process.argv[1]); if (!l.lockfileVersion) process.exit(1)" "$tmp/package-lock.json" 2>/dev/null \
    || { echo "[sb-agent-update] $HUB/install/package-lock.json is not a lockfile — installing without one"; rm -f "$tmp/package-lock.json"; }
else
  rm -f "$tmp/package-lock.json"
fi

sha="$(sha256sum "$tmp/agent.mjs" | cut -c1-12)"
cur="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
if [ -n "$cur" ] && [ "$(basename "$cur")" = "$sha" ] && [ -f "$cur/agent.mjs" ] && [ -d "$cur/node_modules" ]; then
  echo "[sb-agent-update] current release $sha is already the served bundle — nothing to do"
  exit 0
fi

rel="$ROOT/releases/$sha"
if [ ! -f "$rel/.ready" ]; then
  echo "[sb-agent-update] installing release $sha"
  rm -rf "$rel"; mkdir -p "$rel"
  cp "$tmp/agent.mjs" "$tmp/package.json" "$rel/"
  [ -f "$tmp/package-lock.json" ] && cp "$tmp/package-lock.json" "$rel/"
  (
    cd "$rel"
    PATH="$(dirname "$NODE"):$PATH"
    export PATH
    if [ -f package-lock.json ]; then
      "$NPM" ci --omit=dev --no-audit --no-fund
    else
      "$NPM" install --omit=dev --no-audit --no-fund --no-package-lock
    fi
  ) > "$rel/npm-install.log" 2>&1 || { echo "[sb-agent-update] npm install failed — see $rel/npm-install.log" >&2; exit 5; }
  ver="$("$NODE" -p "require('$rel/package.json').version" 2>/dev/null || echo 0)"
  echo "${ver}+${sha}" > "$rel/VERSION"
  chmod -R a+rX "$rel"
  # Smoke: the bundle must at least parse and load its native dep under this Node.
  (cd "$rel" && "$NODE" -e "require('@homebridge/node-pty-prebuilt-multiarch'); console.log('node-pty ok')") \
    || { echo "[sb-agent-update] node-pty does not load under $NODE — release NOT activated" >&2; exit 6; }
  touch "$rel/.ready"
fi

ln -sfn "$rel" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"
echo "[sb-agent-update] current -> $rel ($(cat "$rel/VERSION"))"

# Prune old releases (never the current one), newest $KEEP kept.
if [ "$KEEP" -gt 0 ]; then
  ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    old="${old%/}"
    [ "$old" = "$rel" ] && continue
    echo "[sb-agent-update] pruning $old"; rm -rf "$old"
  done
fi

if [ "$RESTART" -eq 1 ]; then
  mapfile -t units < <(systemctl list-units 'cc-remote-sandbox@*' --no-legend --plain --state=active,failed 2>/dev/null | awk '{print $1}')
  if [ "${#units[@]}" -eq 0 ]; then
    echo "[sb-agent-update] no sandbox units running"
  else
    echo "[sb-agent-update] restarting ${#units[@]} sandbox unit(s), 2 s apart"
    for u in "${units[@]}"; do
      systemctl reset-failed "$u" 2>/dev/null || true
      systemctl restart "$u" && echo "  restarted $u" || echo "  FAILED to restart $u" >&2
      sleep 2
    done
  fi
fi
