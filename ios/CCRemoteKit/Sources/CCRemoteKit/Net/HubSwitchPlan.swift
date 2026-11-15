import Foundation

/// What «Подключиться» in Settings → «Другой хаб / токен» will do, decided
/// before anything is written. A pure value so the ordering rules are testable:
/// the bearer belongs to the hub that issued it, so a hub change must drop the
/// old session BEFORE the new address is stored.
public struct HubSwitchPlan: Equatable, Sendable {
    /// The hub address to persist (trimmed, `ws`/`wss`, with a host).
    public let hub: String
    /// The token to persist AFTER the hub; empty = stay signed out and use the
    /// normal sign-in button next.
    public let token: String
    /// The address names another server than the one stored now.
    public let switching: Bool

    public nonisolated init(hub: String, token: String, switching: Bool) {
        self.hub = hub
        self.token = token
        self.switching = switching
    }

    /// Shown under the field when the address cannot be used (same text as Android).
    public nonisolated static let invalidHubMessage = "Введите адрес вида https://hub.example.com"

    /// Turns what a person typed (`hub.acme.io`, `https://hub.acme.io/`,
    /// `wss://hub.acme.io/mobile/ui`) into the canonical `wss://host[:port]/mobile/ui`,
    /// or nil. Plain `http`/`ws` is accepted only for loopback hosts; credentials,
    /// queries, fragments and any other path are refused: the bearer travels there.
    public nonisolated static func normalizedHub(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 253, !text.contains(where: { $0.isWhitespace }) else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard let comps = URLComponents(string: text),
              let scheme = comps.scheme?.lowercased(),
              var host = comps.host?.lowercased(), !host.isEmpty else { return nil }
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty else { return nil }
        guard comps.user == nil, comps.password == nil, comps.query == nil, comps.fragment == nil,
              ["", "/", "/mobile/ui", "/mobile/ui/"].contains(comps.path) else { return nil }
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
        let secure: Bool
        switch scheme {
        case "https", "wss": secure = true
        case "http", "ws": guard loopback else { return nil }; secure = false
        default: return nil
        }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        var authority = shownHost
        if let port = comps.port {
            guard (1...65535).contains(port) else { return nil }
            if port != (secure ? 443 : 80) { authority += ":\(port)" }
        }
        return (secure ? "wss://" : "ws://") + authority + "/mobile/ui"
    }

    /// `/health` of one of our hubs answers `{"ok":true}`.
    public nonisolated static func isHealthy(_ body: Data) -> Bool {
        guard body.count <= 4096,
              let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let ok = obj["ok"] as? Bool else { return false }
        return ok
    }

    /// `host` or `host:port` of a canonical hub address, for messages.
    public nonisolated static func label(_ hub: String) -> String {
        URLComponents(string: hub).map { c in (c.host ?? hub) + (c.port.map { ":\($0)" } ?? "") } ?? hub
    }

    /// `nil` when the hub address is not usable. A token is NOT required: a
    /// signed-out or fresh install saves a customer hub with no token and signs
    /// in on it afterwards. A token equal to the one stored now is inherited
    /// from the old hub and is dropped when the hub changes; a different one is
    /// the person's own for the new hub and is kept.
    public nonisolated static func make(currentHub: String, currentToken: String,
                                        draftHub: String, draftToken: String) -> HubSwitchPlan? {
        guard let hub = normalizedHub(draftHub) else { return nil }
        let switching = !HegaiAuth.sameHub(currentHub, hub)
        var token = draftToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if switching, token == currentToken { token = "" }
        return HubSwitchPlan(hub: hub, token: token, switching: switching)
    }
}
