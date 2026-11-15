#!/usr/bin/env bash
# Keep the runtimes a cc-remote SESSION actually runs up to date — and roll back
# if the new one cannot come up.
#
# The trap this exists for, found 23.09.2026: a cc-remote session does NOT run
# the `claude` on the machine's PATH. It runs the binary inside the agent's own
# `node_modules/@anthropic-ai/claude-agent-sdk-*/claude`, because that is what
# `CLAUDE_CODE_EXECPATH` points at. On this fleet the machine had `claude`
# 2.1.259 while every session ran **2.1.220**, sixty versions behind, and no
# amount of `claude update` would ever have moved it. The visible symptom was a
# model that simply was not offered: `claude-opus-5-5` declares
# `min_claude_code_version: 2.1.280` in the signed catalogue, so Opus 5.5 was
# missing from the picker for a reason nobody could see from the picker.
#
# Codex is the other half and works the opposite way: the agent spawns whatever
# `codex` resolves to, so THAT one is the global npm package.
#
#   Claude for sessions : $AGENT_DIR/node_modules/@anthropic-ai/claude-agent-sdk
#   Codex for sessions  : global @openai/codex
#   `claude` on PATH    : NOT USED BY SESSIONS, but logins run it — `claude update`
#
# Policy is update-then-verify-then-keep. A runtime upgrade is not cosmetic: the
# agent leans on `supportedModels()`, `getContextUsage()` and the hook protocol,
# and all three have moved before. So a new version is installed, the agent is
# restarted, and it must prove it reconnected to the hub within the deadline. If
# it cannot, the previous version goes back and the script exits non-zero with
# the reason — a broken runtime must never be left latched in overnight.
#
# Sandboxes are NOT handled here. They share one release under
# /opt/cc-remote-agent/current and have their own updater, `sb-agent-update.sh`,
# which restarts the `cc-remote-sandbox@*` units 2s apart on purpose.
#
# Usage:
#   update-runtimes.sh                     # both, verify, roll back on failure
#   update-runtimes.sh --dry-run           # say what would change, touch nothing
#   update-runtimes.sh --only sdk|codex|cli
#   update-runtimes.sh --agent-dir DIR --unit UNIT    # a second agent on the box
set -uo pipefail

AGENT_DIR="${AGENT_DIR:-/home/cc-remote-agent}"
UNIT="${UNIT:-cc-remote-agent}"
DRY=0
ONLY=''
# Whose npm. The sandbox agent on this fleet runs as an unprivileged user and
# owns its own node_modules; installing into it as root leaves root-owned files
# under a tree that user has to write, which breaks the NEXT update rather than
# this one — the worst kind of breakage to leave behind a green run.
RUN_AS=''
# How the agent is restarted and how we read what it said afterwards. The
# defaults are systemd; macOS passes launchctl plus the log file the LaunchAgent
# writes, which is the only place `[agent] connected` shows up there. Keeping
# both behind flags means ONE updater rather than one per init system — the
# logic that matters (install, verify, roll back) must not be duplicated.
RESTART_CMD=''
LOG_FILE=''
CONNECT_DEADLINE="${CONNECT_DEADLINE:-120}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY=1; shift ;;
    --agent-dir)  AGENT_DIR="${2:-}"; shift 2 ;;
    --unit)       UNIT="${2:-}"; shift 2 ;;
    --user)       RUN_AS="${2:-}"; shift 2 ;;
    --restart-cmd) RESTART_CMD="${2:-}"; shift 2 ;;
    --log-file)   LOG_FILE="${2:-}"; shift 2 ;;
    --only)       ONLY="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "не понимаю аргумент «$1»" >&2; exit 2 ;;
  esac
done

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
# npm as the owner of the tree, when that is somebody other than us.
npm_in_agent() {
  if [ -n "$RUN_AS" ]; then
    runuser -u "$RUN_AS" -- env HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)" \
      npm --prefix "$AGENT_DIR" install --silent "$@"
  else
    (cd "$AGENT_DIR" && npm install --silent "$@")
  fi
}
# Nightly, as root: never execute or install into a tree another user could
# have written. On stage root's PATH already held an nvm node under
# /home/agent; a codex symlink or a `claude` there is someone else's code, and
# running its npm/`update` as root would hand them root (security review,
# 28.09.2026). As a non-root user the tree is that user's own — nothing to check.
trusted_tree() {
  [ "$(id -u)" = 0 ] || return 0
  local p
  for p in "$@"; do
    [ -e "$p" ] || return 1
    [ "$(stat -c %u "$p" 2>/dev/null || stat -f %u "$p")" = 0 ] || return 1
    [ -z "$(find "$p" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
  done
}
die() { printf '%s ОШИБКА: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

[ -d "$AGENT_DIR" ] || die "нет каталога агента $AGENT_DIR"
command -v npm >/dev/null || die "npm не найден"

SDK_PKG='@anthropic-ai/claude-agent-sdk'
CODEX_PKG='@openai/codex'

# The version of the binary sessions will actually exec, read from the platform
# package rather than the wrapper: the wrapper's version is the SDK's, and the
# thing that matters is the Claude Code inside it.
session_claude() {
  # A glob rather than a table of platform names, so this keeps working on musl
  # and arm64 — but npm installs SEVERAL of them (here: linux-x64 and
  # linux-x64-musl), and only one runs on this libc. Taking the first match
  # reported «?» on a glibc box because the musl build sorted first. So: ask
  # each candidate, and take the one that answers.
  local c
  for c in "$AGENT_DIR"/node_modules/"$SDK_PKG"-*/claude; do
    [ -x "$c" ] || continue
    "$c" --version >/dev/null 2>&1 && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
installed_sdk() {
  node -p "require('$AGENT_DIR/node_modules/$SDK_PKG/package.json').version" 2>/dev/null
}
latest_of() { npm view "$1" version 2>/dev/null; }

# The agent prints `[agent] connected` once the socket to the hub is up. That is
# the only cheap proof the new runtime did not break the thing we restarted for:
# `is-active` says the process survived, which it does even when it cannot speak.
# Two ways to read «did it come back», because two init systems. On systemd the
# journal is addressable by time; on launchd there is only the file the plist
# redirects stdout to, so we remember how long it was and read only what is new.
wait_connected() {
  local since="$1" from_byte="$2" deadline="$3" waited=0
  while [ "$waited" -lt "$deadline" ]; do
    if [ -n "$LOG_FILE" ]; then
      tail -c "+$((from_byte + 1))" "$LOG_FILE" 2>/dev/null | grep -q '\[agent\] connected' && return 0
    elif journalctl -u "$UNIT" --since "$since" --no-pager 2>/dev/null | grep -q '\[agent\] connected'; then
      return 0
    fi
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

restart_and_verify() {
  local stamp bytes
  stamp="$(date '+%Y-%m-%d %H:%M:%S')"
  bytes=0
  [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ] && bytes="$(wc -c < "$LOG_FILE" | tr -d ' ')"
  if [ -n "$RESTART_CMD" ]; then
    # shellcheck disable=SC2086
    eval "$RESTART_CMD" || return 1
  else
    systemctl restart "$UNIT" || return 1
  fi
  wait_connected "$stamp" "$bytes" "$CONNECT_DEADLINE" || return 1
  return 0
}

rc=0

# ---------------------------------------------------------------- Claude (SDK)
if [ "$ONLY" = '' ] || [ "$ONLY" = 'sdk' ]; then
  have="$(installed_sdk)"; want="$(latest_of "$SDK_PKG")"
  bin="$(session_claude)"
  running="$([ -n "$bin" ] && "$bin" --version 2>/dev/null | awk '{print $1}')"
  say "claude: сессии на ${running:-?} (SDK ${have:-?}), в npm ${want:-?}"
  # 28.09.2026, the mini: SDK «fresh» by package.json, platform dir without
  # the `claude` file — npm dropped it on a slow link. «уже свежий» (or «npm
  # не ответил», the same slow link) there would hide that no session can
  # start. Reinstalling via npm would drop it again, so this says so and leaves
  # the fix to a person (restore the file from the registry tarball, FLEET.md).
  if [ -n "$have" ] && [ -z "$running" ] && { [ -z "$want" ] || [ "$have" = "$want" ]; }; then
    say "claude: SDK $have стоит, но бинарника сессий нет или он не отвечает — сессии Claude не запустятся, нужен человек"; rc=1
  elif [ -z "$want" ]; then
    say "claude: npm не ответил — пропускаю, это не повод откатывать"
  elif [ "$have" = "$want" ]; then
    say "claude: уже свежий"
  elif [ "$DRY" = 1 ]; then
    say "claude: обновил бы $have -> $want"
  else
    say "claude: ставлю $want"
    if ! npm_in_agent "$SDK_PKG@$want" >/dev/null 2>&1; then
      say "claude: установка не прошла, версия осталась $have"; rc=1
    elif restart_and_verify; then
      new="$(session_claude)"; new="$([ -n "$new" ] && "$new" --version 2>/dev/null | awk '{print $1}')"
      if [ -z "$new" ]; then
        say "claude: $want встал, но бинарника сессий нет — npm его потерял, нужен человек"; rc=1
      else
        say "claude: готово, сессии теперь на $new"
      fi
    else
      say "claude: агент не поднялся на $want — ОТКАТ на $have"
      npm_in_agent "$SDK_PKG@$have" >/dev/null 2>&1
      if restart_and_verify; then say "claude: откат удался, снова $have"
      else say "claude: ОТКАТ ТОЖЕ НЕ ПОДНЯЛСЯ — нужен человек"; fi
      rc=1
    fi
  fi
fi

# ------------------------------------------------------------ `claude` on PATH
# Sessions do not run it (see the header) — but the «Войти» button on «Железо»
# does (`claude auth login`, runtime-jobs.ts resolves PATH first), and so does a
# person in the machine's terminal. On 28.09.2026 vps-box-1 and chatapp had
# 2.1.19x there, ~85 versions behind what their sessions ran. `claude update`
# knows how it was installed (native or npm), so it is asked rather than
# second-guessed; no agent restart, nothing a run depends on.
if [ "$ONLY" = '' ] || [ "$ONLY" = 'cli' ]; then
  pbin="$(command -v claude 2>/dev/null)"
  preal="$([ -n "$pbin" ] && readlink -f "$pbin")"
  if [ -z "$pbin" ]; then
    say "claude в PATH: нет — пропускаю"
  elif ! trusted_tree "$preal" "$(dirname "$preal")"; then
    say "claude в PATH: $pbin -> $preal не принадлежит root или открыт на запись — чужая установка, пропускаю"
  else
    before="$("$pbin" --version 2>/dev/null | awk '{print $1}')"
    if [ "$DRY" = 1 ]; then
      say "claude в PATH: $pbin ${before:-?} — запустил бы claude update"
    else
      to="$(command -v timeout || command -v gtimeout || true)"   # stock macOS has neither
      out="$(${to:+$to 300} "$pbin" update 2>&1 | tail -3 | tr '\n' ' ')"
      after="$("$pbin" --version 2>/dev/null | awk '{print $1}')"
      if [ -z "$after" ]; then
        say "claude в PATH: после update не отвечает (${out}) — нужен человек"; rc=1
      elif [ "$after" = "$before" ]; then
        say "claude в PATH: $after (${out})"
      else
        say "claude в PATH: $before -> $after"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------- Codex
# No restart: the agent spawns `codex app-server` per run, so a new global
# package is picked up by the next turn without touching the running agent.
#
# Update the codex the AGENT runs, not whatever `npm -g` points at. Found
# 28.09.2026 on stage: `npm` on PATH was an nvm node under /home/agent, so
# `npm install -g` refreshed /home/agent/.nvm/…/@openai/codex every night while
# the agent kept running /usr/bin/codex -> /usr/lib/node_modules, stuck on
# 0.154.0 for weeks — and the log said «готово», because it never compared the
# version that answered with the one it installed. So: resolve the binary,
# install into THAT prefix with the npm beside it, and call it done only when
# `--version` names the version we asked for.
codex_version_of() { "$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1; }
if [ "$ONLY" = '' ] || [ "$ONLY" = 'codex' ]; then
  cbin="$(command -v codex 2>/dev/null)"
  creal="$([ -n "$cbin" ] && readlink -f "$cbin")"
  tail_path='/lib/node_modules/@openai/codex/bin/codex.js'
  want="$(latest_of "$CODEX_PKG")"
  if [ -z "$cbin" ]; then
    say "codex: не установлен — пропускаю"
  elif [ "${creal%"$tail_path"}" = "$creal" ]; then
    say "codex: $cbin -> $creal не из npm (brew/отдельный бинарник) — не трогаю"
  else
    prefix="${creal%"$tail_path"}"
    cnpm="$prefix/bin/npm"; [ -x "$cnpm" ] || cnpm="$(command -v npm)"
    have="$(node -p 'require(process.argv[1]).version' "$prefix/lib/node_modules/$CODEX_PKG/package.json" 2>/dev/null)"
    running="$(codex_version_of "$cbin")"
    say "codex: $cbin (prefix $prefix) стоит ${have:-?}, отвечает ${running:-?}, в npm ${want:-?}"
    if ! trusted_tree "$prefix" "$prefix/lib/node_modules" "$(readlink -f "$cnpm")"; then
      say "codex: $prefix или $cnpm доступны на запись не только root — не трогаю"; rc=1
    elif [ -z "$want" ]; then
      say "codex: npm не ответил — пропускаю"
    elif [ "$have" = "$want" ] && [ "$running" = "$want" ]; then
      say "codex: уже свежий"
    elif [ "$DRY" = 1 ]; then
      say "codex: обновил бы ${running:-$have} -> $want"
    else
      say "codex: ставлю $want в $prefix"
      if ! "$cnpm" install -g --prefix "$prefix" --silent "$CODEX_PKG@$want" >/dev/null 2>&1; then
        say "codex: установка не прошла, версия осталась ${running:-$have}"; rc=1
      else
        now="$(codex_version_of "$cbin")"
        if [ "$now" = "$want" ]; then
          say "codex: готово, $cbin отвечает $now"
        else
          say "codex: после установки $cbin отвечает «${now:-ничего}», а не $want — ОТКАТ на ${have:-?}"
          [ -n "$have" ] && "$cnpm" install -g --prefix "$prefix" --silent "$CODEX_PKG@$have" >/dev/null 2>&1
          [ -n "$(codex_version_of "$cbin")" ] && say "codex: откат удался" || say "codex: ОТКАТ ТОЖЕ СЛОМАН — нужен человек"
          rc=1
        fi
      fi
    fi
  fi
fi

exit "$rc"
