// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SurfConditions",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "SurfConditions",
            path: "Sources/SurfConditions"
        )
    ]
)
