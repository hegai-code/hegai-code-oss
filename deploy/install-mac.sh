#!/usr/bin/env bash
# Install the cc-remote agent on a macOS machine as a per-USER LaunchAgent.
#
# The agent must run as the logged-in person, in their session: it reads THEIR
# ~/.claude (Claude Code) and ~/.codex (Codex) sessions and uses their existing
# logins. So this is a LaunchAgent (gui/<uid>), NOT a system LaunchDaemon.
#
# Prereqs on the target: the person already uses Claude Code and/or Codex (their
# logins are in place). Node is auto-fetched if a suitable one isn't on PATH.
#
# Usage (run a downloaded copy of this script; it fetches the current bundle):
#   ./install-mac.sh --name "Anna's MBP" --enrollment-code <ONE_TIME_CODE> \
#                    [--url wss://code.acme.test]
set -euo pipefail

CENTRAL_URL="wss://code.acme.test"
NAME=""
TOKEN=""
ENROLLMENT_CODE=""
LINK=0
CHAT_ONLY="${HEGAI_CHAT_ONLY:-0}"
SYNC_ALL=0
NODE_VERSION="${NODE_VERSION:-v22.11.0}"   # portable Node fetched only if none on PATH

while [ $# -gt 0 ]; do
  case "$1" in
    --name)  NAME="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --enrollment-code) ENROLLMENT_CODE="$2"; shift 2;;
    # No credential at all: the agent asks the hub for a code and this script
    # prints it — the person approves it on code.acme.test/link, from any device.
    --link)  LINK=1; shift;;
    --url)   CENTRAL_URL="$2"; shift 2;;
    --chat-only) CHAT_ONLY=1; shift;;
    --sync-all)  SYNC_ALL=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
if [ "$LINK" = 0 ] && [ -z "$TOKEN" ] && [ -z "$ENROLLMENT_CODE" ]; then echo "ERROR: --enrollment-code, --link or --token is required" >&2; exit 2; fi
if [ -n "$TOKEN" ] && [ -n "$ENROLLMENT_CODE" ]; then echo "ERROR: pass only one credential" >&2; exit 2; fi
CRED_KEY=""; CRED_VALUE=""
if [ -n "$ENROLLMENT_CODE" ]; then CRED_KEY="CC_REMOTE_ENROLLMENT_CODE"; CRED_VALUE="$ENROLLMENT_CODE"; elif [ -n "$TOKEN" ]; then CRED_KEY="CC_REMOTE_TOKEN"; CRED_VALUE="$TOKEN"; fi
NAME="${NAME:-$(id -un)@$(scutil --get ComputerName 2>/dev/null || hostname -s)}"

# Per-run temp dir; kept on failure so the npm log survives.
TMPD="$(mktemp -d)"
trap 'if [ $? -eq 0 ]; then rm -rf "$TMPD"; fi' EXIT

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/cc-remote-agent"
LABEL="ai.heg.ccremote.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DEST" "$HOME/Library/LaunchAgents"

echo "[install] copying agent bundle → $DEST"
DOWNLOAD_BASE="${CENTRAL_URL/wss:\/\//https://}"; DOWNLOAD_BASE="${DOWNLOAD_BASE/ws:\/\//http://}"; DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"
# --- verify the bundle against the hash the hub publishes next to it ----------
# agent.mjs.sha256 is the same file agents check on self-update. A mismatch
# refuses the install: the download is discarded and nothing is replaced. No
# usable hash (an older hub that never served it, no sha tool) only warns, so
# an install does not depend on a file the hub may not have. An old hub answers
# an unknown /install/ path with the SPA's index.html and a 200, so the body
# has to LOOK like a sha256 before it is believed.
verify_agent_bundle() {
  local file="$1" want got
  want="$(curl -fsSL "$DOWNLOAD_BASE/install/agent.mjs.sha256" 2>/dev/null | head -n 1 | awk '{print $1}' | tr 'A-F' 'a-f')" || want=""
  if ! printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "[install] WARNING: the hub publishes no usable agent.mjs.sha256 - agent bundle NOT verified" >&2
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$file" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  else
    echo "[install] WARNING: neither sha256sum nor shasum found - agent bundle NOT verified" >&2
    return 0
  fi
  if [ "$got" != "$want" ]; then
    rm -f "$file"
    echo "ERROR: agent bundle checksum mismatch (downloaded ${got}, hub publishes ${want}). Nothing was installed." >&2
    echo "       A hub deploy may be in progress: re-run in a minute. If it repeats, do not install - tell the hub operator." >&2
    exit 1
  fi
  echo "[install] agent bundle verified (sha256 ${got:0:12})"
}

if [ -f "$SRC/agent.mjs" ] && [ -f "$SRC/package.json" ]; then
  cp "$SRC/agent.mjs" "$SRC/package.json" "$DEST/"
else
  echo "[install] downloading current agent bundle from $DOWNLOAD_BASE"
  curl -fsSL "$DOWNLOAD_BASE/install/agent.mjs" -o "$DEST/agent.mjs.download"
  verify_agent_bundle "$DEST/agent.mjs.download"
  mv -f "$DEST/agent.mjs.download" "$DEST/agent.mjs"
  curl -fsSL "$DOWNLOAD_BASE/install/package.json" -o "$DEST/package.json"
fi

# --- resolve a supported Node 20..24 runtime ----------------------------------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] 2>/dev/null && [ "$major" -lt 25 ] 2>/dev/null && NODE_BIN="$(command -v node)"
fi
if [ -z "$NODE_BIN" ] && [ -x "$DEST/node/bin/node" ]; then
  major=$("$DEST/node/bin/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] 2>/dev/null && [ "$major" -lt 25 ] 2>/dev/null && NODE_BIN="$DEST/node/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  arch=$(uname -m); case "$arch" in arm64) narch=arm64;; x86_64) narch=x64;; *) echo "unsupported arch $arch" >&2; exit 4;; esac
  tarball="node-${NODE_VERSION}-darwin-${narch}.tar.gz"
  echo "[install] no supported Node 20..24 found — fetching portable ${NODE_VERSION} (${narch})"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" -o "$TMPD/$tarball" \
    || { echo "ERROR: could not download Node. Install Node 20..24 and re-run." >&2; exit 4; }
  rm -rf "$DEST/node"; mkdir -p "$DEST/node"
  tar -xzf "$TMPD/$tarball" -C "$DEST/node" --strip-components=1
  NODE_BIN="$DEST/node/bin/node"
fi
NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
echo "[install] node: $NODE_BIN ($("$NODE_BIN" --version))"

echo "[install] npm install (2 runtime deps: sdk, node-pty)"
( cd "$DEST" && PATH="$NODE_DIR:$PATH" "$NODE_DIR/npm" install --omit=dev --no-audit --no-fund >"$TMPD/npm-install.log" 2>&1 ) \
  || { echo "ERROR: npm install failed — see $TMPD/npm-install.log" >&2; exit 5; }

# --- what this machine allows (agent/src/policy.ts, ~/.cc-remote/policy.json) ----
# A NEW machine syncs nothing until its owner picks folders (Настройки → Железо,
# or `node agent.mjs policy sync add <folder>`) or starts a session in one from
# the site. A reinstall over an existing agent keeps whatever was chosen.
# --chat-only: no terminal, file/git writes, process kill, runtime install/login
# or no-approval modes on this machine. --sync-all: the old «everything» sync.
if [ ! -e "$HOME/.cc-remote/policy.json" ] && [ ! -s "$HOME/.cc-remote/agent.json" ] && [ "$SYNC_ALL" = 0 ]; then
  "$NODE_BIN" "$DEST/agent.mjs" policy sync selected >/dev/null
fi
if [ "$SYNC_ALL" = 1 ]; then "$NODE_BIN" "$DEST/agent.mjs" policy sync all >/dev/null; fi
if [ "$CHAT_ONLY" = 1 ]; then "$NODE_BIN" "$DEST/agent.mjs" policy chat-only on >/dev/null; fi

# --- where is codex? ------------------------------------------------------------
# This script runs in the person's own shell, where nvm/volta/fnm ARE loaded;
# the LaunchAgent below gets a fixed PATH where they are not. So the shell's
# answer is written into the agent's environment. The agent also searches the
# usual places itself (runtime-locate.ts); a stale path here is ignored there,
# so recording one can never make things worse than not recording it.
CODEX_BIN_PLIST=""
if CODEX_DETECTED="$(command -v codex 2>/dev/null)" && [ -n "$CODEX_DETECTED" ]; then
  echo "[install] codex: $CODEX_DETECTED"
  CODEX_BIN_PLIST="
    <key>CODEX_BIN</key><string>$CODEX_DETECTED</string>"
else
  echo "[install] codex: not on this shell's PATH — Codex sessions need 'npm install -g @openai/codex' (the machine card will say so)"
fi

# --- write the LaunchAgent -----------------------------------------------------
echo "[install] writing $PLIST"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>EnvironmentVariables</key>
  <dict>
$( [ -n "$CRED_KEY" ] && printf '    <key>%s</key><string>%s</string>\n' "$CRED_KEY" "$CRED_VALUE" )
    <key>CENTRAL_URL</key><string>$CENTRAL_URL</string>
    <key>MACHINE_NAME</key><string>$NAME</string>
    <key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>$CODEX_BIN_PLIST
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST/agent.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/agent.log</string>
  <key>StandardErrorPath</key><string>$DEST/agent.log</string>
</dict>
</plist>
PLISTEOF

echo "[install] (re)loading LaunchAgent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "[install] ✅ agent '$NAME' running → $CENTRAL_URL"
  echo "[install]    logs: $DEST/agent.log"
else
  echo "[install] ⚠️  agent did not start — check $DEST/agent.log" >&2; exit 6
fi

# --- link mode: show the code the agent asked for -------------------------------
if [ "$LINK" = 1 ] && ! grep -q '"deviceToken"' "$HOME/.cc-remote/agent.json" 2>/dev/null; then
  for _ in $(seq 1 40); do
    if grep -q "Откройте" "$DEST/agent.log" 2>/dev/null; then break; fi
    sleep 1
  done
  echo
  grep "\[agent\] [┌│└]" "$DEST/agent.log" | tail -4 | sed 's/^\[agent\] //'
  echo
  echo "[install] Подтвердите код на ${DOWNLOAD_BASE#*://}/link — с этого компьютера или с телефона. Машина появится в «Машинах» сама."
fi
