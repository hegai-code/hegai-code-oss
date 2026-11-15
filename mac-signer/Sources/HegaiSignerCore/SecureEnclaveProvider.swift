import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Secure Enclave key stored in the data-protection keychain under our team's access group,
/// so only binaries signed by our team with the matching entitlement can use it.
/// Access: Touch ID of the currently enrolled fingerprints only (no password fallback).
public struct SecureEnclaveProvider: SecureKeyProvider {
    public static let teamID = "AZWU5VAA73"
    public static let accessGroup = "AZWU5VAA73.net.hegai.signer"
    let flags: SecAccessControlCreateFlags
    let accessible: CFString
    /// Production: Touch ID of the current enrollment only. The self-test uses `.privateKeyUsage` alone
    /// and AfterFirstUnlock (the headless build mini has no Touch ID and refuses WhenUnlocked keys, -25308).
    public init(flags: SecAccessControlCreateFlags = [.privateKeyUsage, .biometryCurrentSet],
                accessible: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly) {
        self.flags = flags
        self.accessible = accessible
    }

    private static func err(_ what: String, _ status: OSStatus) -> SignerError {
        let msg = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus"
        return .keychain("\(what): \(msg) (\(status))")
    }

    private static func cfErr(_ what: String, _ e: Unmanaged<CFError>?) -> SignerError {
        .keychain("\(what): \(e.map { ($0.takeRetainedValue() as Error).localizedDescription } ?? "?")")
    }

    private static func publicKey(of priv: SecKey) throws -> P256.KeyAgreement.PublicKey {
        guard let pub = SecKeyCopyPublicKey(priv) else { throw SignerError.keychain("нет публичной части") }
        var e: Unmanaged<CFError>?
        guard let raw = SecKeyCopyExternalRepresentation(pub, &e) as Data? else { throw cfErr("export", e) }
        return try P256.KeyAgreement.PublicKey(x963Representation: raw)
    }

    public func create() throws -> (publicKey: P256.KeyAgreement.PublicKey, blob: Data) {
        guard SecureEnclave.isAvailable else { throw SignerError.noSecureEnclave }
        var e: Unmanaged<CFError>?
        guard let ac = SecAccessControlCreateWithFlags(
            nil, accessible, flags, &e)
        else { throw Self.cfErr("access control", e) }
        let tag = "net.hegai.signer.key.\(UUID().uuidString)"
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain as String: true,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: Data(tag.utf8),
                kSecAttrAccessControl as String: ac,
                kSecAttrAccessGroup as String: Self.accessGroup,
            ] as [String: Any],
        ]
        guard let priv = SecKeyCreateRandomKey(attrs as CFDictionary, &e) else { throw Self.cfErr("создание ключа", e) }
        return (try Self.publicKey(of: priv), Data(tag.utf8))
    }

    private static func query(tag: Data) -> [String: Any] {
        [kSecClass as String: kSecClassKey,
         kSecAttrApplicationTag as String: tag,
         kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
         kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
         kSecAttrAccessGroup as String: accessGroup,
         kSecUseDataProtectionKeychain as String: true]
    }

    /// Removes a key created by `create` (used by the self-test).
    public func delete(blob: Data) {
        SecItemDelete(Self.query(tag: blob) as CFDictionary)
    }

    public func load(blob: Data, reason: String) throws -> KeyAgreementKey {
        let ctx = LAContext()
        ctx.localizedReason = reason
        var q = Self.query(tag: blob)
        q[kSecReturnRef as String] = true
        q[kSecUseAuthenticationContext as String] = ctx
        var item: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &item)
        guard st == errSecSuccess, let item else {
            throw st == errSecItemNotFound
                ? SignerError.keychain("ключ не найден (отпечатки менялись или ключ удалён) — нужен новый ключ")
                : Self.err("загрузка ключа", st)
        }
        return SEKey(key: item as! SecKey)
    }

    struct SEKey: KeyAgreementKey {
        let key: SecKey
        func agree(with peer: P256.KeyAgreement.PublicKey) throws -> Data {
            var e: Unmanaged<CFError>?
            let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                                        kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
                                        kSecAttrKeySizeInBits as String: 256]
            guard let pub = SecKeyCreateWithData(peer.x963Representation as CFData, attrs as CFDictionary, &e)
            else { throw SecureEnclaveProvider.cfErr("peer key", e) }
            guard let out = SecKeyCopyKeyExchangeResult(key, .ecdhKeyExchangeStandard, pub, [:] as CFDictionary, &e) as Data?
            else { throw SecureEnclaveProvider.cfErr("ECDH (Touch ID)", e) }
            return out
        }
    }
}
