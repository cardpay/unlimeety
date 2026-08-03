// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "unlimeety-live",
    platforms: [.macOS("14.2")],
    dependencies: [
        // Pinned to an immutable revision (not the moving `main` branch) so a
        // `swift package update` can't silently pull unreviewed upstream code —
        // supply-chain hardening for the ML stack. Bump deliberately after review.
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", revision: "80d96762fa727f816ffceab76a6529cd12c2726f"),
    ],
    targets: [
        .executableTarget(
            name: "unlimeety-live",
            dependencies: [
                .product(name: "WhisperKit", package: "argmax-oss-swift"),
                .product(name: "SpeakerKit", package: "argmax-oss-swift"),
            ],
            path: "Sources/TranscriberLive",
            linkerSettings: [
                // Embed Info.plist into the __TEXT,__info_plist section so TCC
                // can read NSCalendarsFullAccessUsageDescription and actually
                // prompt for calendar access (the helper is a bare CLI tool,
                // not an .app bundle). Path is relative to the package root;
                // `swift build` is invoked from live-helper/ (see package.json
                // build:helper).
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist",
                ]),
            ]
        ),
    ]
)
