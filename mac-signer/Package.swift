// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HegaiSigner",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "HegaiSignerCore"),
        .executableTarget(name: "HegaiSigner", dependencies: ["HegaiSignerCore"]),
        .testTarget(name: "HegaiSignerCoreTests", dependencies: ["HegaiSignerCore"]),
    ]
)
