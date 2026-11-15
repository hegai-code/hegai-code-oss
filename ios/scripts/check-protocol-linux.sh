#!/usr/bin/env bash
#
# Compile and TEST the wire protocol of CCRemoteKit on a box with no Xcode.
#
# Why this exists: CI builds the Apple targets on a macOS runner, and when that
# runner is unavailable — a billing hold, a queue, no network — Swift changes
# ship with nothing having compiled them. That is the worst kind of unverified,
# because the wire is where a mistake is silent: a `null` where the hub's zod
# expects an absent key fails validation and takes a whole `new_session` with
# it, and the symptom is a session that never appears.
#
# What it can and cannot cover:
#
#   CAN  — `Sources/CCRemoteKit/Protocol/*.swift`. Every file there imports
#          Foundation and nothing else, which is exactly what makes it portable:
#          the models, the encoders, the decoders, the golden-frame tests.
#   CANNOT — `Net/` and `Persistence/` (Security, AuthenticationServices, os),
#          and anything in the app targets (SwiftUI/UIKit/AppKit). Those still
#          need a Mac. This is a floor, not a substitute for the iOS gate.
#
# Tests that reach outside `Protocol/` carry a `// linux-skip:` comment in the
# test file and are dropped here rather than being silently broken — the marker
# keeps the reason next to the test instead of in this script.
#
# Toolchain: any swift.org Linux build. Point SWIFT_BIN at its `usr/bin`, or let
# the default below find the one installed on dev-box-1.
#
#   ./ios/scripts/check-protocol-linux.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$ROOT/ios/CCRemoteKit/Sources/CCRemoteKit/Protocol"
TESTS="$ROOT/ios/CCRemoteTests/ProtocolDecodingTests.swift"
SWIFT_BIN="${SWIFT_BIN:-/opt/swift/swift-6.1.2-RELEASE-ubuntu24.04/usr/bin}"

if [ ! -x "$SWIFT_BIN/swift" ]; then
  echo "No Swift toolchain at $SWIFT_BIN" >&2
  echo "Install one (≈2.8G unpacked):" >&2
  echo "  mkdir -p /opt/swift && cd /opt/swift \\" >&2
  echo "    && curl -sL https://download.swift.org/swift-6.1.2-release/ubuntu2404/swift-6.1.2-RELEASE/swift-6.1.2-RELEASE-ubuntu24.04.tar.gz | tar xz" >&2
  echo "…or set SWIFT_BIN to an existing one." >&2
  exit 1
fi
export PATH="$SWIFT_BIN:$PATH"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/Sources/CCRemoteKit" "$WORK/Tests/CCRemoteKitTests"

# No `platforms:` — that key only constrains Apple platforms and would make
# SwiftPM refuse the Linux host outright.
cat > "$WORK/Package.swift" <<'SWIFT'
// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "CCRemoteKit",
    targets: [
        .target(name: "CCRemoteKit"),
        .testTarget(name: "CCRemoteKitTests", dependencies: ["CCRemoteKit"]),
    ],
    swiftLanguageVersions: [.v5]
)
SWIFT

cp "$KIT"/*.swift "$WORK/Sources/CCRemoteKit/"
cp "$ROOT/ios/CCRemoteTests/WorkspaceSelectionTests.swift" "$ROOT/ios/CCRemoteTests/WorkActivityTests.swift" \
   "$ROOT/ios/CCRemoteTests/EnrichDigestTests.swift" "$ROOT/ios/CCRemoteTests/EnrichHeuristicsTests.swift" \
   "$ROOT/ios/CCRemoteTests/EnrichProtocolTests.swift" "$ROOT/ios/CCRemoteTests/StepTextTests.swift" "$ROOT/ios/CCRemoteTests/PreviewPathsTests.swift" "$ROOT/ios/CCRemoteTests/PlanProgressTests.swift" "$ROOT/ios/CCRemoteTests/E2eeTraversalTests.swift" \
   "$WORK/Tests/CCRemoteKitTests/"

# `@testable import CCRemote` is the APP target, which does not exist here; the
# marked tests that needed it are dropped with it.
python3 - "$TESTS" "$WORK/Tests/CCRemoteKitTests/ProtocolDecodingTests.swift" <<'PY'
import sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src).read().replace('@testable import CCRemote\n', '')

MARK = '// linux-skip:'
dropped = []
while MARK in s:
    i = s.index(MARK)
    start = s.rfind('\n', 0, i) + 1
    # The marker sits directly above its `func test…`; find that and brace-match.
    f = s.index('func ', i)
    name = s[f + 5:s.index('(', f)]
    b = s.index('{', f)
    depth, p = 0, b
    while p < len(s):
        if s[p] == '{':
            depth += 1
        elif s[p] == '}':
            depth -= 1
            if depth == 0:
                break
        p += 1
    s = s[:start] + s[p + 2:]
    dropped.append(name)

open(dst, 'w').write(s)
if dropped:
    print('skipped (needs a Mac): ' + ', '.join(dropped))
PY

cd "$WORK"
swift test 2>&1 | tail -6
