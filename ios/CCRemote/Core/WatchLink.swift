import Foundation
import WatchConnectivity
import CryptoKit
import CCRemoteKit

/// Hands the watch app the hub and ITS OWN session (WATCH.md §7) over
/// `updateApplicationContext`; the watch keeps them in its own keychain group.
/// The phone's session token never leaves the phone: `POST /api/watch/session`
/// (Bearer phone session) mints a separate «Apple Watch» session.
/// Signing out, a 403, or no hub sends `["token": ""]` so the watch forgets.
///
/// Re-mint policy: the minted token is cached in the phone keychain (account
/// `watch-token`, value `hub\ntoken\nmintedAt\nsha256(phone token)`) and reused for 24 h; the watch
/// asks for a fresh one with `{needToken: true}` (`transferUserInfo`) after a 401,
/// at most once per 10 min.
@MainActor
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()
    nonisolated static let account = "watch-token"
    nonisolated static let maxAge: TimeInterval = 24 * 3600
    nonisolated static let minRemintGap: TimeInterval = 10 * 60

    private var context: [String: String] = [:]
    private var hubBase: String?
    private var phoneToken = ""
    private var lastMint: Date = .distantPast
    private var minting = false
    /// Bumped by every mint; a completion from an older one is ignored.
    private var mintGeneration = 0

    /// The dictionary to send for a given sign-in state. Pure, for tests.
    nonisolated static func payload(hubBase: String?, token: String) -> [String: String] {
        guard !token.isEmpty, let hubBase, !hubBase.isEmpty else { return ["token": ""] }
        return ["hub": hubBase, "token": token]
    }

    /// SHA-256 of the phone session the watch token was minted for, so another
    /// account on the same hub never inherits it.
    nonisolated static func fingerprint(_ phoneToken: String) -> String {
        SHA256.hash(data: Data(phoneToken.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    nonisolated static func record(hub: String, watchToken: String, phoneToken: String, at: Date = Date()) -> String {
        "\(hub)\n\(watchToken)\n\(Int(at.timeIntervalSince1970))\n\(fingerprint(phoneToken))"
    }

    /// (hub, watch token) of a stored record, whatever its age: what a revoke needs.
    nonisolated static func parse(_ cached: String?) -> (hub: String, token: String)? {
        guard let cached else { return nil }
        let parts = cached.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return (parts[0], parts[1])
    }

    /// End a watch session on the hub (`POST /api/logout` with it as the bearer
    /// deletes the row by hash, scoped or not). Best effort.
    @discardableResult
    nonisolated static func revoke(record: String?) async -> Bool {
        guard let r = parse(record) else { return false }
        return await MainActor.run { CentralClient.revoke(session: r.token, at: r.hub) }.value
    }

    /// Fire-and-forget revoke.
    nonisolated static func revokeLater(_ record: String?) {
        guard record != nil else { return }
        Task { await revoke(record: record) }
    }

    /// Removes the cached record from the keychain and returns it for revoking.
    nonisolated static func takeCached() -> String? {
        let cached = KeychainStore.load(account: account)
        KeychainStore.delete(account: account)
        return cached
    }

    /// Whether a cached record belongs to this hub and phone session, whatever its
    /// age. nil = nothing cached.
    nonisolated static func sameOwner(cached: String?, hub: String, phoneToken: String) -> Bool? {
        guard let cached else { return nil }
        let parts = cached.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        return parts.count == 4 && parts[0] == hub && parts[3] == fingerprint(phoneToken)
    }

    /// Cached watch token worth reusing: same hub AND same phone session,
    /// minted less than `maxAge` ago.
    nonisolated static func reusable(cached: String?, hub: String, phoneToken: String, now: Date = Date()) -> String? {
        guard let cached else { return nil }
        let parts = cached.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[0] == hub, !parts[1].isEmpty, parts[3] == fingerprint(phoneToken),
              let at = TimeInterval(parts[2]), now.timeIntervalSince1970 - at < maxAge,
              at <= now.timeIntervalSince1970 + 60 else { return nil }
        return parts[1]
    }

    /// Call whenever the phone's hub or session changes (empty `token` = signed out).
    func sync(hubBase: String?, token: String) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.delegate == nil { session.delegate = self }
        self.hubBase = hubBase
        phoneToken = token
        guard !token.isEmpty, let hubBase, !hubBase.isEmpty else {
            Self.revokeLater(Self.takeCached())
            context = ["token": ""]
            activateAndPush()
            return
        }
        let stored = KeychainStore.load(account: Self.account)
        if let cached = Self.reusable(cached: stored, hub: hubBase, phoneToken: token) {
            context = Self.payload(hubBase: hubBase, token: cached)
            activateAndPush()
            return
        }
        // Other account, other hub or expired: the old watch session must not live on.
        // For another account or hub the watch drops its credential NOW, before the
        // revoke or the mint can fail: it must never keep acting as the old account.
        if Self.sameOwner(cached: stored, hub: hubBase, phoneToken: token) == false {
            context = ["token": ""]
            activateAndPush()
        }
        Self.revokeLater(Self.takeCached())
        mint(force: true)
    }

    private func activateAndPush() {
        let session = WCSession.default
        if session.activationState != .activated { session.activate(); return }
        push()
    }

    private func mint(force: Bool) {
        // A forced mint (new account/hub) supersedes one in flight; an opportunistic
        // one waits for it.
        guard force || !minting, !phoneToken.isEmpty, let hubBase, let base = URL(string: hubBase) else { return }
        if !force, Date().timeIntervalSince(lastMint) < Self.minRemintGap { return }
        minting = true
        lastMint = Date()
        mintGeneration += 1
        let generation = mintGeneration
        let phone = phoneToken
        Task { [weak self] in
            let (minted, forbidden) = await Self.requestMint(base: base, phone: phone)
            self?.minted(token: minted, forbidden: forbidden, phone: phone, hub: hubBase, generation: generation)
        }
    }

    /// The network half of a mint; returns (token, forbidden).
    private nonisolated static func requestMint(base: URL, phone: String) async -> (String?, Bool) {
        var request = URLRequest(url: base.appendingPathComponent("api/watch/session"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(phone)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        struct Reply: Decodable { let token: String? }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return (nil, false) }
        if http.statusCode == 403 { return (nil, true) }
        if (200..<300).contains(http.statusCode) {
            return ((try? JSONDecoder().decode(Reply.self, from: data))?.token, false)
        }
        return (nil, false)
    }

    private func minted(token: String?, forbidden: Bool, phone: String, hub: String, generation: Int) {
        // A newer mint owns the state now; this answer belongs to an older request.
        guard generation == mintGeneration else {
            if let token, !token.isEmpty { Self.revokeLater(Self.record(hub: hub, watchToken: token, phoneToken: phone)) }
            return
        }
        minting = false
        // The user signed out or switched while the request was in flight.
        guard phone == phoneToken, hub == hubBase else { return }
        if forbidden {
            Self.revokeLater(Self.takeCached())
            context = ["token": ""]
        } else if let token, !token.isEmpty {
            let old = KeychainStore.load(account: Self.account)
            KeychainStore.save(Self.record(hub: hub, watchToken: token, phoneToken: phone), account: Self.account)
            if Self.parse(old)?.token != token { Self.revokeLater(old) }
            context = Self.payload(hubBase: hub, token: token)
        } else {
            return // network failure: keep what the watch has, retry on the next sync
        }
        activateAndPush()
    }

    private func push() {
        let session = WCSession.default
        guard session.isPaired, session.isWatchAppInstalled, !context.isEmpty else { return }
        try? session.updateApplicationContext(context)
    }

    private func watchAsksForToken() { mint(force: false) }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        guard activationState == .activated else { return }
        Task { @MainActor in self.push() }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard userInfo["needToken"] as? Bool == true else { return }
        Task { @MainActor in self.watchAsksForToken() }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard message["needToken"] as? Bool == true else { return }
        Task { @MainActor in self.watchAsksForToken() }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in self.push() }
    }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
