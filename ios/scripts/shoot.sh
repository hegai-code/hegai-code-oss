#!/usr/bin/env bash
# Screenshot harness. Every UI phase of the rebuild is accepted on the pictures
# this produces, so it has to be boring and repeatable rather than clever.
#
#   ./scripts/shoot.sh                    # all four widths, the root
#   CC_WIDTHS=375 ./scripts/shoot.sh      # just the narrow one
#   CC_THEME=dark CC_TAG=dark ./scripts/shoot.sh
#   CC_SCREEN=team CC_TAG=team ./scripts/shoot.sh
#   CC_DRAWER=1 CC_TAG=drawer ./scripts/shoot.sh
#
# Where the app lands is named by CC_SCREEN, and two independent axes ride on
# top of it:
#
#   CC_SCREEN=start | team[:overview|people|projects|audit]
#           | settings[:account|hardware|memory|profile]
#           | gallery | transcript | swipe-probe
#   CC_DRAWER=1     the session drawer is open on the first frame
#   CC_LENS=list|flow   which lens the drawer shows
#   CC_FLOW_MENU=1  меню переноса у первой карточки Flow (включает шторку+flow)
#   CC_OPEN=machineId::sessionId    deep-link straight into a session
#   CC_TRANSCRIPT=1|turns|tools|composer|preview   DEBUG-стенд транскрипта (без хаба)
#   CC_HW_KEYBOARD=false            софт-клавиатура вместо железной хостовой
#   CC_SHELF_TIMEOUT=60  сколько ждать ВТОРОЙ источник полки (projects.list).
#                        Основной маяк гаснет на `connected`, а полка стартового
#                        экрана дособирается позже — см. «ВТОРОЙ маяк» ниже.
#
# CC_TAB and CC_PUSH still work and are TRANSLATED, loudly — the app prints a
# `[launch]` line saying what it turned into (see Shell/LaunchAffordances.swift
# and its tests). They named a bottom tab bar and an «Ещё» tab, and neither
# exists: «покажи сессии» is now the root with the drawer open, and Железо /
# Память / Профиль are tabs of Настройки. The reason the translation is loud
# rather than silent is that this failure is invisible — the script runs, the
# file appears, the width is right, and the picture inside is another screen.
#
# Output: $CC_SHOT_DIR (default /tmp/hegai-shots/<phase>) — deliberately OUTSIDE
# the worktree. Screenshots written into the repo either get committed by
# accident or leave `git status` dirty, and both cost a confused half hour.
#
# Four widths, because they are the ones that actually break differently:
#   375  iPhone SE (3rd gen)  — the worst case; if it fits here it fits anywhere
#   393  iPhone 16
#   402  iPhone 16 Pro
#   430  iPhone 16 Plus       — the widest phone
#
# Devices are resolved to a UDID against the INSTALLED runtime and then only ever
# addressed by UDID. Addressing by name is what breaks a harness on someone
# else's Xcode: device-type names repeat across runtimes, `-destination
# name=iPhone 16` picks whichever the tool feels like, and the failure shows up
# as a screenshot at the wrong size rather than as an error.
set -euo pipefail
cd "$(dirname "$0")/.."

PHASE="${CC_PHASE:-phase0}"
OUT="${CC_SHOT_DIR:-/tmp/hegai-shots/$PHASE}"
BUNDLE_ID="net.hegai.ccremote"
DERIVED="${CC_DERIVED_DATA:-build}"    # isolated per task — see below
READY_FILE="harness-ready.json"      # written by HarnessSignals (DEBUG)
TAG="${CC_TAG:-home}"
TIMEOUT="${CC_TIMEOUT:-90}"

# width:device-type — keep in step with the comment above.
DEVICE_MAP=(
  "375:iPhone-SE-3rd-generation"
  "393:iPhone-16"
  "402:iPhone-16-Pro"
  "430:iPhone-16-Plus"
)
WIDTHS="${CC_WIDTHS:-375 393 402 430}"

# --- credentials ----------------------------------------------------------
# The app takes the hub + token from its launch environment (AppSettings reads
# CC_HUB_URL / CC_TOKEN and persists them), so no simulator ever needs a manual
# SSO sign-in. simctl forwards anything prefixed SIMCTL_CHILD_ to the app.
# CC_SIGNED_OUT=1 launches with NO hub and NO token on purpose, to photograph
# onboarding. That screen is a real destination with its own layout, so it needs
# a baseline like any other — and without this flag the only way to reach it
# would be to pass a deliberately broken token, which lands on the connecting
# state instead. The app settles as `signin`.
HUB_URL="${CC_HUB_URL:-wss://code.acme.test/mobile/ui}"
TOKEN="${CC_TOKEN:-}"
if [ "${CC_SIGNED_OUT:-}" = "1" ]; then
  TOKEN=""
  echo "[shoot] CC_SIGNED_OUT=1 — launching signed out, expecting state=signin"
elif [ -z "$TOKEN" ]; then
  cat >&2 <<'MSG'
ERROR: no token. Set CC_TOKEN=… (it is never printed or written to disk).

It must be a UI token — the credential a PERSON signs in with. Do NOT reach for
the fleet agent's CC_REMOTE_TOKEN from
~/Library/LaunchAgents/ai.heg.ccremote.agent.plist: it is scoped to the agent
path only. Measured against production 21.09.2026:

    /agent?token=…       101 Switching Protocols
    /ui?token=…          401
    /mobile/ui?token=…   401

An earlier version of this script fell back to it automatically, which bought
nothing: the app reached «соединение с хабом…» and sat there until the timeout,
and the harness looked broken when the credential was simply the wrong audience.
MSG
  exit 2
fi
# From here on TOKEN must not reach stdout, a filename, or `set -x`.

echo "[shoot] phase=$PHASE tag=$TAG hub=$HUB_URL"
echo "[shoot] out=$OUT"
mkdir -p "$OUT"

# --- resolve the runtime --------------------------------------------------
RUNTIME=$(xcrun simctl list runtimes -j | python3 -c "
import sys, json
rts = [r for r in json.load(sys.stdin)['runtimes']
       if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS')]
if not rts:
    sys.exit('no available iOS runtime')
# Newest by version, so a machine with several runtimes is still deterministic.
rts.sort(key=lambda r: [int(p) for p in r['version'].split('.')])
print(rts[-1]['identifier'])
")
RUNTIME_VER="${RUNTIME##*.iOS-}"
echo "[shoot] runtime=$RUNTIME"

# --- resolve or create one simulator per width ----------------------------
declare -a UDIDS=() LABELS=()
for w in $WIDTHS; do
  dtype=""
  for entry in "${DEVICE_MAP[@]}"; do
    [ "${entry%%:*}" = "$w" ] && dtype="${entry##*:}"
  done
  if [ -z "$dtype" ]; then
    echo "ERROR: width $w is not in DEVICE_MAP" >&2
    exit 2
  fi
  full_type="com.apple.CoreSimulator.SimDeviceType.$dtype"

  # Optional task-owned devices: avoid uninstalling another session's app.
  # CC_SIMULATORS='375:UUID 393:UUID 402:UUID 430:UUID'
  requested=""
  for entry in ${CC_SIMULATORS:-}; do
    [ "${entry%%:*}" = "$w" ] && requested="${entry#*:}"
  done
  udid=$(xcrun simctl list devices available -j | python3 -c "
import sys, json
d = json.load(sys.stdin)['devices']
for dev in d.get('$RUNTIME', []):
    if dev.get('deviceTypeIdentifier') == '$full_type' and (not '$requested' or dev['udid'] == '$requested'):
        print(dev['udid']); break
")
  if [ -n "$requested" ] && [ -z "$udid" ]; then
    echo "ERROR: requested simulator $requested does not match ${w}pt on $RUNTIME" >&2
    exit 2
  fi
  if [ -z "$udid" ]; then
    echo "[shoot] creating simulator for ${w}pt ($dtype)"
    udid=$(xcrun simctl create "hegai-$w" "$full_type" "$RUNTIME")
  fi
  UDIDS+=("$udid")
  LABELS+=("$w")
  echo "[shoot] ${w}pt -> $udid"
done

# --- build ONCE -----------------------------------------------------------
# A simulator .app is not per-device: same arch, same runtime, so one build
# installs onto all four. Building per width would quadruple the slowest step
# for an identical product.
#
# -derivedDataPath build is NOT optional. DerivedData is shared per-user on this
# machine and other sessions build the same module names into it; a poisoned
# shared module cache is exactly the bug where a clean build fails while an
# incremental one passes. Keeping it in the worktree makes each tree's cache its
# own. (`build/` is already gitignored.)
echo "[shoot] building (once, shared by all widths)…"
xcodebuild \
  -project CCRemote.xcodeproj \
  -scheme CCRemote \
  -configuration Debug \
  -destination "id=${UDIDS[0]}" \
  -derivedDataPath "$DERIVED" \
  build 2>&1 | tail -5

APP="$DERIVED/Build/Products/Debug-iphonesimulator/CCRemote.app"
[ -d "$APP" ] || { echo "ERROR: no app at $APP" >&2; exit 1; }
echo "[shoot] app=$APP"

# --- boot / install / launch / wait / shoot -------------------------------
shot_one() {
  local udid="$1" label="$2"
  echo "[shoot] --- ${label}pt ---"

  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true

  # Uninstall first: it clears the previous run's readiness beacon, so a stale
  # file from the last invocation can never be mistaken for this one being
  # ready. It also drops the app container, and with it UserDefaults.
  xcrun simctl uninstall "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true

  # …but NOT the keychain, which lives with the simulator rather than the app
  # container and survives an uninstall. `AppSettings` reads
  # `KeychainStore.loadToken()` when CC_TOKEN is absent, so without this a
  # signed-out run silently inherits the token from whatever ran here last and
  # renders a connecting screen instead of onboarding. Measured: the first
  # CC_SIGNED_OUT=1 attempt settled `offline`, not `signin`.
  if [ "${CC_SIGNED_OUT:-}" = "1" ]; then
    xcrun simctl keychain "$udid" reset >/dev/null 2>&1 || true
  fi

  # CC_TEXT_SIZE sets the SYSTEM content size (e.g. accessibility-extra-extra-large)
  # rather than overriding Dynamic Type inside the app. That distinction is the
  # whole point: the app's type ladder goes through Font.custom(relativeTo:), and
  # only the real setting proves that wiring end to end. An in-app override would
  # scale the text while leaving a broken `relativeTo:` undetected.
  #
  # The subcommand is `content_size` with an UNDERSCORE. `content-size` with a
  # hyphen is a usage error, and the first version of this line sent it into
  # `>/dev/null 2>&1 || true` — so simctl printed its whole usage block to
  # nowhere, exited 117, and the run produced screenshots at the default size
  # that were pixel-identical to the normal ones. A silenced failure that still
  # writes plausible files is worse than no check at all, so this one is loud.
  # Always set it, even when nobody asked: the content size lives with the
  # SIMULATOR and survives an uninstall, exactly like the keychain does. One
  # accessibility run would otherwise leave every later baseline on this device
  # silently oversized, and the diff would look like a layout change. `large` is
  # the iOS default — not `medium`.
  xcrun simctl ui "$udid" content_size "${CC_TEXT_SIZE:-large}" || {
    echo "ERROR: could not set content_size=${CC_TEXT_SIZE:-large}" >&2
    exit 2
  }

  # Софт-клавиатура. Симулятор по умолчанию отдаёт ввод ЖЕЛЕЗНОЙ клавиатуре
  # хоста, и экран «композер с поднятой клавиатурой» снимается без клавиатуры:
  # поле в фокусе, снизу ничего. Настройка живёт в preferences симулятора и
  # переживает переустановку приложения — поэтому её, как и content_size,
  # выставляем ВСЕГДА, а не только когда попросили.
  xcrun simctl spawn "$udid" defaults write com.apple.iphonesimulator \
    ConnectHardwareKeyboard -bool "${CC_HW_KEYBOARD:-true}" >/dev/null 2>&1 || true

  xcrun simctl install "$udid" "$APP"
  # Optional fixture setting: avoid the first-launch system prompt covering
  # screenshots. Applies only to this simulator's newly installed app.
  if [ -n "${CC_NOTIFICATIONS:-}" ]; then
    xcrun simctl spawn "$udid" defaults write "$BUNDLE_ID" notificationsEnabled -bool "$CC_NOTIFICATIONS"
  fi

  # SIMCTL_CHILD_* is how simctl passes environment into the app.
  #
  # Exported inside a subshell rather than written as an assignment prefix, for
  # two independent reasons:
  #
  #   * the optional ones have to stay optional. A prefix built by expansion —
  #     `${CC_TAB:+SIMCTL_CHILD_CC_TAB=$CC_TAB}` — does NOT work: the shell
  #     decides which words are assignments while parsing, before expanding
  #     anything, so the expanded word becomes the COMMAND NAME and the launch
  #     dies with `SIMCTL_CHILD_CC_TAB=sessions: command not found`.
  #   * `env KEY=value …` would fix that but puts the token in argv, and argv is
  #     readable by every process on the machine via ps. An exported variable is
  #     not.
  (
    # Signed-out runs pass neither, so AppSettings falls through to its stored
    # (freshly uninstalled = empty) values and onboarding is what renders.
    if [ -n "$TOKEN" ]; then
      export SIMCTL_CHILD_CC_HUB_URL="$HUB_URL"
      export SIMCTL_CHILD_CC_TOKEN="$TOKEN"
    fi
    export SIMCTL_CHILD_CC_THEME="${CC_THEME:-light}"
    if [ -n "${CC_SCREEN:-}" ]; then export SIMCTL_CHILD_CC_SCREEN="$CC_SCREEN"; fi
    if [ -n "${CC_DRAWER:-}" ]; then export SIMCTL_CHILD_CC_DRAWER="$CC_DRAWER"; fi
    if [ -n "${CC_LENS:-}" ]; then export SIMCTL_CHILD_CC_LENS="$CC_LENS"; fi
    # Меню переноса — единственный способ двигать карточку на телефоне, поэтому
    # кадр с ним открытым снимается флагом, а не тапом по координате.
    if [ -n "${CC_FLOW_MENU:-}" ]; then export SIMCTL_CHILD_CC_FLOW_MENU="$CC_FLOW_MENU"; fi
    # Retired names. Forwarded on purpose: the app translates them and says so,
    # which beats a script that silently stops steering anything.
    if [ -n "${CC_TAB:-}" ]; then export SIMCTL_CHILD_CC_TAB="$CC_TAB"; fi
    if [ -n "${CC_PUSH:-}" ]; then export SIMCTL_CHILD_CC_PUSH="$CC_PUSH"; fi
    if [ -n "${CC_OPEN:-}" ]; then export SIMCTL_CHILD_CC_OPEN="$CC_OPEN"; fi
    if [ -n "${CC_COLUMNS:-}" ]; then export SIMCTL_CHILD_CC_COLUMNS="$CC_COLUMNS"; fi
    # CC_GALLERY=1 — витрина дизайн-системы вместо приложения. Хаб ей не нужен,
    # поэтому она снимается и без токена.
    if [ -n "${CC_GALLERY:-}" ]; then export SIMCTL_CHILD_CC_GALLERY="$CC_GALLERY"; fi
    # CC_TRANSCRIPT=1 — стенд транскрипта и композера вместо приложения. Хаба
    # он тоже не знает: состояния, ради которых он существует (упавший
    # инструмент, все три смысловых цвета в одном кадре), живой прод по заказу
    # не показывает.
    if [ -n "${CC_TRANSCRIPT:-}" ]; then export SIMCTL_CHILD_CC_TRANSCRIPT="$CC_TRANSCRIPT"; fi
    # The `defaults write` above does not reach the app on a simulator (it lands
    # in the shared prefs, the app reads its container), so the system prompt
    # is ALSO switched off at launch: `LaunchAffordances.notificationPrompt`.
    # Stands (gallery / transcript) never ask; CC_NOTIFICATIONS=false covers
    # the real app.
    if [ -n "${CC_NOTIFICATIONS:-}" ]; then export SIMCTL_CHILD_CC_NOTIFICATIONS="$CC_NOTIFICATIONS"; fi
    xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null
  )

  # Poll for the readiness beacon rather than sleeping. The first launch after
  # an install is slow (cold start + socket + first snapshot), and a screenshot
  # taken early shows a connecting state that reads as a layout bug.
  local container ready="" waited=0
  container=$(xcrun simctl get_app_container "$udid" "$BUNDLE_ID" data 2>/dev/null || true)
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if [ -n "$container" ] && [ -f "$container/Documents/$READY_FILE" ]; then
      ready=$(cat "$container/Documents/$READY_FILE")
      break
    fi
    sleep 1; waited=$((waited + 1))
    [ -n "$container" ] || container=$(xcrun simctl get_app_container "$udid" "$BUNDLE_ID" data 2>/dev/null || true)
  done

  # The beacon names WHICH settled state this is. Only `connected` produces an
  # unsuffixed file: a screenshot is a baseline other phases diff against, and
  # one taken at a sign-in screen or against a refused token must never be
  # mistaken for the real thing months later. `.notready` is now reserved for
  # its literal meaning — the app never settled at all, which is a harness or
  # app bug rather than an environment one.
  if [ -n "$ready" ]; then
    local state
    state=$(printf '%s' "$ready" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')
    echo "[shoot] settled after ${waited}s: $ready"
    case "$state" in
      connected) ;;                       # the real baseline
      # The design-system gallery (CC_GALLERY=1) never opens a socket: it is a
      # static screen of tokens and primitives. «Connected» is not a property it
      # can have, so a hub state would be the wrong thing to label it with — its
      # screenshots ARE baselines, and suffixing them would read as a failure
      # that did not happen.
      gallery)   ;;
      # Стенд транскрипта — по той же причине: сокета у него нет, и «connected»
      # не свойство, которое он может иметь. Его снимки ТОЖЕ базовые.
      transcript) ;;
      "")        label="$label.unknown" ;;
      *)         label="$label.$state" ;; # signin / offline
    esac
  else
    echo "[shoot] ⚠️  app never settled within ${TIMEOUT}s — capturing as .notready"
    label="$label.notready"
  fi
  # ВТОРОЙ маяк — полка стартового экрана. Основной гаснет на `connected`, то
  # есть когда открылся сокет; полка же строится из ДВУХ источников, и второй
  # (`projects.list`) — круговой рейс до каждой управляемой машины, который
  # приезжает на секунды позже. Кадр, снятый в это окно, показывает полку
  # наполовину построенной: без пустых проектов, то есть ровно без тех, ради
  # которых второй источник и заведён. Выглядит здоровым, просто с другим
  # набором папок, — и ловится только сравнением двух прогонов.
  #
  # Ждём ограниченно и вслух: полка без управляемых машин не построится
  # никогда, и молчаливое ожидание до таймаута было бы заменой одной
  # невидимой поломки на другую.
  # `${state:-}` — под `set -u`: при `.notready` маяк не читался и state не
  # присваивался вовсе.
  if [ "${state:-}" = "connected" ] && [ -z "${CC_GALLERY:-}${CC_TRANSCRIPT:-}" ]; then
    local shelf_waited=0 shelf=""
    # 60s по умолчанию — не с запасом, а по замеру: девять машин отвечают
    # `projects.list` за 28s (149 проектов, 22.09.2026). 25s не хватало ровно
    # чуть-чуть, и кадр уезжал с полусобранной полкой БЕЗ единого предупреждения
    # — потому что предупреждать было нечему.
    while [ "$shelf_waited" -lt "${CC_SHELF_TIMEOUT:-60}" ]; do
      if [ -n "$container" ] && [ -f "$container/Documents/harness-shelf.json" ]; then
        shelf=$(cat "$container/Documents/harness-shelf.json")
        break
      fi
      sleep 1; shelf_waited=$((shelf_waited + 1))
    done
    if [ -n "$shelf" ]; then
      echo "[shoot] полка собрана за ${shelf_waited}s: $shelf"
    else
      echo "[shoot] ⚠️  второй источник полки не ответил за ${shelf_waited}s — на кадре будет только опись сессий"
    fi
  fi

  # One extra beat so the first post-snapshot frame is actually composited.
  sleep 2
  # CC_EXTRA_WAIT — seconds to wait AFTER the beacon, for the things the beacon
  # deliberately does not wait for. The beacon fires the moment the socket opens,
  # because that is when the SHELL stops changing; a session's transcript is a
  # separate read that lands afterwards, and on a machine with hundreds of
  # sessions it lands seconds later. Without this a `CC_OPEN` screenshot is a
  # correctly-named picture of an empty transcript.
  if [ -n "${CC_EXTRA_WAIT:-}" ]; then
    echo "[shoot] extra wait ${CC_EXTRA_WAIT}s (transcript, history)"
    sleep "$CC_EXTRA_WAIT"
  fi

  local path="$OUT/${TAG}-${label}.png"
  xcrun simctl io "$udid" screenshot "$path" >/dev/null 2>&1
  local dims
  dims=$(sips -g pixelWidth -g pixelHeight "$path" 2>/dev/null \
         | awk '/pixel/ {printf "%s ", $2}')
  echo "[shoot] wrote $path (${dims}px)"
}

for i in "${!UDIDS[@]}"; do
  shot_one "${UDIDS[$i]}" "${LABELS[$i]}"
done

echo
echo "[shoot] done:"
ls -la "$OUT"
