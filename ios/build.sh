#!/usr/bin/env bash
# Reproducible iOS archive/export entrypoint. CURRENT_PROJECT_VERSION is
# computed once here and inherited by every target (CCRemote, ShareExtension,
# CCRemoteWidgets, CCRemoteWatch, CCRemoteWatchWidgets) via the command line.
set -euo pipefail

cd "$(dirname "$0")"

ACTION="${1:-archive}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%y%m%d%H%M)}"
MARKETING_VERSION_ARG="${MARKETING_VERSION:-}"
ARCHIVE_PATH="${ARCHIVE_PATH:-build/CCRemote.xcarchive}"
EXPORT_PATH="${EXPORT_PATH:-build/export}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-build}"

if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate
elif [ ! -d CCRemote.xcodeproj ]; then
  echo "ERROR: xcodegen is required because CCRemote.xcodeproj is missing" >&2
  exit 2
fi

archive() {
  # Empty-array expansion needs the `${a[@]+…}` guard: macOS ships bash 3.2,
  # where `"${a[@]}"` under `set -u` is an unbound-variable error, so leaving
  # MARKETING_VERSION unset used to abort the release before it built anything.
  local version_args=()
  if [ -n "$MARKETING_VERSION_ARG" ]; then
    version_args+=("MARKETING_VERSION=$MARKETING_VERSION_ARG")
  fi
  # TestFlight builds carry the real Claude/OpenAI marks. STORE_BUILD=1 makes
  # the build for App Store review without them (see project.yml).
  # Fails closed: anything but 0/1 stops the build instead of quietly
  # shipping the marks. A store build drops the code path AND the asset
  # catalog, so the logos are not even inside Assets.car.
  local marks="with provider marks"
  case "${STORE_BUILD:-0}" in
    1)
      version_args+=("HEGAI_PROVIDER_MARKS=" "HEGAI_PROVIDER_MARKS_EXCLUDE=ProviderMarks.xcassets")
      marks="STORE build, no provider marks"
      ;;
    0 | "") ;;
    *)
      echo "ERROR: STORE_BUILD must be 0 or 1, got '$STORE_BUILD'" >&2
      exit 2
      ;;
  esac
  echo "[ios] archive build=$BUILD_NUMBER${MARKETING_VERSION_ARG:+ marketing=$MARKETING_VERSION_ARG} ($marks)"
  # iOS only. The Mac app ships by Developer ID + notarization, which is a
  # different pipeline (and a different export-options plist) — it does not
  # belong behind the same flag.
  xcodebuild -project CCRemote.xcodeproj -scheme CCRemote \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -derivedDataPath "$DERIVED_DATA_PATH" \
    -archivePath "$ARCHIVE_PATH" \
    "CURRENT_PROJECT_VERSION=$BUILD_NUMBER" \
    ${version_args[@]+"${version_args[@]}"} \
    archive
}

export_archive() {
  echo "[ios] export $ARCHIVE_PATH -> $EXPORT_PATH"
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportOptionsPlist ExportOptions.plist \
    -exportPath "$EXPORT_PATH"
}

case "$ACTION" in
  archive) archive ;;
  export) export_archive ;;
  release)
    archive
    export_archive
    ;;
  *)
    echo "usage: $0 [archive|export|release]" >&2
    exit 2
    ;;
esac
