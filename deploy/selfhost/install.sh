#!/usr/bin/env bash
# Hegai Code на своём сервере — одной командой, от root:
#
#   sudo ./install.sh code.example.com owner@example.com
#
# 1. .env с секретами (init.sh; существующий .env не трогается);
# 2. hub и Caddy в Docker (docker compose up -d --build, первый раз 10–20 минут);
# 3. ЭТОТ сервер подключается как машина владельца (connect-host.sh);
# 4. печатает одноразовую ссылку настройки владельца (пароль + аутентификатор).
#
# Безопасно перезапускать: каждый шаг пропускает уже сделанное.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo ./install.sh <домен> <e-mail владельца>" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Нужен Docker с плагином Compose v2 (docker compose version)" >&2; exit 2; }

if [ ! -e .env ]; then
  HEGAI_INIT_QUIET=1 ./init.sh "$@"
else
  echo "[install] .env уже есть - использую его"
fi

# A .env from an older install has no one-time host secret: add one (0600) so
# connect-host.sh works. CC_REMOTE_PUSH_RELAY is NOT added to an existing .env -
# the relay stays opt-in there.
if [ "$(grep -E '^CC_REMOTE_HOST_ENROLLMENT_SECRET=' .env | tail -n 1 | cut -d= -f2- | tr -d "\"' " | wc -c)" -lt 33 ]; then
  echo "[install] в .env нет CC_REMOTE_HOST_ENROLLMENT_SECRET - генерирую"
  ( umask 077
    grep -v '^#\?CC_REMOTE_HOST_ENROLLMENT_SECRET=' .env > .env.new || true
    printf 'CC_REMOTE_HOST_ENROLLMENT_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.new
    chmod 600 .env.new
    mv .env.new .env )
fi

echo "[install] собираю и запускаю hub (первый раз 10–20 минут)"
docker compose up -d --build

status=0
./connect-host.sh || {
  status=$?
  echo "[install] ВНИМАНИЕ: подключение этого сервера не удалось (код $status) - ссылку владельца всё равно выпускаю; повторить: ./connect-host.sh" >&2
}

email="$(grep -E '^CC_REMOTE_BOOTSTRAP_EMAIL=' .env | tail -n 1 | cut -d= -f2-)"
echo
echo "[install] ссылка настройки владельца (${email}; действует 24 ч, одна на владельца):"
if ! docker compose exec -T hub /app/cc-remote-server setup-link --email "$email" --hours 24; then
  echo "  не удалось выпустить - возьмите её из: docker compose logs hub" >&2
fi
echo
echo "Другие машины: curl -fsSL https://$(grep -E '^HEGAI_DOMAIN=' .env | tail -n 1 | cut -d= -f2-)/go | bash   (Windows: irm …/go.ps1 | iex)"
exit "$status"
