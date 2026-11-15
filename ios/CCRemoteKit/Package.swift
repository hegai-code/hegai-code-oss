// swift-tools-version:5.9
//
// The hub client, the wire protocol and the on-disk caches — everything both the
// iOS app and the macOS app need and neither one owns. No SwiftUI, no UIKit, no
// AppKit: the one dependency rule that keeps this package buildable from either
// shell. What the platforms genuinely differ on arrives by injection instead
// (see `BackgroundGrace`, `NotificationEngine.postBanner`).
//
// Two deliberate choices about this manifest:
//
//   * tools-version 5.9, not 6.x. CI builds the iOS app on a `macos-15` runner
//     whose Xcode cannot parse a newer manifest — and it would fail while
//     resolving the package, long before it noticed the macOS target is not even
//     in the scheme. A green iOS gate is worth more here than newer manifest
//     syntax.
//   * string platform versions, for the same reason: `.macOS(.v26)` is a symbol
//     that older tools do not have, while `"26.0"` is just a string to them.
//
// `swiftLanguageVersions: [.v5]` matches SWIFT_VERSION in project.yml. Without it
// the package would compile under a different concurrency regime than the app
// that imports it, and errors would appear on one side of the boundary only.
import PackageDescription

let package = Package(
    name: "CCRemoteKit",
    platforms: [.iOS("17.0"), .macOS("26.0")],
    products: [
        .library(name: "CCRemoteKit", targets: ["CCRemoteKit"]),
    ],
    targets: [
        .target(name: "CCRemoteKit", resources: [.process("Resources")]),
    ],
    swiftLanguageVersions: [.v5]
)
