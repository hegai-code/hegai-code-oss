#!/bin/bash
# Hegai Code для Mac (оболочка вокруг веб-интерфейса) — установка одной командой:
#
#   curl -fsSL https://code.acme.test/install/app-mac-shell.sh | bash
#
# Ставит Tauri-сборку HegaiCode-mac.zip (всегда от Hegai, см. CC_APP_DL). От нативной она отличается тем,
# что интерфейс в ней — тот же самый code.acme.test: он обновляется вместе с
# вебом, без переустановки. Переустанавливать этой же командой нужно только
# саму оболочку, и это бывает редко.
#
# Пока идёт переход, нативная сборка остаётся на месте (/dl/HegaiCode.zip,
# install/app-mac.sh) — это и есть путь отката.
#
# Переменные для нестандартных случаев:
#   CC_APP_BASE  — другой хаб (по умолчанию https://code.acme.test). Хаб
#                  запоминается в приложении (файл hub-url), и оно открывает его.
#   CC_APP_DL    — откуда качать сборку (по умолчанию — раздача Hegai:
#                  собственные хабы клиентов сборок не раздают)
#   CC_APP_DEST  — другая папка назначения (по умолчанию /Applications,
#                  без прав на неё — ~/Applications)
set -euo pipefail

BASE="${CC_APP_BASE:-https://code.acme.test}"
BASE="${BASE%/}"
# Эти две строки с пометкой vendor-literal хаб при выдаче скрипта НЕ переписывает
# (server-rs/src/selfhost.rs): сборки лежат у Hegai, а не на хабе клиента.
DEFAULT_HUB="https://code.acme.test" # vendor-literal
DL="${CC_APP_DL:-https://code.acme.test/dl}" # vendor-literal
DL="${DL%/}"
APP="Hegai Code.app"
# Команда Hegai — по ней проверяется, что перед нами наша подпись, а не
# одноимённое приложение откуда-то ещё.
TEAM_ID="AZWU5VAA73"

[[ "$(uname)" == "Darwin" ]] || { echo "Hegai Code для Mac ставится только на macOS." >&2; exit 1; }

# Порог ниже нативного (там macOS 26): оболочка — обычное окно WebKit, и её
# ограничивает не SwiftUI, а то, какой WebKit сможет отрисовать SPA.
os_ver="$(sw_vers -productVersion)"
if [[ "${os_ver%%.*}" -lt 13 ]]; then
  echo "Нужна macOS 13 (Ventura) или новее — сейчас $os_ver." >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hegai-code.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "==> Скачиваю Hegai Code…"
curl -fSL --progress-bar "$DL/HegaiCode-mac.zip" -o "$tmp/HegaiCode-mac.zip"
# Вместо архива можно получить страницу (HTML ошибки или index.html сайта) —
# тогда ditto падает невнятным «not a PKZip». Проверяем сигнатуру zip: «PK».
if [[ "$(head -c 2 "$tmp/HegaiCode-mac.zip" 2>/dev/null)" != "PK" ]]; then
  echo "Скачался не архив Hegai Code (адрес: $DL/HegaiCode-mac.zip). Сообщите владельцу пространства." >&2
  exit 1
fi

echo "==> Распаковываю…"
ditto -x -k "$tmp/HegaiCode-mac.zip" "$tmp/unpacked"
[[ -d "$tmp/unpacked/$APP" ]] || { echo "В архиве нет «${APP}» — сообщите владельцу пространства." >&2; exit 1; }

# ПРОВЕРКА ДО ЗАМЕНЫ.
#
# Прежний скрипт сносил рабочую копию, ставил новую и только потом спрашивал
# Gatekeeper — то есть про испорченную загрузку человек узнавал, когда откатываться
# было уже не на что. Проверяем распакованное во временной папке: если сборка не
# та, на диске всё ещё стоит рабочее приложение.
echo "==> Проверяю подпись…"
if ! spctl --assess --type execute "$tmp/unpacked/$APP" 2>/dev/null; then
  echo "Gatekeeper не принял сборку — ничего не менял. Сообщите владельцу пространства." >&2
  exit 1
fi
# Вывод сначала в переменную, и только потом сравнение.
#
# Очевидная запись `codesign … | grep -q …` здесь СЛУЧАЙНО ломается: `grep -q`
# закрывает канал, как только нашёл совпадение, `codesign` получает SIGPIPE и
# умирает со 141, а `set -o pipefail` берёт статусом конвейера именно его смерть.
# То есть проверка тем вероятнее «не находит» подпись, чем быстрее она её нашла,
# и зависит от того, влез ли вывод в буфер канала. Поймано на живой установке
# 21.09.2026: та же сборка сначала прошла, а после степлинга — «подписана не
# командой Hegai».
signature="$(codesign -dvv "$tmp/unpacked/$APP" 2>&1 || true)"
if [[ "$signature" != *"TeamIdentifier=$TEAM_ID"* ]]; then
  echo "Сборка подписана не командой Hegai — ничего не менял." >&2
  exit 1
fi
echo "==> Подпись в порядке: notarized Developer ID, команда $TEAM_ID."

dest="${CC_APP_DEST:-/Applications}"
if [[ ! -d "$dest" || ! -w "$dest" ]]; then
  dest="$HOME/Applications"
  mkdir -p "$dest"
fi

# Закрываем ОБЕ реализации.
#
# `Hegai Code` — процесс нативной (Swift) сборки, `hegai-code` — исполняемый файл
# внутри этой, Tauri (Cargo.toml задаёт имя бинаря). Скрипт, который знает только
# первое имя, при обновлении оболочки поверх оболочки подменит бандл под живым
# процессом: ditto перезапишет файлы, старый процесс останется в памяти, а новый
# запуск отдаст ему фокус через single-instance — и человек увидит старую версию,
# считая, что обновился.
for proc in "Hegai Code" "hegai-code"; do
  if pgrep -xq "$proc"; then
    echo "==> Закрываю запущенный ${proc}…"
    osascript -e 'tell application "Hegai Code" to quit' >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do pgrep -xq "$proc" || break; sleep 1; done
    pkill -x "$proc" 2>/dev/null || true
    for _ in 1 2 3 4 5; do pgrep -xq "$proc" || break; sleep 1; done
  fi
done
if pgrep -xq "Hegai Code" || pgrep -xq "hegai-code"; then
  echo "Hegai Code не закрылся — закройте его вручную и повторите команду." >&2
  exit 1
fi

# Сносим старую копию в ОБЕИХ папках.
#
# Скрипт умеет ставить и в ~/Applications (когда нет прав на /Applications), так
# что после смены прав легко остаётся вторая копия с тем же bundle id. Тогда
# Launch Services сама решает, какую запускать, — а уведомления и TCC привязаны
# к id, не к пути.
for d in "/Applications" "${HOME:-/nonexistent}/Applications"; do
  [[ "$d" == "$dest" ]] && continue
  if [[ -d "$d/$APP" ]]; then
    echo "==> Убираю прежнюю копию из ${d}…"
    rm -rf "${d:?}/$APP" 2>/dev/null || true
  fi
done

rm -rf "${dest:?}/$APP"
ditto "$tmp/unpacked/$APP" "$dest/$APP"

echo "==> Установлено: $dest/$APP"

# Хаб запоминаем ДО запуска: приложение читает файл один раз при старте.
# Каталог — тот, что Tauri считает app_config_dir для идентификатора
# net.hegai.ccremote.mac. Для code.acme.test файл убираем: по умолчанию хаб
# и так он, а старый файл от другого хаба увёл бы приложение не туда.
cfg="$HOME/Library/Application Support/net.hegai.ccremote.mac"
if [[ "$BASE" != "$DEFAULT_HUB" ]]; then
  mkdir -p "$cfg"
  printf '%s' "$BASE" > "$cfg/hub-url"
  echo "==> Сервер: $BASE"
else
  rm -f "$cfg/hub-url"
fi

open "$dest/$APP" 2>/dev/null || true
if [[ "$BASE" == "$DEFAULT_HUB" ]]; then
  echo "Готово. На первом экране нажмите «Войти через HegAI» — вход нужен заново:"
else
  echo "Готово. На первом экране войдите в свой аккаунт на $BASE — вход нужен заново:"
fi
echo "оболочка хранит сессию по-своему и прежний вход нативной сборки не видит."
echo "Сменить сервер позже: значок в строке меню -> «Сервер…»."
