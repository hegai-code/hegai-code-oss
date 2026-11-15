import CryptoKit
import Foundation

/// Where the ring keeps its one JSON blob. The Keychain in the app; memory in tests.
public enum E2eeStorageRead: Equatable, Sendable {
    case value(String)
    /// Nothing stored yet.
    case empty
    /// Could not be read (a locked Keychain): NOT the same as empty.
    case failed
}

public protocol E2eeKeyStorage: Sendable {
    func load() -> E2eeStorageRead
    /// False when the blob could not be written (the key is then NOT paired).
    func save(_ json: String) -> Bool
}

/// The Keychain item `e2ee-keyring`: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
/// never synchronised. One item for the whole ring so a crash cannot leave it half written.
public struct KeychainE2eeStorage: E2eeKeyStorage {
    static let account = "e2ee-keyring"
    public init() {}
    public func load() -> E2eeStorageRead {
        switch KeychainStore.read(account: Self.account) {
        case .value(let s): return .value(s)
        case .notFound: return .empty
        case .failed: return .failed
        }
    }
    public func save(_ json: String) -> Bool { KeychainStore.saveThisDeviceOnly(json, account: Self.account) }
}

public final class InMemoryE2eeStorage: E2eeKeyStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    public init(_ value: String? = nil) { self.value = value }
    public func load() -> E2eeStorageRead { lock.lock(); defer { lock.unlock() }; return value.map { .value($0) } ?? .empty }
    /// For tests: what is stored now.
    public var stored: String? { lock.lock(); defer { lock.unlock() }; return value }
    public func save(_ json: String) -> Bool { lock.lock(); defer { lock.unlock() }; value = json; return true }
}

/// An immutable reading of the ring: what the off-main opener works from.
public struct E2eeKeys: Sendable {
    public struct Entry: Sendable {
        public let kid: String
        public let machineId: String
        public let key: SymmetricKey
        public let addedAt: Double
    }
    var byKid: [String: Entry] = [:]

    public var isEmpty: Bool { byKid.isEmpty }
    /// The key a ciphertext with this `kid` needs, if this device holds it.
    public func forKid(_ kid: String) -> Entry? { byKid[kid] }
    /// The newest key paired with this machine: the one to seal with.
    public func latest(for machineId: String) -> Entry? {
        byKid.values.filter { $0.machineId == machineId }.max { $0.addedAt < $1.addedAt }
    }
    public func hasKey(for machineId: String) -> Bool { latest(for: machineId) != nil }
}

/// This phone's keys for private machines, by key id. The pairing code IS the
/// key: it is parsed, stored and not kept as text.
public final class E2eeKeyRing: @unchecked Sendable {
    public enum PairingError: LocalizedError, Equatable {
        case notACode, otherMachine, badKey, storage
        public var errorDescription: String? {
            switch self {
            case .notACode: return "Это не код пары: он начинается с hcp1. и печатается командой --pair на машине."
            case .otherMachine: return "Код от другой машины."
            case .badKey: return "Ключ повреждён: неверная длина."
            case .storage: return "Не удалось сохранить ключ в Keychain этого телефона."
            }
        }
    }

    private struct Stored: Codable { var kid: String; var machineId: String; var key: String; var addedAt: Double }

    private let storage: E2eeKeyStorage
    private let lock = NSLock()
    private var keys = E2eeKeys()
    /// Rows this build could not read, kept so a write never drops another
    /// machine's key; and a blob that did not parse at all, which blocks writes.
    private var unreadable: [Stored] = []
    private var blobUnreadable = false
    private var lastReload = Date.distantPast

    public init(storage: E2eeKeyStorage = KeychainE2eeStorage()) {
        self.storage = storage
        load()
    }

    /// Read the stored ring. Any outcome but a clean read or a clean "nothing
    /// there" leaves `blobUnreadable` set, and a write then refuses.
    private func load() {
        lastReload = Date()
        switch storage.load() {
        case .empty:
            blobUnreadable = false
        case .failed:
            blobUnreadable = true
        case .value(let json):
            guard let data = json.data(using: .utf8), let list = try? JSONDecoder().decode([Stored].self, from: data) else {
                blobUnreadable = true
                return
            }
            blobUnreadable = false
            unreadable = []
            var next = E2eeKeys()
            for e in list {
                guard let raw = Data(base64Encoded: e.key), raw.count == 32 else { unreadable.append(e); continue }
                next.byKid[e.kid] = .init(kid: e.kid, machineId: e.machineId, key: SymmetricKey(data: raw), addedAt: e.addedAt)
            }
            keys = next
        }
    }

    /// Read the stored ring again now (the Keychain may have become available).
    func reload() { lock.lock(); defer { lock.unlock() }; load() }

    /// The stored ring could not be read (a locked Keychain): which machines hold keys is unknown.
    public var isUnreadable: Bool { lock.lock(); defer { lock.unlock() }; return blobUnreadable }

    /// A consistent reading, safe to carry to another thread. A ring that could
    /// not be read (the Keychain is locked until first unlock) is read again, at
    /// most every two seconds, so the shared ring picks its keys up once the
    /// Keychain is available.
    public var snapshot: E2eeKeys {
        lock.lock(); defer { lock.unlock() }
        if blobUnreadable, Date().timeIntervalSince(lastReload) > 2 { load() }
        return keys
    }

    private func persist(_ list: [Stored], erasing: Bool = false) -> Bool {
        // A ring that could not be read is never overwritten by a partial one.
        if blobUnreadable && !erasing { return false }
        let list = list + unreadable
        guard let data = try? JSONEncoder().encode(list), let json = String(data: data, encoding: .utf8) else { return false }
        return storage.save(json)
    }

    /// Pair this phone with a private machine from the code it printed.
    /// `expectMachineId` (the machine the person is looking at) refuses a code for
    /// another machine, so a wrong scan cannot silently pair the wrong one.
    @discardableResult
    public func add(code: String, expectMachineId: String? = nil, now: Date = Date()) throws -> (machineId: String, kid: String) {
        guard let parsed = E2ee.parsePairingCode(code) else { throw PairingError.notACode }
        lock.lock(); if blobUnreadable { load() }; lock.unlock()
        if let expect = expectMachineId, !expect.isEmpty, parsed.machineId != expect { throw PairingError.otherMachine }
        guard let raw = E2eeCipher.bytes(fromBase64URL: parsed.key), raw.count == 32 else { throw PairingError.badKey }
        let kid = E2eeCipher.keyId(of: raw)
        lock.lock(); defer { lock.unlock() }
        var next = keys
        next.byKid[kid] = .init(kid: kid, machineId: parsed.machineId, key: SymmetricKey(data: raw),
                                addedAt: now.timeIntervalSince1970 * 1000)
        guard persist(Self.stored(next)) else { throw PairingError.storage }
        keys = next
        return (parsed.machineId, kid)
    }

    /// Forget every key of a machine: this phone can no longer read it.
    @discardableResult
    public func forget(machineId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if blobUnreadable { load() }
        var next = keys
        next.byKid = next.byKid.filter { $0.value.machineId != machineId }
        guard persist(Self.stored(next)) else { return false }
        keys = next
        return true
    }

    /// Drop every key (account erasure).
    @discardableResult
    public func removeAll() -> Bool {
        lock.lock(); defer { lock.unlock() }
        unreadable = []
        guard persist([], erasing: true) else { return false }
        blobUnreadable = false
        keys = E2eeKeys()
        return true
    }

    private static func stored(_ k: E2eeKeys) -> [Stored] {
        k.byKid.values.map { e in
            Stored(kid: e.kid, machineId: e.machineId,
                   key: e.key.withUnsafeBytes { Data($0).base64EncodedString() }, addedAt: e.addedAt)
        }
    }
}
