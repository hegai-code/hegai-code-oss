#!/usr/bin/env bash
# Hegai Code agent — Linux installer (a person's own server or workstation).
#
#   ./install-linux.sh --link [--name "prod-eu-1"] [--url wss://code.acme.test]
#   ./install-linux.sh --enrollment-code <ONE_TIME_CODE> [--name …]
#
# Installs the agent under ~/cc-remote-agent and keeps it alive with systemd:
# a system unit when run as root, a --user unit (with lingering, so it starts
# at boot without a login) otherwise. Dials OUT only. Reads the person's own
# ~/.claude and ~/.codex logins; installs neither coder — «Начало» on the site
# has the «Войти» buttons for that.
#
# `--link` is the no-credential mode: the agent asks the hub for a short code,
# this script prints it, and the person approves it on code.acme.test/link.
# Deploying a fleet box with the shared token is deploy-server.sh, not this.
set -euo pipefail

CENTRAL_URL="wss://code.acme.test"
NAME=""
TOKEN=""
ENROLLMENT_CODE=""
LINK=0
CHAT_ONLY="${HEGAI_CHAT_ONLY:-0}"
SYNC_ALL=0
NODE_VERSION="${NODE_VERSION:-v22.11.0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --name)  NAME="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --enrollment-code) ENROLLMENT_CODE="$2"; shift 2;;
    # Same, read from a file: keeps the code out of the process list (connect-host.sh).
    --enrollment-code-file) ENROLLMENT_CODE="$(tr -d '[:space:]' < "$2")"; shift 2;;
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
NAME="${NAME:-$(id -un)@$(hostname -s)}"
command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemd is required (no systemctl on PATH)" >&2; exit 3; }

DEST="$HOME/cc-remote-agent"
mkdir -p "$DEST" "$HOME/.cc-remote"
# Per-run temp dir (not a fixed /tmp name: a second user on the same machine
# could not overwrite the first user's files). Kept on failure for the npm log.
TMPD="$(mktemp -d)"
trap 'if [ $? -eq 0 ]; then rm -rf "$TMPD"; fi' EXIT
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

echo "[install] downloading current agent bundle from $DOWNLOAD_BASE"
curl -fsSL "$DOWNLOAD_BASE/install/agent.mjs" -o "$DEST/agent.mjs.download"
verify_agent_bundle "$DEST/agent.mjs.download"
mv -f "$DEST/agent.mjs.download" "$DEST/agent.mjs"
curl -fsSL "$DOWNLOAD_BASE/install/package.json" -o "$DEST/package.json"

# --- Node 20..24 --------------------------------------------------------------
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
  arch=$(uname -m); case "$arch" in aarch64|arm64) narch=arm64;; x86_64) narch=x64;; *) echo "unsupported arch $arch" >&2; exit 4;; esac
  tarball="node-${NODE_VERSION}-linux-${narch}.tar.gz"
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

# --- env file (0600) ------------------------------------------------------------
ENV_FILE="$HOME/.cc-remote/env"
{
  echo "CENTRAL_URL=$CENTRAL_URL"
  echo "MACHINE_NAME=$NAME"
  [ -n "$CRED_KEY" ] && echo "$CRED_KEY=$CRED_VALUE"
  CODEX_DETECTED="$(command -v codex 2>/dev/null || true)"
  [ -n "$CODEX_DETECTED" ] && echo "CODEX_BIN=$CODEX_DETECTED"
  true
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- systemd: system unit as root, --user unit otherwise -------------------------
UNIT_BODY="[Unit]
Description=Hegai Code agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DEST
EnvironmentFile=$ENV_FILE
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
ExecStart=$NODE_BIN $DEST/agent.mjs
Restart=always
RestartSec=5
StandardOutput=append:$DEST/agent.log
StandardError=append:$DEST/agent.log
"
if [ "$(id -u)" = 0 ]; then
  UNIT=/etc/systemd/system/cc-remote-agent.service
  printf '%s\n[Install]\nWantedBy=multi-user.target\n' "$UNIT_BODY" > "$UNIT"
  systemctl daemon-reload
  systemctl enable --now cc-remote-agent >/dev/null
  systemctl restart cc-remote-agent
  ACTIVE="$(systemctl is-active cc-remote-agent || true)"
else
  mkdir -p "$HOME/.config/systemd/user"
  UNIT="$HOME/.config/systemd/user/cc-remote-agent.service"
  printf '%s\n[Install]\nWantedBy=default.target\n' "$UNIT_BODY" > "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now cc-remote-agent >/dev/null
  systemctl --user restart cc-remote-agent
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    loginctl enable-linger "$(id -un)" 2>/dev/null || [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] \
      || echo "[install] Внимание: автозапуск при загрузке не включён — агент стартует только при входе. Исправить: sudo loginctl enable-linger $(id -un)"
  fi
  ACTIVE="$(systemctl --user is-active cc-remote-agent || true)"
fi
sleep 3
if [ "$ACTIVE" = active ]; then
  echo "[install] ✅ agent '$NAME' running → $CENTRAL_URL   (unit: $UNIT)"
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
