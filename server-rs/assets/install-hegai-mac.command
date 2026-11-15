#!/bin/bash
# HegAI Gateway — установщик для Codex CLI / приложения ChatGPT.
# Прописывает провайдера hegai в ~/.codex/config.toml. Ключ уже вшит.
set -euo pipefail

KEY='__KEY__'
BASE='__BASE__'
MODEL='__MODEL__'
# Без этой строки Codex стартует с `reasoning effort: none`.
EFFORT='__EFFORT__'

DIR="${CODEX_HOME:-$HOME/.codex}"
CFG="$DIR/config.toml"
mkdir -p "$DIR"
[ -f "$CFG" ] || : > "$CFG"
cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

TMP="$(mktemp)"
awk -v key="$KEY" -v base="$BASE" -v model="$MODEL" -v effort="$EFFORT" '
  BEGIN { skipblock=0; skiptable=0; seentable=0 }
  /^[[:space:]]*#[[:space:]]*>>>[[:space:]]*hegai-gateway/ { skipblock=1; next }
  /^[[:space:]]*#[[:space:]]*<<<[[:space:]]*hegai-gateway/ { skipblock=0; next }
  skipblock { next }
  /^[[:space:]]*\[model_providers\.hegai\][[:space:]]*$/ { skiptable=1; next }
  skiptable { if ($0 ~ /^[[:space:]]*\[/) { skiptable=0 } else { next } }
  {
    if ($0 ~ /^[[:space:]]*\[/) seentable=1
    if (seentable==0 && $0 ~ /^[[:space:]]*model[[:space:]]*=/) next
    if (seentable==0 && $0 ~ /^[[:space:]]*model_provider[[:space:]]*=/) next
    if (seentable==0 && $0 ~ /^[[:space:]]*model_reasoning_effort[[:space:]]*=/) next
    body = body $0 "\n"
  }
  END {
    printf "model = \"%s\"\n", model
    printf "model_provider = \"hegai\"\n"
    printf "model_reasoning_effort = \"%s\"\n", effort
    if (length(body) > 0) printf "%s", body
    printf "\n# >>> hegai-gateway (managed by installer - do not edit inside) >>>\n"
    printf "[model_providers.hegai]\n"
    printf "name = \"HegAI Gateway\"\n"
    printf "base_url = \"%s\"\n", base
    printf "experimental_bearer_token = \"%s\"\n", key
    printf "wire_api = \"responses\"\n"
    printf "# <<< hegai-gateway <<<\n"
  }
' "$CFG" > "$TMP"
mv "$TMP" "$CFG"

echo ""
echo "  HegAI-шлюз подключён."
echo "  Файл: $CFG"
echo "  Провайдер: hegai, модель: $MODEL"
echo ""
if ! command -v codex >/dev/null 2>&1 && [ ! -d "/Applications/ChatGPT.app" ]; then
  echo "  Codex CLI или приложение ChatGPT не найдены — установите их,"
  echo "  конфиг уже готов и подхватится автоматически."
  echo ""
fi
echo "  Откройте приложение ChatGPT или запустите в терминале:  codex"
echo "  Вернуть обычный ChatGPT: удалите строку  model_provider = \"hegai\""
echo "  из $CFG  (бэкап сохранён рядом)."
echo ""
read -n 1 -s -r -p "  Нажмите любую клавишу, чтобы закрыть окно."
echo ""
