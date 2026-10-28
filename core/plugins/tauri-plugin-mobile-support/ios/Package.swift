// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-mobile-support",
  platforms: [
    // Matches bundle.iOS.minimumSystemVersion in core/tauri.ios.conf.json.
    .iOS("16.0")
  ],
  products: [
    .library(
      name: "tauri-plugin-mobile-support",
      type: .static,
      targets: ["tauri-plugin-mobile-support"])
  ],
  dependencies: [
    // Copied here by tauri-plugin's build script (build.rs `.ios_path("ios")`).
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-mobile-support",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
