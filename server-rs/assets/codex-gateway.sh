#!/bin/bash
# HegAI Gateway — установка Codex CLI и подключение к шлюзу (macOS / Linux).
# Запуск:  HEGAI_API_KEY='sk-bf-...' bash -c "$(curl -fsSL https://code.acme.test/install/codex-gateway.sh)"
set -euo pipefail

BASE='__BASE__'
MODEL='__MODEL__'
# Без этой строки Codex стартует с `reasoning effort: none` — модели шлюза
# объявляют свой дефолт низким, а профиль без ключа не задаёт его вовсе.
EFFORT='__EFFORT__'
KEY="${HEGAI_API_KEY:-}"

if [ -z "$KEY" ]; then
  echo "  Нет ключа. Запусти так:  HEGAI_API_KEY='sk-bf-...' bash -c \"\$(curl -fsSL $0)\"" >&2
  exit 1
fi

# 1. Codex CLI.
if ! command -v codex >/dev/null 2>&1; then
  echo "  Codex CLI не найден — ставлю через npm..."
  if command -v npm >/dev/null 2>&1; then
    npm install -g @openai/codex || echo "  npm не смог поставить codex. Поставь вручную:  npm install -g @openai/codex"
  else
    echo "  Нужен Node.js. Поставь с https://nodejs.org (или 'brew install node') и повтори команду." >&2
    exit 1
  fi
fi

# 2. Направить Codex через шлюз HegAI (мерж в ~/.codex/config.toml).
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
echo "  Готово. Codex подключён к шлюзу HegAI."
echo "  Файл: $CFG   ·   модель: $MODEL"
echo "  Запусти:  codex"
echo "  Вернуть обычный ChatGPT: удали строку  model_provider = \"hegai\"  из $CFG  (бэкап рядом)."
echo ""
