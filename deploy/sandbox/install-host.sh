#!/usr/bin/env bash
# One-time (and idempotent) preparation of a sandbox host — run as root ON the
# box, from a copy of deploy/sandbox/:
#
#   scp -r deploy/sandbox stage:/root/cc-remote-sandbox
#   ssh stage 'bash /root/cc-remote-sandbox/install-host.sh'
#
# What it does, every run:
#   - group `sandbox` (the primary group of every sb-* user)
#   - /opt/cc-remote-agent/{releases,sandbox} + the current agent release
#     (sb-agent-update.sh: bundle from the hub, npm deps under /usr/bin/node)
#   - systemd: cc-remote-sandbox@.service, sandboxes.slice,
#     cc-remote-provisioner.service (+ daemon-reload)
#   - /etc/cc-remote/provisioner.env from the example if missing (0600)
#   - sshd drop-in: DenyGroups sandbox, PasswordAuthentication no (sshd -t first)
#   - /var/backups/sandboxes (0700) for delete archives
#
# Opt-in flags, because both touch things other tenants of the box depend on:
#   --egress   nftables egress filter for group `sandbox` (needs `nft`; the box
#              runs ufw, and this table is added BESIDE ufw's, never replacing it)
#   --hidepid  remount /proc with hidepid=2 so sandboxes cannot list other
#              users' processes. CHECK FIRST that nothing running as a non-root
#              user needs to see foreign pids (pm2 as the hegai user only lists
#              its own; monitoring agents may not). Users that must see
#              everything go into group `proc-readers`.
#   --no-agent skip the agent release fetch (offline dry run of the rest)
set -euo pipefail
umask 022

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/cc-remote-agent
GROUP=sandbox
EGRESS=0
HIDEPID=0
AGENT=1
for arg in "$@"; do
  case "$arg" in
    --egress) EGRESS=1 ;;
    --hidepid) HIDEPID=1 ;;
    --no-agent) AGENT=0 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 2; }
for f in provisioner.mjs sb-agent-update.sh sb-agent-autoupdate.sh sb-monitor.sh cc-remote-sandbox@.service sandboxes.slice cc-remote-provisioner.service provisioner.env.example; do
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f — copy the whole deploy/sandbox directory" >&2; exit 2; }
done

summary=()
note() { echo "[install-host] $1"; summary+=("$1"); }

# --- prerequisites -------------------------------------------------------------
NODE="${SANDBOX_NODE:-/usr/bin/node}"
if [ ! -x "$NODE" ]; then echo "no node at $NODE (Node 20–24 required; node-pty is ABI-bound)" >&2; exit 3; fi
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] && [ "$major" -lt 25 ] || { echo "node at $NODE is v$major; need 20–24" >&2; exit 3; }
CODEX="${SANDBOX_CODEX_BIN:-/usr/bin/codex}"
[ -x "$CODEX" ] || echo "[install-host] WARNING: no codex at $CODEX — sandboxes cannot start sessions until it exists"
command -v runuser >/dev/null || { echo "runuser (util-linux) is required" >&2; exit 3; }

# --- group ----------------------------------------------------------------------
if getent group "$GROUP" >/dev/null; then note "group $GROUP exists (gid $(getent group "$GROUP" | cut -d: -f3))"
else groupadd --system "$GROUP"; note "group $GROUP created (gid $(getent group "$GROUP" | cut -d: -f3))"; fi

# --- layout ---------------------------------------------------------------------
mkdir -p "$ROOT/releases" "$ROOT/sandbox" /etc/cc-remote /var/backups/sandboxes
chmod 755 "$ROOT" "$ROOT/releases" "$ROOT/sandbox"
chmod 700 /var/backups/sandboxes
install -m 755 "$SRC/provisioner.mjs" "$ROOT/sandbox/provisioner.mjs"
install -m 755 "$SRC/sb-agent-update.sh" "$ROOT/sandbox/sb-agent-update.sh"
install -m 755 "$SRC/sb-monitor.sh" "$ROOT/sandbox/sb-monitor.sh"
install -m 755 "$SRC/sb-agent-autoupdate.sh" "$ROOT/sandbox/sb-agent-autoupdate.sh"
# Sandboxes follow hub deploys on their own (see the script's header).
echo '*/5 * * * * root /opt/cc-remote-agent/sandbox/sb-agent-autoupdate.sh >> /var/log/sb-agent-autoupdate.log 2>&1' > /etc/cron.d/sb-agent-autoupdate
chmod 644 /etc/cron.d/sb-agent-autoupdate
note "scripts installed to $ROOT/sandbox/"

# --- agent release --------------------------------------------------------------
if [ "$AGENT" -eq 1 ]; then
  SANDBOX_NODE="$NODE" bash "$ROOT/sandbox/sb-agent-update.sh" --no-restart
  note "agent release: $(cat "$ROOT/current/VERSION" 2>/dev/null || echo '?') at $(readlink -f "$ROOT/current")"
else
  note "agent release skipped (--no-agent)"
fi

# --- systemd --------------------------------------------------------------------
install -m 644 "$SRC/cc-remote-sandbox@.service" /etc/systemd/system/cc-remote-sandbox@.service
install -m 644 "$SRC/sandboxes.slice" /etc/systemd/system/sandboxes.slice
install -m 644 "$SRC/cc-remote-provisioner.service" /etc/systemd/system/cc-remote-provisioner.service
systemctl daemon-reload
note "units installed: cc-remote-sandbox@.service, sandboxes.slice, cc-remote-provisioner.service"

# --- provisioner env ------------------------------------------------------------
if [ -f /etc/cc-remote/provisioner.env ]; then
  chmod 600 /etc/cc-remote/provisioner.env
  if grep -qE '^CC_REMOTE_PROVISIONER_TOKEN=.{32,}' /etc/cc-remote/provisioner.env; then
    note "provisioner.env present with a token"
  else
    note "provisioner.env present but CC_REMOTE_PROVISIONER_TOKEN is EMPTY — fill it, then: systemctl enable --now cc-remote-provisioner"
  fi
else
  install -m 600 "$SRC/provisioner.env.example" /etc/cc-remote/provisioner.env
  note "provisioner.env created from the example — FILL CC_REMOTE_PROVISIONER_TOKEN (same value as on the hub), then: systemctl enable --now cc-remote-provisioner"
fi
if [ ! -f /etc/cc-remote/sb-monitor.env ] && [ -f "$SRC/sb-monitor.env.example" ]; then
  install -m 600 "$SRC/sb-monitor.env.example" /etc/cc-remote/sb-monitor.env
  note "sb-monitor.env created from the example — add TG_BOT_TOKEN / TG_CHAT_ID and the cron lines from sb-monitor.sh"
fi

# --- sshd -----------------------------------------------------------------------
if [ -d /etc/ssh/sshd_config.d ]; then
  if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
    echo "[install-host] WARNING: /etc/ssh/sshd_config does not Include sshd_config.d/*.conf — the drop-in below will be ignored" >&2
  fi
  drop=/etc/ssh/sshd_config.d/60-sandbox.conf
  tmp="$(mktemp)"
  cat > "$tmp" <<'EOF'
# Community sandboxes reach the box only through their cc-remote agent
# (which dials out). No ssh for the group, no passwords for anyone.
DenyGroups sandbox
PasswordAuthentication no
EOF
  if [ -f "$drop" ] && cmp -s "$tmp" "$drop"; then
    rm -f "$tmp"; note "sshd drop-in unchanged"
  else
    install -m 644 "$tmp" "$drop"; rm -f "$tmp"
    if sshd -t 2>/dev/null; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
      note "sshd drop-in installed ($drop) and sshd reloaded — key-only logins from now on"
    else
      rm -f "$drop"
      echo "[install-host] sshd -t FAILED with the drop-in — removed it again, sshd untouched" >&2
      sshd -t || true
    fi
  fi
else
  echo "[install-host] WARNING: no /etc/ssh/sshd_config.d — add 'DenyGroups sandbox' to sshd_config by hand" >&2
fi

# --- egress filter (opt-in) -------------------------------------------------------
if [ "$EGRESS" -eq 1 ]; then
  if ! command -v nft >/dev/null; then
    echo "[install-host] --egress: nft not found (apt install nftables) — skipped" >&2
  else
    mkdir -p /etc/nftables.d
    cat > /etc/nftables.d/sandbox.nft <<'EOF'
#!/usr/sbin/nft -f
# Egress policy for processes running as group `sandbox`. Lives in its own
# table so it coexists with ufw (iptables-nft): a packet must pass both.
# Allowed out: replies to established flows, DNS, ssh/http/https (git, npm,
# the hub, the gateway). Dropped: mail submission ports (a compromised
# sandbox must not become a spam relay) and everything else.
#
# Loopback (08.10.2026): a sandbox may reach only listeners that themselves
# run inside sandboxes.slice (its own dev server, test servers, preview
# port) plus the local DNS stub. Every host service on 127.0.0.1/::1 —
# databases, SSH tunnels to prod, the SOCKS proxy, Next apps — is refused.
# The sandbox's new loopback flows are tagged with a conntrack mark on the
# way out; the input hook checks which cgroup owns the receiving socket.
table inet sandbox_egress
delete table inet sandbox_egress
table inet sandbox_egress {
    chain output {
        type filter hook output priority filter; policy accept;
        meta skgid sandbox jump sandbox
    }
    chain sandbox {
        ct state established,related accept
        oif "lo" meta l4proto { tcp, udp } th dport 53 accept
        # Preview ports: each belongs to one sandbox (port = 3110 + uid - 20000,
        # provisioner.mjs previewFor). Another sandbox may not reach it.
        oif "lo" tcp dport 3110-3112 meta skuid . tcp dport != { 20000 . 3110, 20001 . 3111, 20002 . 3112 } counter reject with tcp reset
        oif "lo" ct state new ct mark set 0x5b0c accept
        oif "lo" accept
        meta l4proto { tcp, udp } th dport 53 accept
        tcp dport { 25, 465, 587 } counter drop
        tcp dport { 22, 80, 443 } accept
        limit rate 5/minute log prefix "sandbox-egress-drop " level info
        counter drop
    }
    chain loopback_in {
        type filter hook input priority filter; policy accept;
        iif != "lo" accept
        ct mark != 0x5b0c accept
        ct state != new accept
        socket cgroupv2 level 1 "sandboxes.slice" accept
        limit rate 5/minute log prefix "sandbox-lo-drop " level info
        meta l4proto tcp counter reject with tcp reset
        counter drop
    }
}
EOF
    nft -f /etc/nftables.d/sandbox.nft
    cat > /etc/systemd/system/sandbox-egress.service <<'EOF'
[Unit]
Description=nftables egress policy for community sandboxes
# loopback_in matches `socket cgroupv2 ... "sandboxes.slice"`, which nft
# resolves at load time: the slice's cgroup must already exist.
After=network-pre.target ufw.service sandboxes.slice
Wants=network-pre.target
Requires=sandboxes.slice

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables.d/sandbox.nft
ExecStop=/usr/sbin/nft delete table inet sandbox_egress

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now sandbox-egress.service >/dev/null 2>&1 || true
    note "egress filter loaded (table inet sandbox_egress) and persisted via sandbox-egress.service"
  fi
fi

# --- hidepid (opt-in) -------------------------------------------------------------
if [ "$HIDEPID" -eq 1 ]; then
  getent group proc-readers >/dev/null || groupadd --system proc-readers
  gid="$(getent group proc-readers | cut -d: -f3)"
  # polkit verifies callers through /proc; without membership every non-root
  # `systemctl`/`pkexec` on the box breaks. Add it when the account exists.
  id polkitd >/dev/null 2>&1 && usermod -a -G proc-readers polkitd
  mount -o remount,hidepid=2,gid="$gid" /proc
  if grep -qE '^\s*proc\s+/proc\s' /etc/fstab; then
    echo "[install-host] --hidepid: /etc/fstab already has a proc line — make sure it carries hidepid=2,gid=$gid" >&2
  else
    printf 'proc /proc proc defaults,hidepid=2,gid=%s 0 0\n' "$gid" >> /etc/fstab
  fi
  note "/proc remounted with hidepid=2,gid=$gid (group proc-readers); persisted in fstab"
fi

# --- summary -------------------------------------------------------------------
echo
echo "==================== sandbox host ready ===================="
for s in "${summary[@]}"; do echo " - $s"; done
echo
echo " next:"
echo "   1. put the token in /etc/cc-remote/provisioner.env (matches CC_REMOTE_PROVISIONER_TOKEN on the hub)"
echo "   2. systemctl enable --now cc-remote-provisioner && journalctl -fu cc-remote-provisioner"
echo "   3. or run one job by hand: node $ROOT/sandbox/provisioner.mjs local job.json   (see SANDBOX.md)"
echo "   4. cron: $ROOT/sandbox/sb-monitor.sh every 5 min, --daily once a day"
echo "============================================================"
