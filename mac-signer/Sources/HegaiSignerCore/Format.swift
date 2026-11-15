import CryptoKit
import Foundation

public enum Format {
    public static let magic = "hegai-code-agent-release/1"
    public static let versionPattern = "[0-9A-Za-z._+-]{1,64}"
    public static let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

    /// Exactly the bytes deploy/release-signer/release-format.mjs signs.
    public static func manifest(version: String, sha256: String) -> Data {
        Data("\(magic)\nedition=external\nversion=\(version)\nsha256=\(sha256)\n".utf8)
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Line format of deploy/release-keys.txt: base64 of the SPKI DER of an Ed25519 key.
    public static func spkiLine(rawPublicKey raw: Data) -> String {
        (spkiPrefix + raw).base64EncodedString()
    }

    public static func rawPublicKey(fromSPKILine line: String) -> Data? {
        guard let der = Data(base64Encoded: line.trimmingCharacters(in: .whitespacesAndNewlines)),
              der.count == spkiPrefix.count + 32, der.prefix(spkiPrefix.count) == spkiPrefix else { return nil }
        return der.suffix(32)
    }

    public static func isValidVersion(_ v: String) -> Bool {
        v != "." && v != ".." && v.range(of: "^\(versionPattern)\\z", options: .regularExpression) != nil
    }

    public static func isHex64(_ s: String) -> Bool {
        s.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil
    }

    /// sha256 in groups of 8 for reading aloud / comparing.
    public static func grouped(_ hex: String) -> String {
        stride(from: 0, to: hex.count, by: 8).map { i -> String in
            let s = hex.index(hex.startIndex, offsetBy: i)
            let e = hex.index(s, offsetBy: min(8, hex.count - i))
            return String(hex[s..<e])
        }.joined(separator: " ")
    }
}
