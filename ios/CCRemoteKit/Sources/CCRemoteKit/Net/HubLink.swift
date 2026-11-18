import Foundation

/// A «server code»: what a QR code, a pasted line or a `ccremote://connect` link
/// may carry to point the app at a self-hosted hub. Pure parsing — the app never
/// switches on it directly: it only PROPOSES a server, and the person confirms.
public enum HubLink {
    /// `ccremote://connect?hub=<percent-encoded https origin>`, `https://host[:port]/app[/]`
    /// (what the hub's `/app/qr.svg` encodes), `https://host`, a bare `host`, or the
    /// legacy `wss://host/mobile/ui` → the canonical hub address
    /// (`HubSwitchPlan.normalizedHub`), or nil. Any other scheme (`javascript:`,
    /// `file:` …), plain http for a non-loopback host, credentials, a query or
    /// another path → nil.
    public nonisolated static func parse(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 2048, !t.contains(where: { $0.isWhitespace }) else { return nil }
        if t.lowercased().hasPrefix("ccremote:") {
            guard let c = URLComponents(string: t), c.scheme?.lowercased() == "ccremote",
                  c.host?.lowercased() == "connect",
                  let hub = c.queryItems?.first(where: { $0.name == "hub" })?.value,
                  !hub.lowercased().hasPrefix("ccremote:") else { return nil }
            return address(hub)
        }
        return address(t)
    }

    /// `ccremote://connect?hub=https%3A%2F%2Fcode.acme.com` for a canonical hub address.
    public nonisolated static func connectURL(hub: String) -> URL? {
        guard let origin = HegaiAuth.apiBase(hubURL: hub)?.absoluteString else { return nil }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let encoded = origin.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "ccremote://connect?hub=" + encoded)
    }

    private nonisolated static func address(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") {
            // `javascript:alert(1)`, `mailto:a@b` — a scheme with no `//` is not a
            // host. Only `host:port` (digits after the colon) may carry a colon.
            if let colon = text.firstIndex(of: ":"), !text.hasPrefix("[") {
                let rest = text[text.index(after: colon)...]
                guard let first = rest.first, first.isNumber else { return nil }
            }
            text = "https://" + text
        }
        guard var comps = URLComponents(string: text) else { return nil }
        // The hub's own QR points at its web app page.
        if comps.path == "/app" || comps.path == "/app/" { comps.path = "" }
        guard let cleaned = comps.string else { return nil }
        return HubSwitchPlan.normalizedHub(cleaned)
    }
}
