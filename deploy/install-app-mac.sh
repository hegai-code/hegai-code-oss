#!/bin/bash
# Hegai Code для Mac — установка одной командой:
#
#   curl -fsSL https://code.acme.test/install/app-mac.sh | bash
#
# Скачивает нотарифицированную сборку из /dl/HegaiCode.zip и кладёт её в
# «Программы». Никаких вопросов не задаёт — команду можно вставить в Терминал
# или отдать Claude Code. Запущенную копию аккуратно закрывает и заменяет.
#
# Переменные для нестандартных случаев:
#   CC_APP_BASE  — другой хаб (по умолчанию https://code.acme.test)
#   CC_APP_DEST  — другая папка назначения (по умолчанию /Applications,
#                  без прав на неё — ~/Applications)
set -euo pipefail

BASE="${CC_APP_BASE:-https://code.acme.test}"
APP="Hegai Code.app"

[[ "$(uname)" == "Darwin" ]] || { echo "Hegai Code для Mac ставится только на macOS." >&2; exit 1; }

os_ver="$(sw_vers -productVersion)"
if [[ "${os_ver%%.*}" -lt 26 ]]; then
  echo "Нужна macOS 26 (Tahoe) или новее — сейчас $os_ver." >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hegai-code.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "==> Скачиваю Hegai Code…"
curl -fSL --progress-bar "$BASE/dl/HegaiCode.zip" -o "$tmp/HegaiCode.zip"

echo "==> Распаковываю…"
ditto -x -k "$tmp/HegaiCode.zip" "$tmp/unpacked"
[[ -d "$tmp/unpacked/$APP" ]] || { echo "В архиве нет «${APP}» — сообщите владельцу пространства." >&2; exit 1; }

dest="${CC_APP_DEST:-/Applications}"
if [[ ! -d "$dest" || ! -w "$dest" ]]; then
  dest="$HOME/Applications"
  mkdir -p "$dest"
fi

if pgrep -xq "Hegai Code"; then
  echo "==> Закрываю запущенный Hegai Code…"
  osascript -e 'tell application "Hegai Code" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do pgrep -xq "Hegai Code" || break; sleep 1; done
  pkill -x "Hegai Code" 2>/dev/null || true
fi

rm -rf "${dest:?}/${APP:?}"
ditto "$tmp/unpacked/$APP" "$dest/$APP"

if spctl --assess --type execute "$dest/$APP" 2>/dev/null; then
  echo "==> Подпись в порядке: notarized Developer ID."
else
  echo "==> Внимание: Gatekeeper не принял сборку — сообщите владельцу пространства." >&2
fi

echo "==> Установлено: $dest/$APP"
open "$dest/$APP" 2>/dev/null || true
echo "Готово. На первом экране нажмите «Войти через HegAI»."
