#!/usr/bin/env bash
# Подключает ЭТОТ сервер к своему hub как машину владельца — без /go и ручного
# кода. Запуск от root, после `docker compose up -d --build`. Безопасно
# перезапускать: подключённый сервер остаётся как есть.
#
#   sudo ./connect-host.sh            подключить (или ничего, если уже подключён к этому hub)
#   sudo ./connect-host.sh --force    подключить заново: например, база hub пересоздана
#
# Агент ставится под отдельным пользователем `hegai` (systemd --user, linger):
# так сессии Claude/Codex живут не от root. Одноразовый секрет берётся из .env
# (CC_REMOTE_HOST_ENROLLMENT_SECRET). С --force секрет заменяется новым (hub
# перезапускается и засевает его), а старый ключ агента откладывается только
# перед самой установкой и возвращается, если подключение не удалось.
set -euo pipefail
cd "$(dirname "$0")"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1
[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo ./connect-host.sh" >&2; exit 1; }
[ -r .env ] || { echo "Нет .env - сначала ./init.sh" >&2; exit 2; }

env_get() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true; }
DOMAIN="$(env_get HEGAI_DOMAIN)"
SECRET="$(env_get CC_REMOTE_HOST_ENROLLMENT_SECRET)"
[ -n "$DOMAIN" ] || { echo "В .env не задан HEGAI_DOMAIN" >&2; exit 2; }
[ "${#SECRET}" -ge 32 ] || { echo "В .env нет CC_REMOTE_HOST_ENROLLMENT_SECRET (>= 32 символов). Добавьте его и сделайте: docker compose up -d" >&2; exit 2; }

USER_NAME=hegai
if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "[connect] создаю пользователя $USER_NAME"
  useradd -m -s /bin/bash "$USER_NAME"
fi
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
UID_N="$(id -u "$USER_NAME")"

# A device token is bound to the hub that issued it. «Already connected» only
# when the agent also points at THIS domain; a token left over from another hub
# (or --force, e.g. after the hub database was recreated) is replaced - but the
# working agent.json is set aside only right before the new install, and put
# back if that fails (SET_ASIDE=1 marks the need).
AGENT_JSON="$HOME_DIR/.cc-remote/agent.json"
AGENT_ENV="$HOME_DIR/.cc-remote/env"
SET_ASIDE=0
BAK=""
if [ -s "$AGENT_JSON" ] && grep -q '"deviceToken"' "$AGENT_JSON"; then
  if [ "$FORCE" = 0 ] && grep -qx "CENTRAL_URL=wss://$DOMAIN" "$AGENT_ENV" 2>/dev/null; then
    echo "[connect] этот сервер уже подключён к https://$DOMAIN (подключить заново: --force)"
    exit 0
  fi
  SET_ASIDE=1
fi

agent_ctl() {
  runuser -u "$USER_NAME" -- env "XDG_RUNTIME_DIR=/run/user/$UID_N" systemctl --user "$@"
}
restore_agent() {
  if [ -n "$BAK" ] && [ -e "$BAK" ]; then
    echo "[connect] возвращаю прежний ключ агента ($BAK)" >&2
    rm -f "$AGENT_JSON"
    mv "$BAK" "$AGENT_JSON"
    agent_ctl restart cc-remote-agent.service 2>/dev/null || true
  fi
}
wait_health() {
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

# --force: the old one-time secret may already be spent. A fresh one goes into
# .env (0600) and the hub is restarted so it seeds it (INSERT OR IGNORE by the
# new hash) BEFORE anything on the agent side is touched.
if [ "$FORCE" = 1 ]; then
  SECRET="$(openssl rand -hex 32)"
  umask 077
  grep -v '^CC_REMOTE_HOST_ENROLLMENT_SECRET=' .env > .env.new || true
  printf 'CC_REMOTE_HOST_ENROLLMENT_SECRET=%s\n' "$SECRET" >> .env.new
  chmod 600 .env.new
  mv .env.new .env
  echo "[connect] --force: новый одноразовый секрет, перезапускаю hub"
  docker compose up -d hub
  wait_health || { echo "hub не ответил после перезапуска (docker compose logs hub); ключ агента не тронут" >&2; exit 3; }
fi

echo "[connect] жду, пока https://$DOMAIN/health ответит (до 5 минут; сертификат выпускается при первом заходе)"
wait_health || { echo "hub не отвечает на https://$DOMAIN/health. Проверьте DNS, порты 80/443 и docker compose logs hub" >&2; exit 3; }

loginctl enable-linger "$USER_NAME"
echo "[connect] жду пользовательскую шину systemd"
for _ in $(seq 1 30); do
  [ -S "/run/user/$UID_N/bus" ] && break
  sleep 1
done
[ -S "/run/user/$UID_N/bus" ] || { echo "нет /run/user/$UID_N/bus - systemd --user для $USER_NAME не поднялся (systemctl status user@$UID_N)" >&2; exit 4; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 755 "$TMP"
curl -fsSL "https://$DOMAIN/install/install-linux.sh" -o "$TMP/install-linux.sh"
chmod 644 "$TMP/install-linux.sh"

# The secret goes by file, never argv: /proc/<pid>/cmdline is world-readable
# for the minutes npm runs, and whoever exchanges it first owns the machine.
CODE_FILE="$TMP/enrollment-code"
( umask 077; printf '%s' "$SECRET" > "$CODE_FILE" )
chown "$USER_NAME" "$CODE_FILE"

if [ "$SET_ASIDE" = 1 ]; then
  echo "[connect] ключ агента от другого hub или --force - откладываю его на время установки"
  agent_ctl stop cc-remote-agent.service 2>/dev/null || true
  BAK="$AGENT_JSON.bak-$(date +%Y%m%d%H%M%S)"
  mv "$AGENT_JSON" "$BAK"
fi

echo "[connect] ставлю агента под $USER_NAME"
if ! runuser -u "$USER_NAME" -- env "HOME=$HOME_DIR" "XDG_RUNTIME_DIR=/run/user/$UID_N" \
     "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_N/bus" \
     bash "$TMP/install-linux.sh" --enrollment-code-file "$CODE_FILE" --name "$(hostname)" --url "wss://$DOMAIN"; then
  restore_agent
  echo >&2
  echo "Установка агента не удалась. Если npm не собрал node-pty, поставьте сборочные зависимости:" >&2
  echo "  apt-get install -y build-essential python3     (Debian/Ubuntu)" >&2
  echo "и запустите ./connect-host.sh ещё раз. Путь к журналу npm — в сообщении выше" >&2
  exit 5
fi

echo "[connect] жду, пока агент обменяет код на ключ устройства"
for _ in $(seq 1 60); do
  grep -q '"deviceToken"' "$HOME_DIR/.cc-remote/agent.json" 2>/dev/null && break
  sleep 2
done
if ! grep -q '"deviceToken"' "$HOME_DIR/.cc-remote/agent.json" 2>/dev/null; then
  restore_agent
  echo "Агент установлен, но не подключился: hub не принял код (уже использован, короче 32 символов или hub запущен без CC_REMOTE_HOST_ENROLLMENT_SECRET)." >&2
  echo "Смотрите: docker compose logs hub; runuser -u $USER_NAME -- journalctl --user -u cc-remote-agent -n 50" >&2
  echo "Подключить вручную: curl -fsSL https://$DOMAIN/go | bash  (под $USER_NAME)" >&2
  exit 6
fi

# With the bundled LLM gateway on (./llm.sh enable), this server's agent must
# trust it (CC_REMOTE_GATEWAY_URL in a root-owned drop-in). No-op otherwise.
./llm.sh agent-env || echo "[connect] не удалось прописать агенту шлюз: sudo ./llm.sh agent-env" >&2

echo "[connect] готово: сервер подключён как машина владельца. Дальше - ссылка настройки: docker compose logs hub"
