import CryptoKit
import Foundation

/// A credential remembers only the identity the hub previously verified for
/// it. An offline launch cannot borrow the last person's inventory. Tokens and
/// emails never become directory names.
struct ClientStorage {
    let root: URL

    static var applicationSupport: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    init(root: URL = applicationSupport) {
        self.root = root
        try? retryErasure()
    }

    static func digest(_ parts: [String]) -> String {
        let data = Data(parts.map { "\($0.utf8.count):\($0)" }.joined().utf8)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func credentialKey(endpoint: String, token: String, workspace: String?) -> String {
        Self.digest([endpoint, token, workspace ?? ""])
    }

    func scope(endpoint: String, token: String, workspace: String?) -> String {
        let key = credentialKey(endpoint: endpoint, token: token, workspace: workspace)
        return bindings()[key] ?? "credential-\(key)"
    }

    func verifiedScope(endpoint: String, viewer: ViewerContext) -> String {
        "account-" + Self.digest([endpoint, viewer.userId, viewer.workspace.workspaceId])
    }

    func bind(endpoint: String, token: String, requestedWorkspace: String?, viewer: ViewerContext) -> String {
        let scope = verifiedScope(endpoint: endpoint, viewer: viewer)
        var owners = accountScopes()
        let identity = Self.digest([endpoint, viewer.userId])
        var scopes = Set(owners[identity] ?? [])
        scopes.insert(scope)
        for workspace in viewer.workspaces {
            scopes.insert("account-" + Self.digest([endpoint, viewer.userId, workspace.workspaceId]))
        }
        owners[identity] = Array(scopes)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(owners) { try? data.write(to: scopesURL, options: .atomic) }
        var map = bindings()
        map[credentialKey(endpoint: endpoint, token: token, workspace: requestedWorkspace)] = scope
        map[credentialKey(endpoint: endpoint, token: token, workspace: viewer.workspace.workspaceId)] = scope
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(map) { try? data.write(to: bindingsURL, options: .atomic) }
        return scope
    }

    func directory(_ scope: String) -> URL {
        root.appendingPathComponent("Accounts", isDirectory: true).appendingPathComponent(scope, isDirectory: true)
    }

    func scopesForAccount(endpoint: String, user: String) -> Set<String> {
        Set(accountScopes()[Self.digest([endpoint, user])] ?? [])
    }

    /// Persist the erasure intent before touching files. Failed disk operations
    /// are retried on launch; bindings are removed only after successful cleanup.
    func erase(scopes: Set<String>) throws {
        let previous = (try? Data(contentsOf: erasureURL)).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(Array(scopes.union(previous))).write(to: erasureURL, options: .atomic)
        try retryErasure()
    }

    private func retryErasure() throws {
        guard FileManager.default.fileExists(atPath: erasureURL.path) else { return }
        let scopes = Set(try JSONDecoder().decode([String].self, from: Data(contentsOf: erasureURL)))
        for scope in scopes {
            // Names are generated hashes; do not interpret an edited manifest as a path.
            guard scope.hasPrefix("account-") || scope.hasPrefix("credential-"),
                  scope.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { continue }
            let url = directory(scope)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
        try JSONEncoder().encode(bindings().filter { !scopes.contains($0.value) }).write(to: bindingsURL, options: .atomic)
        let owners = accountScopes().mapValues { $0.filter { !scopes.contains($0) } }.filter { !$0.value.isEmpty }
        try JSONEncoder().encode(owners).write(to: scopesURL, options: .atomic)
        try FileManager.default.removeItem(at: erasureURL)
    }

    private var scopesURL: URL { root.appendingPathComponent("AccountScopes.json") }
    private var erasureURL: URL { root.appendingPathComponent("PendingAccountErasure.json") }
    private func accountScopes() -> [String: [String]] {
        guard let data = try? Data(contentsOf: scopesURL),
              let value = try? JSONDecoder().decode([String: [String]].self, from: data) else { return [:] }
        return value
    }

    private var bindingsURL: URL { root.appendingPathComponent("AccountBindings.json") }
    private func bindings() -> [String: String] {
        guard let data = try? Data(contentsOf: bindingsURL),
              let map = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return map
    }
}
