#!/usr/bin/env bash
# Build the self-contained agent bundle -> deploy/agent.mjs.
#
# Only the SDK (which spawns the `claude` binary) and node-pty (a native addon)
# are kept EXTERNAL — they are npm-installed on the target from
# deploy/package.json. Everything else (ws, chokidar, zod, @cc-remote/shared) is
# inlined, so the bundle runs on a machine that only installs those two runtime
# dependencies.
#
# Usage: deploy/build-agent.sh   (run from anywhere; cd's to repo root)
#        AGENT_EDITION=external deploy/build-agent.sh  -> deploy/agent-external.mjs
#          (the self-hosted edition: see agent/src/edition.ts, docs/EXTERNAL-EDITION.md;
#          trusts the keys in deploy/release-keys.txt, signed with deploy/release-signer/)
#        AGENT_OUT=/tmp/x.mjs deploy/build-agent.sh    (build somewhere else)
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build --workspace shared

# The skills the agent installs on its machine travel INSIDE this bundle (see
# agent/src/skills-sync.ts) — regenerate them from skills/*/SKILL.md so a bundle
# can never ship a stale copy of a skill body.
node agent/scripts/gen-skills-bundle.mjs

AGENT_BUILD_VERSION="$(node -p "require('./agent/package.json').version")"
AGENT_EDITION="${AGENT_EDITION:-internal}"
case "$AGENT_EDITION" in
  internal) DEFAULT_OUT=deploy/agent.mjs ;;
  external) DEFAULT_OUT=deploy/agent-external.mjs ;;
  *) echo "ERROR: AGENT_EDITION must be internal or external, got '$AGENT_EDITION'" >&2; exit 1 ;;
esac
OUT="${AGENT_OUT:-$DEFAULT_OUT}"
# The external bundle trusts the release keys listed in deploy/release-keys.txt
# and nothing else (agent/src/release-keys.ts); the internal one trusts none.
RELEASE_KEYS_DEFINE="$(node agent/scripts/release-keys.mjs "$AGENT_EDITION")"

node_modules/.bin/esbuild agent/src/main.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --external:@anthropic-ai/claude-agent-sdk \
  --external:@homebridge/node-pty-prebuilt-multiarch \
  --define:__CC_REMOTE_AGENT_VERSION__="\"${AGENT_BUILD_VERSION}\"" \
  --define:__CC_REMOTE_EDITION__="\"${AGENT_EDITION}\"" \
  --define:__CC_REMOTE_EDITION_MARKER__="\"HEGAI_AGENT_EDITION=${AGENT_EDITION}\"" \
  --define:__CC_REMOTE_RELEASE_KEYS__="${RELEASE_KEYS_DEFINE}" \
  --banner:js="import { createRequire as __ccr } from 'module'; const require = __ccr(import.meta.url);" \
  --outfile="$OUT"

echo "built $OUT ($AGENT_EDITION, $(wc -c < "$OUT") bytes)"
# The release operator compares this with the sha256 on the signer's page.
echo "sha256 $( (sha256sum "$OUT" 2>/dev/null || shasum -a 256 "$OUT") | cut -d' ' -f1 )"

# deploy/package.json is what the hub serves as /install/package.json (installers
# npm-install the two external runtime deps from it) and it hand-mirrors the
# agent's version. A bump in agent/package.json that forgets this file ships a
# bundle that reports one version next to a package.json that says another.
DEPLOY_PKG_VERSION="$(node -p "require('./deploy/package.json').version")"
if [ "$DEPLOY_PKG_VERSION" != "$AGENT_BUILD_VERSION" ]; then
  echo "ERROR: deploy/package.json version ($DEPLOY_PKG_VERSION) != agent/package.json version ($AGENT_BUILD_VERSION)." >&2
  echo "       Set \"version\" in deploy/package.json to $AGENT_BUILD_VERSION, then rebuild." >&2
  exit 1
fi
