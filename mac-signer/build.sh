#!/usr/bin/env bash
# Build, sign (Developer ID), notarize, staple, zip and upload Hegai Signer.
# Run ON dev-mac-mini-001 from the mac-signer/ directory.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${SIGNER_VERSION:-1.0.0}"
KEY_P8="${ASC_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_MTUNQ6ARKS.p8}"
KEY_ID=MTUNQ6ARKS
ISSUER=a7b3038d-738d-4f94-81ec-00124cddfd4b
DEST=root@198.51.100.233:/var/www/code.acme.test/dl/signer/
OUT=build
APP="$OUT/HegaiSigner.app"
ZIP="$OUT/HegaiSigner-mac.zip"

xcrun swift --version
swift build -c release
BIN="$(swift build -c release --show-bin-path)/HegaiSigner"

rm -rf "$OUT"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/HegaiSigner"
sed "s/__VERSION__/$VERSION/g" Info.plist.in > "$APP/Contents/Info.plist"
[ -f AppIcon.icns ] && { cp AppIcon.icns "$APP/Contents/Resources/"; }

# Identity by team, not "first match"
IDENT="$(security find-identity -v -p codesigning | grep -E 'Developer ID Application: .* \(AZWU5VAA73\)' | head -1 | sed -E 's/^ *[0-9]+\) ([0-9A-F]+) .*/\1/')"
[ -n "$IDENT" ] || { echo "no Developer ID Application identity for team AZWU5VAA73"; exit 1; }
echo "identity: $IDENT"
# Developer ID provisioning profile (MAC_APP_DIRECT, net.hegai.signer): carries the keychain-access-groups
# entitlement. Create with tools/asc-profile.swift.
PROFILE="${SIGNER_PROFILE:-$HOME/signer.provisionprofile}"
[ -f "$PROFILE" ] || { echo "missing provisioning profile $PROFILE (run: swift tools/asc-profile.swift $PROFILE)"; exit 1; }
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
codesign --force --options runtime --timestamp --entitlements HegaiSigner.entitlements --sign "$IDENT" "$APP"
codesign --verify --strict --verbose=2 "$APP"
codesign -d --entitlements - "$APP" 2>&1 | grep -E 'keychain-access-groups|application-identifier|AZWU5VAA73' || { echo "entitlements missing"; exit 1; }
"$APP/Contents/MacOS/HegaiSigner" --selftest

ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
xcrun notarytool submit "$OUT/notarize.zip" --key "$KEY_P8" --key-id "$KEY_ID" --issuer "$ISSUER" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

ditto -c -k --keepParent "$APP" "$ZIP"   # after stapling
ssh root@198.51.100.233 'mkdir -p /var/www/code.acme.test/dl/signer'
# Never overwrite the live file in place: upload beside it, then rename.
PART="HegaiSigner-mac.zip.part-$(date +%s)-$$"   # unique: overlapping builds never share it
scp "$ZIP" "${DEST}${PART}"
ssh root@198.51.100.233 "mv /var/www/code.acme.test/dl/signer/${PART} /var/www/code.acme.test/dl/signer/HegaiSigner-mac.zip"
shasum -a 256 "$ZIP"
echo "https://code.acme.test/dl/signer/HegaiSigner-mac.zip"
