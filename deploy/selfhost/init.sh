#!/usr/bin/env bash
# Создаёт deploy/selfhost/.env со сгенерированными секретами. Безопасно
# перезапускать: существующий .env не перезаписывается (удалите его, чтобы начать заново).
#
#   ./init.sh                                  спросит домен и e-mail владельца
#   ./init.sh code.example.com owner@example.com
#   ./init.sh code.example.com owner@example.com "Example Code"
#
# Третий аргумент — название в интерфейсе (CC_REMOTE_BRAND_NAME; лого в
# боковой панели рисует «Example Code» как «example.code»). Без него название
# берётся из домена — code.anomaly.ru → «Anomaly Code» — и в терминале
# предлагается подтвердить или поменять (Enter — согласиться).
set -euo pipefail
cd "$(dirname "$0")"

[ ! -e .env ] || { echo ".env уже есть - не трогаю (удалите его, чтобы создать заново)." >&2; exit 1; }
command -v openssl >/dev/null || { echo "Нужен openssl" >&2; exit 2; }

domain="${1:-}"
email="${2:-}"
brand="${3:-}"
if [ -z "$domain" ]; then read -r -p "Домен, на котором будет hub (например, code.example.com): " domain; fi
if [ -z "$email" ]; then read -r -p "E-mail владельца: " email; fi
case "$domain" in
  ""|*[!A-Za-z0-9.-]*|.*|*.|*..*) echo "это не доменное имя: '$domain'" >&2; exit 2 ;;
esac
case "$email" in
  *@*.*) ;;
  *) echo "это не похоже на e-mail: '$email'" >&2; exit 2 ;;
esac

# Название: метка домена перед зоной, с заглавной, + «Code».
# code.anomaly.ru → «Anomaly Code», clientco.ru → «Clientco Code».
if [ -z "$brand" ]; then
  stem="$(printf '%s' "$domain" | tr 'A-Z' 'a-z' | awk -F. '{ i = (NF >= 2 ? NF - 1 : 1)
    if (NF >= 3 && $i ~ /^(co|com|org|net|gov|edu|ac|spb|msk)$/) i--
    print $i }')"
  suggested="$(printf '%s' "${stem:0:1}" | tr 'a-z' 'A-Z')${stem:1} Code"
  if [ -t 0 ]; then
    read -r -p "Название в интерфейсе [${suggested}] (лого: ${stem}.code): " brand || true
  fi
  brand="${brand:-$suggested}"
fi
brand="$(printf '%s' "$brand" | tr -s ' \t\r\n' ' ' | sed -e 's/^ //' -e 's/ $//')"
case "$brand" in
  ""|*[\\\|\&\"\'\$\`\#]*) echo "название не должно быть пустым и содержать \\ | & \" ' \$ \` #: '$brand'" >&2; exit 2 ;;
esac

umask 077
token="$(openssl rand -hex 32)"
host_secret="$(openssl rand -hex 32)"
{
  sed -e "s|^HEGAI_DOMAIN=.*|HEGAI_DOMAIN=${domain}|" \
      -e "s|^CC_REMOTE_TOKEN=.*|CC_REMOTE_TOKEN=${token}|" \
      -e "s|^CC_REMOTE_BOOTSTRAP_EMAIL=.*|CC_REMOTE_BOOTSTRAP_EMAIL=${email}|" \
      -e "s|^#\?CC_REMOTE_BRAND_NAME=.*|CC_REMOTE_BRAND_NAME=${brand}|" \
      -e "s|^#\?CC_REMOTE_PUSH_RELAY=.*|CC_REMOTE_PUSH_RELAY=on|" \
      -e "s|^#\?CC_REMOTE_HOST_ENROLLMENT_SECRET=.*|CC_REMOTE_HOST_ENROLLMENT_SECRET=${host_secret}|" \
      .env.example
} > .env
chmod 600 .env

if [ "${HEGAI_INIT_QUIET:-0}" = 1 ]; then
  echo "[install] .env записан: домен ${domain}, владелец ${email}, название «${brand}»"
  exit 0
fi

cat <<MSG
Записан $(pwd)/.env (0600): домен ${domain}, владелец ${email}, название «${brand}», новый токен флота из 64 символов.
(Переименовать: CC_REMOTE_BRAND_NAME в .env, затем docker compose up -d.)

Дальше (или запустите sudo ./install.sh - он делает всё сразу):
  docker compose up -d --build
  sudo ./connect-host.sh         # подключает ЭТОТ сервер как машину владельца
  docker compose logs hub        # здесь печатается одноразовая ссылка настройки владельца
MSG
