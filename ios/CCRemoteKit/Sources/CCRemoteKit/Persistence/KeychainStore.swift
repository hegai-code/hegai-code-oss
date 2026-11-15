import Foundation
import Security

/// Minimal Keychain wrapper for secrets (the hub access token).
/// Generic-password items keyed by account under a per-app service.
///
/// The service is the bundle identifier, which keeps iOS on exactly the string it
/// has always used (`net.hegai.ccremote`) while giving the Mac app its own
/// (`net.hegai.ccremote.mac`). That separation is not tidiness: on macOS a
/// keychain item's ACL is bound to the signature of the binary that created it,
/// so two differently-signed apps sharing one service means a password prompt at
/// every launch of whichever one did not create it.
public enum KeychainStore {
    private static let service = Bundle.main.bundleIdentifier ?? "net.hegai.ccremote"
    public static let tokenAccount = "hub-token"

    /// macOS routes these calls to the **legacy file-based login keychain**, whose
    /// items carry per-application ACLs: a binary that did not create an item must
    /// ask for the login-keychain password to read it. That dialog is raised
    /// before the first scene exists, so the failure mode is not an error — it is
    /// an app with no window and no menu bar item that looks simply dead.
    ///
    /// The modern data-protection keychain (`kSecUseDataProtectionKeychain`) has
    /// no ACLs and would sidestep that entirely. It is NOT available here, and
    /// this was measured rather than assumed: a Developer-ID-signed binary gets
    /// `errSecMissingEntitlement` (-34018) on `SecItemAdd`, and adding
    /// `keychain-access-groups` to satisfy it makes the process **SIGKILL on
    /// launch**, because that entitlement needs an embedded provisioning profile
    /// this distribution path does not have. So: legacy keychain, deliberately.
    ///
    /// What makes the legacy keychain behave is the pair of properties above —
    /// a stable Developer ID signature (never ad-hoc, which changes per build)
    /// and a per-bundle service name, so each app only ever reads items it
    /// created itself.
    private static func scoped(_ query: [String: Any]) -> CFDictionary {
        query as CFDictionary
    }

    public static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(scoped(query), &out) == errSecSuccess,
              let data = out as? Data,
              let str = String(data: data, encoding: .utf8)
        else { return nil }
        return str
    }

    /// `load` that tells "nothing stored" from "could not read" (a locked
    /// Keychain before first unlock, an interaction-not-allowed state): a caller
    /// that must never write over what it failed to read needs the difference.
    public enum ReadResult: Sendable, Equatable { case value(String), notFound, failed(Int32) }

    public static func read(account: String) -> ReadResult {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(scoped(query), &out)
        if status == errSecItemNotFound { return .notFound }
        guard status == errSecSuccess else { return .failed(status) }
        guard let data = out as? Data, let str = String(data: data, encoding: .utf8) else { return .failed(errSecDecode) }
        return .value(str)
    }

    @discardableResult
    public static func save(_ value: String, account: String) -> Bool {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(scoped(base))
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(scoped(add), nil) == errSecSuccess
    }

    /// Like `save`, but the item never leaves this device: not in an iCloud
    /// Keychain sync, not in a backup restored onto another phone. For secrets
    /// whose whole point is that nobody else holds them (a private machine's
    /// content key, docs/E2EE.md).
    @discardableResult
    public static func saveThisDeviceOnly(_ value: String, account: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Update in place when the item exists: deleting first would lose the old
        // value if the write then failed (for a key ring, every key at once).
        let fields: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(scoped(base), fields as CFDictionary)
        if updated == errSecSuccess { return true }
        guard updated == errSecItemNotFound else { return false }
        var add = base.merging(fields) { _, new in new }
        add[kSecAttrSynchronizable as String] = false
        return SecItemAdd(scoped(add), nil) == errSecSuccess
    }

    /// True when nothing is stored under `account` afterwards.
    @discardableResult
    public static func delete(account: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(scoped(base))
        return status == errSecSuccess || status == errSecItemNotFound
    }

    // Convenience wrappers for the hub token (kept for existing call sites).
    /// The raw stored value (`<hub>\n<token>`, or a bare token from before the binding).
    public static func loadToken() -> String? { load(account: tokenAccount) }

    /// The session for `hub`, or nil. A token is stored together with the hub
    /// that issued it in ONE Keychain item, so no crash between two writes can
    /// pair a bearer with another hub's address. A bare token was written by a
    /// build that kept exactly one hub at a time; it is taken as this hub's.
    public static func loadToken(forHub hub: String) -> String? {
        guard let raw = loadToken(), !raw.isEmpty else { return nil }
        guard let split = raw.firstIndex(of: "\n") else { return raw }
        let origin = String(raw[..<split])
        let token = String(raw[raw.index(after: split)...])
        return origin == hub && !token.isEmpty ? token : nil
    }

    @discardableResult public static func saveToken(_ token: String, hub: String) -> Bool {
        save("\(hub)\n\(token)", account: tokenAccount)
    }
    @discardableResult public static func deleteToken() -> Bool { delete(account: tokenAccount) }
}
