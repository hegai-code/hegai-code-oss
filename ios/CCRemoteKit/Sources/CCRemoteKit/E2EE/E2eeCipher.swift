import CryptoKit
import Foundation

/// Private machine (docs/E2EE.md): AES-256-GCM through CryptoKit, the key id
/// bound as AAD, the nonce 96 random bits. The same bytes the agent's Node
/// `crypto` and the web's WebCrypto make: `shared/test/e2e-vectors.json` is
/// checked on every side. Which fields are content is `E2ee` (the traversal).
public enum E2eeCipher {
    public enum CipherError: Error { case badEnvelope, badKey }

    /// First 8 bytes of SHA-256(K), hex - the key id sent in clear.
    public static func keyId(of raw: Data) -> String {
        SHA256.hash(data: raw).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// base64url without padding (as printed in the pairing code) to bytes.
    public static func bytes(fromBase64URL s: String) -> Data? {
        var std = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        std += String(repeating: "=", count: (4 - std.count % 4) % 4)
        return Data(base64Encoded: std)
    }

    static func json(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    }

    /// Seal a JSON value bound to `bind` (`machineId|dir|kind|id`). `nonce` is for test vectors only.
    public static func seal(_ value: Any, key: SymmetricKey, kid: String, bind: String,
                            nonce: Data? = nil) throws -> E2ee.Envelope {
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(try json(value), using: key, nonce: n,
                                   authenticating: Data(E2ee.aad(kid: kid, bind: bind).utf8))
        return E2ee.Envelope(kid: kid,
                             n: Data(n).base64EncodedString(),
                             c: (box.ciphertext + box.tag).base64EncodedString())
    }

    /// Open an envelope made for `bind`; throws on a wrong key, binding or tampering.
    public static func open(_ env: E2ee.Envelope, key: SymmetricKey, bind: String) throws -> Any {
        guard let nonce = Data(base64Encoded: env.n), let body = Data(base64Encoded: env.c), body.count >= 16
        else { throw CipherError.badEnvelope }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce),
                                        ciphertext: body.dropLast(16), tag: body.suffix(16))
        let plain = try AES.GCM.open(box, using: key, authenticating: Data(E2ee.aad(kid: env.kid, bind: bind).utf8))
        return try JSONSerialization.jsonObject(with: plain, options: [.fragmentsAllowed])
    }
}
