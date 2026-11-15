#!/usr/bin/env bash
# Install the dev-box tools: hegai-queue-audit and the weekly PDCA review.
# Run as root on dev-box-1. Idempotent. Nothing is started except the timer.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 0755 "$here/queue-audit.py" /usr/local/bin/hegai-queue-audit

# PDCA: keep the scripts where the unit expects them, symlink the entry point.
dest=/opt/hegai-pdca
install -d -m 0755 "$dest"
install -m 0755 "$here/pdca/run.sh" "$here/pdca/digest.py" "$dest/"
install -m 0644 "$here/pdca/PROMPT.md" "$dest/"
ln -sfn "$dest/run.sh" /usr/local/bin/hegai-pdca
install -d -m 0700 /root/.claude/pdca/proposals
install -m 0644 "$here/pdca/hegai-pdca.service" "$here/pdca/hegai-pdca.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hegai-pdca.timer
echo "installed: hegai-queue-audit, hegai-pdca (timer: $(systemctl list-timers hegai-pdca.timer --no-legend | awk '{print $1,$2,$3}'))"
