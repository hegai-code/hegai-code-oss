import CryptoKit
import Foundation

/// What we need from a P256 agreement key: the Secure Enclave one in production,
/// a software one in tests.
public protocol KeyAgreementKey {
    /// Raw ECDH shared secret with the peer public key (Touch ID happens here for the Secure Enclave key).
    func agree(with peer: P256.KeyAgreement.PublicKey) throws -> Data
}
extension P256.KeyAgreement.PrivateKey: KeyAgreementKey {
    public func agree(with peer: P256.KeyAgreement.PublicKey) throws -> Data {
        try sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
    }
}

public protocol SecureKeyProvider {
    /// Creates a new key; returns its public part and the blob (an identifier) needed to load it again.
    func create() throws -> (publicKey: P256.KeyAgreement.PublicKey, blob: Data)
    func load(blob: Data, reason: String) throws -> KeyAgreementKey
}

public struct WrappedSeed: Codable, Equatable {
    public var v: Int
    public var ephPub: String  // base64 x9.63
    public var salt: String    // base64, 32 bytes
    public var box: String     // base64 AES-GCM combined (nonce|ct|tag)
}

public enum KeyWrap {
    public static let info = Data("hegai-signer/v1".utf8)

    static func derive(_ secret: Data, salt: Data) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: salt, info: info, outputByteCount: 32)
    }

    public static func wrap(seed: Data, to recipient: P256.KeyAgreement.PublicKey) throws -> WrappedSeed {
        let eph = P256.KeyAgreement.PrivateKey()
        let salt = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let key = derive(try eph.agree(with: recipient), salt: salt)
        let sealed = try AES.GCM.seal(seed, using: key, authenticating: info)
        return WrappedSeed(v: 1, ephPub: eph.publicKey.x963Representation.base64EncodedString(),
                           salt: salt.base64EncodedString(), box: sealed.combined!.base64EncodedString())
    }

    public static func unwrap(_ w: WrappedSeed, with key: KeyAgreementKey) throws -> Data {
        guard w.v == 1, let eph = Data(base64Encoded: w.ephPub), let salt = Data(base64Encoded: w.salt),
              let box = Data(base64Encoded: w.box) else { throw SignerError.keyCorrupted("wrapped.json") }
        let pub = try P256.KeyAgreement.PublicKey(x963Representation: eph)
        let sym = derive(try key.agree(with: pub), salt: salt)
        return try AES.GCM.open(try AES.GCM.SealedBox(combined: box), using: sym, authenticating: info)
    }
}
