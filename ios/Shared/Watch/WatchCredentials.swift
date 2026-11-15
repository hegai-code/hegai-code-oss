import Foundation
import Security

/// The hub and the session the iPhone handed over (WATCH.md §7). Stored in the
/// keychain access group shared by the watch app and its complication extension;
/// the group id (with the team prefix) comes from Info.plist `HegaiKeychainGroup`.
struct WatchCredentials: Codable, Equatable {
    var hub: String
    var token: String

    var baseURL: URL? { URL(string: hub) }
}

enum WatchKeychain {
    private static let service = "net.hegai.ccremote.watch"
    private static let account = "session"

    private static var group: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "HegaiKeychainGroup") as? String,
              !g.isEmpty, !g.contains("$(") else { return nil }
        return g
    }

    private static func query() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    static func load() -> WatchCredentials? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
              let creds = try? JSONDecoder().decode(WatchCredentials.self, from: data),
              !creds.token.isEmpty, !creds.hub.isEmpty else { return nil }
        return creds
    }

    @discardableResult
    static func save(_ creds: WatchCredentials) -> Bool {
        guard let data = try? JSONEncoder().encode(creds) else { return false }
        let update: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query() as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        var add = query()
        add[kSecValueData as String] = data
        // The complication reads while the watch is locked.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func clear() { SecItemDelete(query() as CFDictionary) }

    /// Apply a WatchConnectivity context: `{hub, token}` stores, an empty or
    /// missing token forgets. Returns the resulting credentials.
    @discardableResult
    static func apply(context: [String: Any]) -> WatchCredentials? {
        let token = context["token"] as? String ?? ""
        if token.isEmpty { clear(); return nil }
        let hub = (context["hub"] as? String) ?? load()?.hub ?? ""
        guard !hub.isEmpty else { return load() }
        let creds = WatchCredentials(hub: hub, token: token)
        save(creds)
        return creds
    }
}

enum WatchInboxError: Error, Equatable {
    case unsigned          // no credentials / 401
    case forbidden         // 403: not an admin yet
    case offline
    case http(Int)
}

enum WatchAPI {
    static func fetchInbox(_ creds: WatchCredentials, session: URLSession = .shared) async throws -> WatchInbox {
        guard let base = creds.baseURL else { throw WatchInboxError.unsigned }
        var request = URLRequest(url: base.appendingPathComponent("api/watch/inbox"))
        request.timeoutInterval = 15
        request.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw WatchInboxError.offline }
        guard let http = response as? HTTPURLResponse else { throw WatchInboxError.offline }
        switch http.statusCode {
        case 200..<300:
            do { return try JSONDecoder().decode(WatchInbox.self, from: data) }
            catch { throw WatchInboxError.http(http.statusCode) }
        case 401: throw WatchInboxError.unsigned
        case 403: throw WatchInboxError.forbidden
        default: throw WatchInboxError.http(http.statusCode)
        }
    }

    static func fetchHistory(_ creds: WatchCredentials, machineId: String, sessionId: String, source: String? = nil, limit: Int,
                             session: URLSession = .shared) async throws -> WatchHistory {
        guard let base = creds.baseURL else { throw WatchInboxError.unsigned }
        var comps = URLComponents(url: base.appendingPathComponent("api/watch/history"),
                                  resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "machineId", value: machineId),
                             URLQueryItem(name: "sessionId", value: sessionId),
                             URLQueryItem(name: "limit", value: String(limit))]
        if let source { comps?.queryItems?.append(URLQueryItem(name: "source", value: source)) }
        guard let url = comps?.url else { throw WatchInboxError.http(0) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw WatchInboxError.offline }
        guard let http = response as? HTTPURLResponse else { throw WatchInboxError.offline }
        switch http.statusCode {
        case 200..<300:
            do { return try JSONDecoder().decode(WatchHistory.self, from: data) }
            catch { throw WatchInboxError.http(http.statusCode) }
        case 401: throw WatchInboxError.unsigned
        case 403: throw WatchInboxError.forbidden
        default: throw WatchInboxError.http(http.statusCode)
        }
    }
}
