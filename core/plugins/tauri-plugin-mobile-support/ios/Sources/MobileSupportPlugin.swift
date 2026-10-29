import Foundation
import Security
import SwiftRs
import Tauri
import UIKit
import WebKit

struct ShareFileArgs: Decodable {
  let path: String
}

struct CredentialKeyArgs: Decodable {
  let service: String
  let account: String
}

struct CredentialEntryArgs: Decodable {
  let service: String
  let account: String
  let secret: String
}

/// Native half of tauri-plugin-mobile-support. Every command is reached only
/// from the plugin's Rust code (none is in the webview ACL), which has already
/// validated paths and vault bounds. Commands run on Tauri's serial "ipc"
/// queue; UIKit work hops to the main queue.
class MobileSupportPlugin: Plugin {
  private static let vaultFailure = "credential vault operation failed"

  /// Main-queue only.
  private var shareInFlight = false

  @objc public func shareFile(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(ShareFileArgs.self),
      let url = StagedExport.resolve(args.path)
    else {
      invoke.reject("file is not a staged export")
      return
    }
    DispatchQueue.main.async {
      self.presentShareSheet(for: url, invoke: invoke)
    }
  }

  @objc public func getCredential(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(CredentialKeyArgs.self)
      if let value = try CredentialVault.get(service: args.service, account: args.account) {
        invoke.resolve(["value": value])
      } else {
        invoke.resolve(JsonObject())
      }
    } catch {
      invoke.reject(Self.vaultFailure)
    }
  }

  @objc public func setCredential(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(CredentialEntryArgs.self)
      try CredentialVault.set(service: args.service, account: args.account, secret: args.secret)
      invoke.resolve()
    } catch {
      invoke.reject(Self.vaultFailure)
    }
  }

  @objc public func deleteCredential(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(CredentialKeyArgs.self)
      try CredentialVault.delete(service: args.service, account: args.account)
      invoke.resolve()
    } catch {
      invoke.reject(Self.vaultFailure)
    }
  }

  private func presentShareSheet(for url: URL, invoke: Invoke) {
    guard !shareInFlight else {
      invoke.reject("a share sheet is already open")
      return
    }
    guard let presenter = topViewController() else {
      invoke.reject("no view controller can present the share sheet")
      return
    }
    // UIKit silently drops present() from a controller that is mid-transition,
    // still presenting (e.g. a modal animating closed), or off-window; the
    // completion handler would then never run. Refuse up front, before any
    // state is set, so the caller can simply retry.
    guard presenter.presentedViewController == nil,
      !presenter.isBeingPresented,
      !presenter.isBeingDismissed,
      presenter.viewIfLoaded?.window != nil
    else {
      invoke.reject("another screen is still opening or closing; try sharing again")
      return
    }

    let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    if let popover = controller.popoverPresentationController {
      // iPad shows the sheet as a popover, which raises without an anchor:
      // pin it, arrowless, to the presenter's center.
      let view: UIView = presenter.view
      popover.sourceView = view
      popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
      popover.permittedArrowDirections = []
    }

    var settled = false
    controller.completionWithItemsHandler = { [weak self] _, completed, _, error in
      DispatchQueue.main.async {
        // Guard against the handler firing more than once.
        guard !settled else { return }
        settled = true
        self?.shareInFlight = false
        if error != nil {
          invoke.reject("the share target reported an error")
        } else {
          // `completed` means the chosen activity finished, not that the file
          // was delivered; anything else is the user backing out.
          invoke.resolve(["outcome": completed ? "completed" : "cancelled"])
        }
      }
    }

    shareInFlight = true
    presenter.present(controller, animated: true)
  }

  private func topViewController() -> UIViewController? {
    var top = manager.viewController ?? Self.keyWindowRootViewController()
    while let presented = top?.presentedViewController, !presented.isBeingDismissed {
      top = presented
    }
    return top
  }

  private static func keyWindowRootViewController() -> UIViewController? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }?
      .rootViewController
  }
}

/// Re-check of the Rust share-path validation (Rust pins the exact
/// `<app_cache_dir>/exports` root; this independently requires the file to
/// resolve under `Library/Caches/<app dir>/exports/`).
enum StagedExport {
  static func resolve(_ path: String) -> URL? {
    guard path.hasPrefix("/"),
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    else {
      return nil
    }
    // Resolve both sides the same way so `/private/var` vs `/var` cannot differ.
    let root = caches.resolvingSymlinksInPath().standardizedFileURL.pathComponents
    let file = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    let parts = file.pathComponents
    guard parts.count > root.count + 2,
      Array(parts.prefix(root.count)) == root,
      parts[root.count + 1] == "exports",
      let values = try? file.resourceValues(forKeys: [.isRegularFileKey]),
      values.isRegularFile == true
    else {
      return nil
    }
    return file
  }
}

/// Generic-password Keychain items, this device only, never synchronized.
/// Every failure is the same opaque error; nothing is logged.
enum CredentialVault {
  struct Failure: Error {}

  /// Namespaces plugin items away from any other Keychain users in the app.
  private static let servicePrefix = "novelist.vault."

  private static func itemQuery(service: String, account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: servicePrefix + service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
  }

  static func get(service: String, account: String) throws -> String? {
    var query = itemQuery(service: service, account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    switch SecItemCopyMatching(query as CFDictionary, &item) {
    case errSecSuccess:
      guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
        throw Failure()
      }
      return value
    case errSecItemNotFound:
      return nil
    default:
      throw Failure()
    }
  }

  static func set(service: String, account: String, secret: String) throws {
    let query = itemQuery(service: service, account: account)
    // Updating also rewrites the accessibility class of an existing item.
    let attributes: [String: Any] = [
      kSecValueData as String: Data(secret.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw Failure()
    }
  }

  static func delete(service: String, account: String) throws {
    let status = SecItemDelete(itemQuery(service: service, account: account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw Failure()
    }
  }
}

@_cdecl("init_plugin_mobile_support")
func initPlugin() -> Plugin {
  return MobileSupportPlugin()
}
