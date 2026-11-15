import CryptoKit
import Foundation

/// Ed25519 release key whose seed is wrapped to a (Secure Enclave) P256 key.
public final class KeyVault {
    public let dir: URL
    let provider: SecureKeyProvider
    var seFile: URL { dir.appendingPathComponent("se-key.bin") }
    var wrappedFile: URL { dir.appendingPathComponent("wrapped.json") }
    var pubFile: URL { dir.appendingPathComponent("pubkey.txt") }

    public init(dir: URL, provider: SecureKeyProvider) {
        self.dir = dir
        self.provider = provider
    }

    public static var defaultDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("HegaiSigner", isDirectory: true)
    }

    /// Any of the three key files exists (complete or not).
    public var anyKeyFiles: Bool {
        [seFile, wrappedFile, pubFile].contains { FileManager.default.fileExists(atPath: $0.path) }
    }

    public var hasKey: Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: wrappedFile.path) && fm.fileExists(atPath: seFile.path) && fm.fileExists(atPath: pubFile.path)
    }

    public func publicKeyLine() throws -> String {
        guard hasKey else { throw SignerError.noKey }
        guard let s = try? String(contentsOf: pubFile, encoding: .utf8),
              Format.rawPublicKey(fromSPKILine: s) != nil else { throw SignerError.keyCorrupted("pubkey.txt") }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func ensureDir() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
    }

    private func write(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Refuses if ANY key file exists. Writes into a temp dir, then renames into place.
    @discardableResult
    public func createKey() throws -> String {
        if hasKey { throw SignerError.keyExists }
        if anyKeyFiles { throw SignerError.keyIncomplete }
        try ensureDir()
        let se = try provider.create()
        let ed = Curve25519.Signing.PrivateKey()
        var seed = ed.rawRepresentation
        defer { seed.resetBytes(in: 0..<seed.count) }
        let wrapped = try KeyWrap.wrap(seed: seed, to: se.publicKey)
        let line = Format.spkiLine(rawPublicKey: ed.publicKey.rawRepresentation)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let tmp = dir.appendingPathComponent(".new-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: tmp) }
        let files: [(URL, Data)] = [(seFile, se.blob), (wrappedFile, try enc.encode(wrapped)), (pubFile, Data((line + "\n").utf8))]
        for (dest, data) in files {
            let t = tmp.appendingPathComponent(dest.lastPathComponent)
            try write(data, to: t)
        }
        var placed: [URL] = []
        do {
            for (dest, _) in files {  // pubkey.txt last: hasKey only turns true once all three are in place
                try FileManager.default.moveItem(at: tmp.appendingPathComponent(dest.lastPathComponent), to: dest)
                placed.append(dest)
            }
        } catch {
            // Undo only what THIS call placed: a concurrent create that won must keep its key.
            for dest in placed { try? FileManager.default.removeItem(at: dest) }
            throw error
        }
        return line
    }

    /// Moves the current key files to a dated backup folder (explicit rotation).
    @discardableResult
    public func backupAndRemove(now: Date = Date()) throws -> URL {
        guard anyKeyFiles else { throw SignerError.noKey }
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        f.locale = Locale(identifier: "en_US_POSIX")
        let backup = dir.appendingPathComponent("backup-\(f.string(from: now))", isDirectory: true)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        for u in [seFile, wrappedFile, pubFile] where FileManager.default.fileExists(atPath: u.path) {
            try FileManager.default.moveItem(at: u, to: backup.appendingPathComponent(u.lastPathComponent))
        }
        return backup
    }

    /// Unwraps the seed (Touch ID happens here), signs, self-verifies, drops the seed.
    public func sign(manifest: Data, reason: String) throws -> Data {
        let line = try publicKeyLine()
        guard let raw = Format.rawPublicKey(fromSPKILine: line),
              let blob = try? Data(contentsOf: seFile),
              let wj = try? Data(contentsOf: wrappedFile),
              let wrapped = try? JSONDecoder().decode(WrappedSeed.self, from: wj)
        else { throw SignerError.keyCorrupted("se-key.bin / wrapped.json") }
        let seKey = try provider.load(blob: blob, reason: reason)
        var seed = try KeyWrap.unwrap(wrapped, with: seKey)
        defer { seed.resetBytes(in: 0..<seed.count) }
        let ed = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        guard ed.publicKey.rawRepresentation == raw else { throw SignerError.keyCorrupted("публичный ключ не соответствует") }
        let sig = try ed.signature(for: manifest)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
        guard pub.isValidSignature(sig, for: manifest) else { throw SignerError.selfVerifyFailed }
        return sig
    }
}
