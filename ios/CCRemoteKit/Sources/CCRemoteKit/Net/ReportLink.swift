import Foundation

/// A link to a published report (`https://code.acme.test/w/reports/<id>`) that
/// the app opens itself instead of handing it to Safari.
///
/// Only links to the hub the app is signed in to qualify: the report is fetched
/// from the CONFIGURED hub with the app's own session, never from whatever host
/// the link names, so a look-alike host can neither receive the token nor be
/// rendered as if it were ours. `code.acme.test` and `claude.acme.test` are one
/// hub under two names (both serve everything), so either one matches the other.
public struct ReportLink: Hashable, Identifiable, Sendable {
    public let id: String
    /// The page on the web, for «Поделиться» and «Открыть в браузере».
    public let webURL: URL

    static let aliases: Set<String> = ["code.acme.test", "claude.acme.test"]

    public init?(_ url: URL, hubURL: String) {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host?.lowercased(),
              let hub = HegaiAuth.apiBase(hubURL: hubURL)?.host?.lowercased(),
              host == hub || (Self.aliases.contains(host) && Self.aliases.contains(hub))
        else { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count == 3, parts[0] == "w", parts[1] == "reports" else { return nil }
        let id = String(parts[2]).lowercased()
        guard id.count == 32, id.allSatisfy({ $0.isHexDigit }) else { return nil }
        self.id = id
        self.webURL = url
    }

    public var metaPath: String { "api/reports/\(id)" }
    public var contentPath: String { "api/reports/\(id)/content" }

    /// The hub's `REPORT_CSP` (server-rs/src/reports.rs) minus what a `<meta>`
    /// cannot carry (`sandbox`, `frame-ancestors`). The web view loads the page
    /// from a string with no origin and no cookies, so the meta tag is what keeps
    /// a report from reaching the network the way the iframe's header does.
    static let csp = "default-src 'none'; "
        + "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; "
        + "style-src 'unsafe-inline' https://fonts.googleapis.com; "
        + "font-src https://fonts.gstatic.com data:; "
        + "img-src data: blob:; media-src data: blob:; connect-src 'none'; "
        + "base-uri 'none'; form-action 'none'"

    /// The report's HTML with the policy as its very first node — right after
    /// the doctype, or at the very start without one. Not after the first
    /// `<head>` in the text: that can sit in a comment, or after a script the
    /// parser runs before ever reaching it. The parser opens `<html><head>`
    /// for the tag itself, and a later `<html lang>` merges its attributes in.
    public static func hardened(_ html: String) -> String {
        let tag = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(csp)\">"
        let lead = html.drop(while: { $0.isWhitespace || $0 == "\u{FEFF}" })
        if lead.prefix(9).lowercased() == "<!doctype",
           let close = html.range(of: ">", range: lead.startIndex..<html.endIndex) {
            var out = html
            out.insert(contentsOf: tag, at: close.upperBound)
            return out
        }
        return tag + html
    }
}
