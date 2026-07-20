import Foundation

enum NativeReadinessMode: String {
    case visual
    case nonvisualBehavior = "nonvisual-behavior"
}

enum NativeReadinessDecision: Equatable {
    case visualReady
    case bridgeOnly
    case visualUnavailable
}

func requiredNativeEnvironmentValue(
    _ name: String,
    environment: [String: String]
) -> String? {
    guard let value = environment[name],
          !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
    }
    return value
}

func resolvedNativeReadinessMode(environment: [String: String]) -> NativeReadinessMode? {
    let value = environment["NOVELIST_NATIVE_MODE"] ?? NativeReadinessMode.visual.rawValue
    return NativeReadinessMode(rawValue: value)
}

func nativeApplicationEnvironment(
    inherited: [String: String],
    mode: NativeReadinessMode
) -> [String: String] {
    let allowed = [
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME",
        "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "RUST_LOG",
        "TAURI_PLAYWRIGHT_SOCKET", "NOVELIST_NATIVE_SCREENSHOT", "NOVELIST_NATIVE_RUN_ID",
    ]
    var environment = Dictionary(uniqueKeysWithValues: allowed.compactMap { name in
        inherited[name].map { (name, $0) }
    })
    environment["NOVELIST_NATIVE_MODE"] = mode.rawValue
    return environment
}

func nativeInteractiveEnabled(environment: [String: String]) -> Bool {
    environment["NOVELIST_NATIVE_INTERACTIVE"] == "1"
}

func activationWindowSeconds(interactive: Bool) -> Int {
    interactive ? 120 : 5
}

func readinessWindowSeconds(interactive: Bool) -> Int {
    interactive ? 180 : 60
}

func interactiveActivationInstructions(
    runID: String,
    appDisplayName: String,
    pid: pid_t
) -> [String] {
    [
        "native_interactive_activation=waiting timeout_seconds=120",
        "native_interactive_run_id=\(runID)",
        "native_interactive_app=\(appDisplayName)",
        "native_interactive_pid=\(pid)",
        "native_interactive_instruction=Click or activate '\(appDisplayName)' in macOS within 120 seconds.",
    ]
}

func readinessDecision(
    mode: NativeReadinessMode,
    isActive: Bool,
    ownsMenuBar: Bool,
    hasVisibleWindow: Bool
) -> NativeReadinessDecision {
    switch mode {
    case .visual:
        return isActive && ownsMenuBar && hasVisibleWindow ? .visualReady : .visualUnavailable
    case .nonvisualBehavior:
        return .bridgeOnly
    }
}
