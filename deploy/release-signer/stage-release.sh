#!/usr/bin/env bash
# Build the external agent bundle from a clean checkout and stage it on the hub
# box for the signer app (see README, "Подпись в приложении (Touch ID)").
#
#   bash deploy/release-signer/stage-release.sh [--force]
#
# Env: STAGE_HOST (default hub-main-box), STAGE_DIR
# (default /var/www/code.acme.test/dl/external), STAGE_URL
# (default https://code.acme.test/dl/external).
# shellcheck disable=SC2029  # remote commands intentionally expand on the client
set -euo pipefail

FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  "") ;;
  *) echo "usage: $0 [--force]" >&2; exit 2 ;;
esac

HOST="${STAGE_HOST:-hub-main-box}"
DIR="${STAGE_DIR:-/var/www/code.acme.test/dl/external}"
URL="${STAGE_URL:-https://code.acme.test/dl/external}"

cd "$(git rev-parse --show-toplevel)"
# Untracked files count too: build-agent.sh discovers skills/ and friends from
# the tree, so a stray local file would be published inside the bundle.
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "ERROR: working tree is not clean (including untracked files); stage from a clean checkout of main" >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BUNDLE="$TMP/agent-external.mjs"
AGENT_EDITION=external AGENT_OUT="$BUNDLE" bash deploy/build-agent.sh

# Signed bytes cannot be rewritten later, so a bundle the public export would
# refuse must never reach the signer. It is checked exactly as the export checks
# it: at its published path, under the reviewed allowlist entry for that path.
# That entry admits our two domains by name only, so on top of it the bundle may
# carry them in exactly two places: the internal edition's gateway default and
# git author, both dead branches in the external build.
CHECK="$TMP/check/deploy/selfhost/agent-release"
mkdir -p "$CHECK"
cp "$BUNDLE" "$CHECK/agent-external.mjs"
if ! python3 deploy/export-public/check.py "$TMP/check" >&2; then
  echo "ERROR: the bundle names internal hosts or paths; fix the source and stage again" >&2
  exit 1
fi
# Counted, not filtered by line: a second name on a known line must fail too.
# Two occurrences in all, each known line exactly once = nothing else anywhere.
DOMAINS="$( { grep -oE 'hegai\\*\.net|\bheg\\*\.ai\b' "$BUNDLE" || true; } | wc -l)"
KNOWN_GW="$(grep -cF 'var INTERNAL_GATEWAY_URL = "https://llm.acme.test/v1";' "$BUNDLE" || true)"
KNOWN_AUTHOR="$(grep -cF '|| (external ? "agent@localhost" : "code@a.test")' "$BUNDLE" || true)"
if [ "$DOMAINS" -ne 2 ] || [ "$KNOWN_GW" -ne 1 ] || [ "$KNOWN_AUTHOR" -ne 1 ]; then
  grep -nE 'hegai\\*\.net|\bheg\\*\.ai\b' "$BUNDLE" | cut -c1-200 >&2 || true
  echo "ERROR: the bundle names our domains $DOMAINS time(s); only the two known internal-edition defaults are allowed, once each; fix the source and stage again" >&2
  exit 1
fi

VERSION="$(grep -oE 'AGENT_VERSION = true \? "[^"]+"' "$BUNDLE" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
if ! [[ "$VERSION" =~ ^[0-9A-Za-z._+-]{1,64}$ ]] || [ "$VERSION" = . ] || [ "$VERSION" = .. ]; then
  echo "ERROR: could not read a valid AGENT_VERSION from the bundle (got '$VERSION')" >&2
  exit 1
fi
SHA="$(sha256sum "$BUNDLE" | cut -d' ' -f1)"

REMOTE="$DIR/$VERSION/agent-external.mjs"
EXISTING="$(ssh "$HOST" "if [ -f '$REMOTE' ]; then sha256sum '$REMOTE' | cut -d' ' -f1; fi")"
if [ -n "$EXISTING" ] && [ "$EXISTING" != "$SHA" ] && [ "$FORCE" != 1 ]; then
  echo "ERROR: $HOST:$REMOTE already exists with a different sha256 ($EXISTING); bump the version or pass --force" >&2
  exit 1
fi

ssh "$HOST" "mkdir -p '$DIR/$VERSION'"
scp -q "$BUNDLE" "$HOST:$REMOTE.part"
# A re-stage (--force, new sha) must not leave the old version's signature
# beside the new bundle: drop .release/.sig first.
ssh "$HOST" "rm -f '$REMOTE.sig' '$REMOTE.release' && mv '$REMOTE.part' '$REMOTE' && chmod 644 '$REMOTE'"

CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PENDING="{\"version\":\"$VERSION\",\"sha256\":\"$SHA\",\"url\":\"$URL/$VERSION/agent-external.mjs\",\"commit\":\"$COMMIT\",\"createdAt\":\"$CREATED\"}"
printf '%s\n' "$PENDING" | ssh "$HOST" "cat > '$DIR/pending.json.part' && chmod 644 '$DIR/pending.json.part' && mv '$DIR/pending.json.part' '$DIR/pending.json'"

echo "staged version=$VERSION sha256=$SHA"
echo "next: sign in the app, then: bash deploy/release-signer/collect-signed.sh $VERSION"
