#!/bin/bash
# Run one XCTest target/class N times on the first available iPhone simulator —
# for hunting a flap, which a single run cannot tell from a bug.
#   ios/scripts/repeat-test.sh CCRemoteTests/GrowingTextFieldTests 5
# Same UDID pick as .github/workflows/ios.yml; DerivedData in ios/build (shared
# machine — never the user-wide one). Logs: /tmp/repeat-test-<n>.log.
set -euo pipefail
cd "$(dirname "$0")/.."
T=${1:?test id, e.g. CCRemoteTests/GrowingTextFieldTests}; N=${2:-5}
UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
for rt in sorted(d, reverse=True):
    if "iOS" not in rt: continue
    for dev in d[rt]:
        if dev["name"].startswith("iPhone"): print(dev["udid"]); raise SystemExit
raise SystemExit("no iPhone simulator available")')
[ -d CCRemote.xcodeproj ] || xcodegen generate >/dev/null
pass=0; fail=0
for i in $(seq 1 "$N"); do
  if xcodebuild test -project CCRemote.xcodeproj -scheme CCRemote -only-testing:"$T" \
       -destination "id=$UDID" -configuration Debug CODE_SIGNING_ALLOWED=NO \
       -derivedDataPath build >"/tmp/repeat-test-$i.log" 2>&1; then
    pass=$((pass+1)); echo "run $i: pass"
  else
    fail=$((fail+1)); echo "run $i: FAIL — $(grep -m1 -E 'error:|failed' "/tmp/repeat-test-$i.log" | cut -c1-160)"
  fi
done
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
