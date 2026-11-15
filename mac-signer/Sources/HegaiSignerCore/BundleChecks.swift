import Foundation

public enum BundleChecks {
    /// "external" / "internal" / nil when neither or both markers are present.
    public static func edition(_ bytes: Data) -> String? {
        let text = String(data: bytes, encoding: .isoLatin1) ?? ""
        let ext = text.contains("\"HEGAI_AGENT_EDITION=external\"")
        let int = text.contains("\"HEGAI_AGENT_EDITION=internal\"")
        return ext == int ? nil : (ext ? "external" : "internal")
    }

    /// The version compiled into the bundle by deploy/build-agent.sh.
    public static func version(_ bytes: Data) -> String? {
        let text = String(data: bytes, encoding: .isoLatin1) ?? ""
        guard let re = try? NSRegularExpression(pattern: "AGENT_VERSION = true \\? \"(\(Format.versionPattern))\""),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }

    /// Same checks as offline-sign.mjs; returns the manifest to sign.
    public static func verify(bytes: Data, expectedSha256: String, expectedVersion: String) throws -> Data {
        let sha = Format.sha256Hex(bytes)
        guard sha == expectedSha256 else { throw SignerError.shaMismatch(expected: expectedSha256, actual: sha) }
        let ed = edition(bytes)
        guard ed == "external" else { throw SignerError.notExternal(ed ?? "unknown") }
        guard let v = version(bytes) else { throw SignerError.noVersion }
        guard v == expectedVersion else { throw SignerError.versionMismatch(expected: expectedVersion, actual: v) }
        return Format.manifest(version: v, sha256: sha)
    }
}
