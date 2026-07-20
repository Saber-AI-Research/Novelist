import AppKit
import Darwin
import Foundation

private enum SupervisorError: Error, CustomStringConvertible {
    case invalidArguments
    case launchFailed(String)
    case readinessTimedOut(String)

    var description: String {
        switch self {
        case .invalidArguments:
            return "usage: macos-app-supervisor <bundle-path>"
        case let .launchFailed(message), let .readinessTimedOut(message):
            return message
        }
    }
}

private func requiredEnvironment(_ name: String) throws -> String {
    guard let value = requiredNativeEnvironmentValue(
        name,
        environment: ProcessInfo.processInfo.environment
    ) else {
        throw SupervisorError.launchFailed("missing supervisor environment: \(name)")
    }
    return value
}

private func reportStage(_ name: String, _ state: String) {
    let milliseconds = Int(Date().timeIntervalSince1970 * 1_000)
    print("native_stage=\(name) state=\(state) epoch_ms=\(milliseconds)")
    fflush(stdout)
}

private final class ApplicationSupervisor {
    private let workspace = NSWorkspace.shared
    private let bundleURL: URL
    private let identifier: String
    private let projectDirectory: String
    private let socketPath: String
    private let mode: NativeReadinessMode
    private let interactive: Bool
    private let runID: String
    private let clock = ContinuousClock()
    private var application: NSRunningApplication?
    private var signalSources: [DispatchSourceSignal] = []
    private var terminating = false

    init(
        bundleURL: URL,
        identifier: String,
        projectDirectory: String,
        socketPath: String,
        mode: NativeReadinessMode,
        interactive: Bool,
        runID: String
    ) {
        self.bundleURL = bundleURL
        self.identifier = identifier
        self.projectDirectory = projectDirectory
        self.socketPath = socketPath
        self.mode = mode
        self.interactive = interactive
        self.runID = runID
    }

    func run() throws -> Never {
        installSignalHandlers()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = true
        configuration.allowsRunningApplicationSubstitution = false
        configuration.arguments = [projectDirectory]
        configuration.environment = nativeApplicationEnvironment(
            inherited: ProcessInfo.processInfo.environment,
            mode: mode
        )

        reportStage("launch_services", "request")
        let completion = DispatchSemaphore(value: 0)
        var launchError: Error?
        workspace.openApplication(at: bundleURL, configuration: configuration) { [weak self] app, error in
            launchError = error
            self?.application = app
            completion.signal()
        }
        let launchDeadline = clock.now.advanced(by: .seconds(60))
        while completion.wait(timeout: .now() + 0.05) == .timedOut {
            if clock.now >= launchDeadline {
                reportStage("launch_services", "fail")
                throw SupervisorError.readinessTimedOut("LaunchServices completion timed out after 60 seconds")
            }
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01))
        }
        if let launchError {
            throw SupervisorError.launchFailed("LaunchServices failed: \(launchError)")
        }
        guard let application else {
            throw SupervisorError.launchFailed("LaunchServices returned no NSRunningApplication")
        }
        guard application.bundleURL?.standardizedFileURL == bundleURL.standardizedFileURL else {
            throw SupervisorError.launchFailed("LaunchServices substituted bundle: \(application.bundleURL?.path ?? "nil")")
        }
        guard application.bundleIdentifier == identifier else {
            throw SupervisorError.launchFailed("bundle identifier mismatch: \(application.bundleIdentifier ?? "nil")")
        }
        reportStage("launch_services", "pass")
        if interactive {
            for line in interactiveActivationInstructions(
                runID: runID,
                appDisplayName: bundleURL.lastPathComponent,
                pid: application.processIdentifier
            ) {
                print(line)
            }
            fflush(stdout)
        }

        reportStage("activation_socket", "begin")
        let readiness = try waitUntilReady(application)
        reportStage(
            "activation_socket",
            readiness == .visualReady ? "visual_ready" : "bridge_only"
        )
        report(application)
        if readiness == .visualReady {
            print("novelist-native-supervisor-visual-ready")
        } else {
            print("novelist-native-supervisor-bridge-only")
        }
        print("tauri-plugin-playwright: listening on unix: \(socketPath)")
        fflush(stdout)

        while !application.isTerminated {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        }
        reportTermination(application, graceful: true, forced: false)
        Foundation.exit(EXIT_SUCCESS)
    }

    private func waitUntilReady(_ application: NSRunningApplication) throws -> NativeReadinessDecision {
        let deadline = clock.now.advanced(
            by: .seconds(Int64(readinessWindowSeconds(interactive: interactive)))
        )
        var activationAccepted = false
        var socketReadyAt: ContinuousClock.Instant?
        while clock.now < deadline {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
            if application.isTerminated {
                throw SupervisorError.launchFailed("GUI application terminated before readiness")
            }
            if !application.isActive {
                application.unhide()
                activationAccepted = application.activate(options: [.activateAllWindows]) || activationAccepted
            }
            let hasLaunchIdentity = application.launchDate != nil
                && application.activationPolicy == .regular
                && application.processIdentifier > 0
            let socketReady = FileManager.default.fileExists(atPath: socketPath)
            if hasLaunchIdentity && socketReady {
                let ownsMenuBar = workspace.frontmostApplication?.processIdentifier
                    == application.processIdentifier
                let visibleWindow = hasVisibleApplicationWindow(pid: application.processIdentifier)
                let decision = readinessDecision(
                    mode: mode,
                    isActive: application.isActive,
                    ownsMenuBar: ownsMenuBar,
                    hasVisibleWindow: visibleWindow
                )
                if decision == .visualReady || decision == .bridgeOnly {
                    return decision
                }
                if socketReadyAt == nil {
                    socketReadyAt = clock.now
                    reportStage("activation", "pending")
                } else if let socketReadyAt,
                          clock.now >= socketReadyAt.advanced(
                              by: .seconds(Int64(activationWindowSeconds(interactive: interactive)))
                          ) {
                    reportStage("activation", "unavailable")
                    throw SupervisorError.readinessTimedOut(
                        "visual readiness unavailable: pid=\(application.processIdentifier) "
                            + "active=\(application.isActive) ownsMenuBar=\(ownsMenuBar) "
                            + "visibleWindow=\(visibleWindow) interactive=\(interactive) "
                            + "activationAccepted=\(activationAccepted)"
                    )
                }
            }
        }
        throw SupervisorError.readinessTimedOut(
            "GUI readiness timed out: pid=\(application.processIdentifier) "
                + "launchDate=\(String(describing: application.launchDate)) "
                + "policy=\(application.activationPolicy.rawValue) active=\(application.isActive) "
                + "activationAccepted=\(activationAccepted) "
                + "socket=\(socketPath)"
        )
    }

    private func report(_ application: NSRunningApplication) {
        let ownsMenuBar = workspace.frontmostApplication?.processIdentifier == application.processIdentifier
        let visibleWindow = hasVisibleApplicationWindow(pid: application.processIdentifier)
        print("gui_pid=\(application.processIdentifier)")
        print("gui_bundle_url=\(application.bundleURL?.path ?? "nil")")
        print("gui_bundle_id=\(application.bundleIdentifier ?? "nil")")
        print("gui_launch_date=\(application.launchDate?.description ?? "nil")")
        print("gui_activation_policy=\(application.activationPolicy.rawValue)")
        print("gui_active=\(application.isActive)")
        print("gui_owns_menu_bar=\(ownsMenuBar)")
        print("gui_visible_window=\(visibleWindow)")
        print("native_readiness_mode=\(mode.rawValue)")
        print("native_interactive=\(interactive)")
    }

    private func hasVisibleApplicationWindow(pid: pid_t) -> Bool {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return false
        }
        return windows.contains { window in
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  (bounds["Width"] as? NSNumber)?.doubleValue ?? 0 > 0,
                  (bounds["Height"] as? NSNumber)?.doubleValue ?? 0 > 0 else {
                return false
            }
            return true
        }
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGINT, SIGTERM] {
            Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in self?.terminateApplication() }
            source.resume()
            signalSources.append(source)
        }
    }

    private func terminateApplication() {
        guard !terminating else { return }
        terminating = true
        guard let application, !application.isTerminated else {
            Foundation.exit(EXIT_SUCCESS)
        }
        let gracefulRequested = application.terminate()
        let gracefulDeadline = Date(timeIntervalSinceNow: 5)
        while !application.isTerminated && Date() < gracefulDeadline {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        }
        var forcedRequested = false
        if !application.isTerminated {
            forcedRequested = application.forceTerminate()
            let forcedDeadline = Date(timeIntervalSinceNow: 5)
            while !application.isTerminated && Date() < forcedDeadline {
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
            }
        }
        reportTermination(application, graceful: gracefulRequested, forced: forcedRequested)
        Foundation.exit(application.isTerminated ? EXIT_SUCCESS : EXIT_FAILURE)
    }

    private func reportTermination(
        _ application: NSRunningApplication,
        graceful: Bool,
        forced: Bool
    ) {
        print("gui_terminate_requested=\(graceful)")
        print("gui_force_terminate_requested=\(forced)")
        print("gui_terminated=\(application.isTerminated)")
        fflush(stdout)
    }
}

@main
private enum SupervisorMain {
    static func main() {
        do {
            guard CommandLine.arguments.count == 2 else { throw SupervisorError.invalidArguments }
            let bundleURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            let environment = ProcessInfo.processInfo.environment
            let modeValue = environment["NOVELIST_NATIVE_MODE"] ?? NativeReadinessMode.visual.rawValue
            guard let mode = resolvedNativeReadinessMode(environment: environment) else {
                throw SupervisorError.launchFailed("invalid NOVELIST_NATIVE_MODE: \(modeValue)")
            }
            let supervisor = ApplicationSupervisor(
                bundleURL: bundleURL,
                identifier: try requiredEnvironment("NOVELIST_NATIVE_IDENTIFIER"),
                projectDirectory: try requiredEnvironment("NOVELIST_NATIVE_PROJECT_DIR"),
                socketPath: try requiredEnvironment("TAURI_PLAYWRIGHT_SOCKET"),
                mode: mode,
                interactive: nativeInteractiveEnabled(environment: environment),
                runID: try requiredEnvironment("NOVELIST_NATIVE_RUN_ID")
            )
            try supervisor.run()
        } catch {
            fputs("native supervisor error: \(error)\n", stderr)
            Foundation.exit(EXIT_FAILURE)
        }
    }
}
