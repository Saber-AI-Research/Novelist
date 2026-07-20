import Foundation

@main
private enum SupervisorPolicyTest {
    static func main() {
        precondition(!nativeInteractiveEnabled(environment: [:]))
        precondition(nativeInteractiveEnabled(environment: ["NOVELIST_NATIVE_INTERACTIVE": "1"]))
        precondition(!nativeInteractiveEnabled(environment: ["NOVELIST_NATIVE_INTERACTIVE": "0"]))
        precondition(!nativeInteractiveEnabled(environment: ["NOVELIST_NATIVE_INTERACTIVE": "true"]))
        precondition(!nativeInteractiveEnabled(environment: ["NOVELIST_NATIVE_INTERACTIVE": " 1 "]))
        precondition(requiredNativeEnvironmentValue(
            "NOVELIST_NATIVE_RUN_ID",
            environment: ["NOVELIST_NATIVE_RUN_ID": "t24-test"]
        ) == "t24-test")
        precondition(requiredNativeEnvironmentValue(
            "NOVELIST_NATIVE_RUN_ID",
            environment: ["NOVELIST_NATIVE_RUN_ID": " \t\n"]
        ) == nil)
        let defaultMode = resolvedNativeReadinessMode(environment: [:])
        precondition(defaultMode == .visual)
        let defaultChildEnvironment = nativeApplicationEnvironment(
            inherited: ["PATH": "/usr/bin"],
            mode: defaultMode!
        )
        precondition(defaultChildEnvironment["PATH"] == "/usr/bin")
        precondition(defaultChildEnvironment["NOVELIST_NATIVE_MODE"] == "visual")
        let nonvisualMode = resolvedNativeReadinessMode(
            environment: ["NOVELIST_NATIVE_MODE": "nonvisual-behavior"]
        )
        precondition(nonvisualMode == .nonvisualBehavior)
        precondition(nativeApplicationEnvironment(
            inherited: [:],
            mode: nonvisualMode!
        )["NOVELIST_NATIVE_MODE"] == "nonvisual-behavior")
        precondition(activationWindowSeconds(interactive: false) == 5)
        precondition(activationWindowSeconds(interactive: true) == 120)
        precondition(readinessWindowSeconds(interactive: false) == 60)
        precondition(readinessWindowSeconds(interactive: true) == 180)
        precondition(readinessDecision(mode: .visual, isActive: false, ownsMenuBar: false, hasVisibleWindow: false) == .visualUnavailable)
        precondition(readinessDecision(mode: .visual, isActive: true, ownsMenuBar: true, hasVisibleWindow: false) == .visualUnavailable)
        precondition(readinessDecision(mode: .visual, isActive: true, ownsMenuBar: true, hasVisibleWindow: true) == .visualReady)
        precondition(readinessDecision(mode: .nonvisualBehavior, isActive: false, ownsMenuBar: false, hasVisibleWindow: false) == .bridgeOnly)
        precondition(interactiveActivationInstructions(
            runID: "t24-test",
            appDisplayName: "Novelist E2E t24-test.app",
            pid: 4242
        ) == [
            "native_interactive_activation=waiting timeout_seconds=120",
            "native_interactive_run_id=t24-test",
            "native_interactive_app=Novelist E2E t24-test.app",
            "native_interactive_pid=4242",
            "native_interactive_instruction=Click or activate 'Novelist E2E t24-test.app' in macOS within 120 seconds.",
        ])
        print("macos-supervisor-policy-pass")
    }
}
