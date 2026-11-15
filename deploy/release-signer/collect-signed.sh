#!/usr/bin/env bash
# Fetch a signed release from the hub box, verify the signature against
# deploy/release-keys.txt and copy the three files into
# deploy/selfhost/agent-release/ for committing.
#
#   bash deploy/release-signer/collect-signed.sh <version>
set -euo pipefail

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9A-Za-z._+-]{1,64}$ ]] || [ "$VERSION" = "." ] || [ "$VERSION" = ".." ]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi
HOST="${STAGE_HOST:-hub-main-box}"
DIR="${STAGE_DIR:-/var/www/code.acme.test/dl/external}"

cd "$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for f in agent-external.mjs agent-external.mjs.release agent-external.mjs.sig; do
  scp -q "$HOST:$DIR/$VERSION/$f" "$TMP/$f"
done

node --input-type=module - "$TMP" "$VERSION" <<'JS'
import { readFileSync } from 'node:fs';
import { manifestText, sha256Hex, readKeys, verifySignature } from './deploy/release-signer/release-format.mjs';
const [dir, version] = process.argv.slice(2);
const bundle = readFileSync(`${dir}/agent-external.mjs`);
const manifest = readFileSync(`${dir}/agent-external.mjs.release`, 'utf8');
const sig = readFileSync(`${dir}/agent-external.mjs.sig`, 'utf8');
const expected = manifestText(version, sha256Hex(bundle));
if (manifest !== expected) { console.error('ERROR: manifest does not match version + bundle sha256'); process.exit(1); }
if (!verifySignature(Buffer.from(manifest), sig, readKeys('deploy/release-keys.txt'))) {
  console.error('ERROR: signature does not verify against deploy/release-keys.txt'); process.exit(1);
}
console.log(`signature ok: version=${version} sha256=${sha256Hex(bundle)}`);
JS

cp "$TMP"/agent-external.mjs "$TMP"/agent-external.mjs.release "$TMP"/agent-external.mjs.sig deploy/selfhost/agent-release/
echo "copied to deploy/selfhost/agent-release/ - commit the three files"
