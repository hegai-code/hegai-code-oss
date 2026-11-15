import CryptoKit
import XCTest
@testable import HegaiSignerCore

/// Software P256 key standing in for the Secure Enclave.
final class SoftProvider: SecureKeyProvider {
    var key: P256.KeyAgreement.PrivateKey?
    func create() throws -> (publicKey: P256.KeyAgreement.PublicKey, blob: Data) {
        let k = P256.KeyAgreement.PrivateKey()
        key = k
        return (k.publicKey, k.rawRepresentation)
    }
    func load(blob: Data, reason: String) throws -> KeyAgreementKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: blob)
    }
}

final class CoreTests: XCTestCase {
    func hex(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let j = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<j], radix: 16)!); i = j }
        return d
    }

    func testManifestBytes() {
        let m = Format.manifest(version: "0.3.3", sha256: String(repeating: "ab", count: 32))
        XCTAssertEqual(String(decoding: m, as: UTF8.self),
                       "hegai-code-agent-release/1\nedition=external\nversion=0.3.3\nsha256=\(String(repeating: "ab", count: 32))\n")
    }

    // RFC 8032 test 1
    func testSPKIVector() throws {
        let raw = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        let line = "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
        XCTAssertEqual(Format.spkiLine(rawPublicKey: raw), line)
        XCTAssertEqual(Format.rawPublicKey(fromSPKILine: line + "\n"), raw)
        XCTAssertNil(Format.rawPublicKey(fromSPKILine: "AAAA"))
        let seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        let k = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(k.publicKey.rawRepresentation, raw)
        // CryptoKit signatures are randomized, so check the RFC signature verifies instead of comparing bytes.
        let rfcSig = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
        XCTAssertTrue(k.publicKey.isValidSignature(rfcSig, for: Data()))
    }

    func testWrapUnwrap() throws {
        let se = P256.KeyAgreement.PrivateKey()
        let seed = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let w = try KeyWrap.wrap(seed: seed, to: se.publicKey)
        XCTAssertEqual(try KeyWrap.unwrap(w, with: se), seed)
        XCTAssertThrowsError(try KeyWrap.unwrap(w, with: P256.KeyAgreement.PrivateKey()))
        var t = w; t.salt = Data(repeating: 1, count: 32).base64EncodedString()
        XCTAssertThrowsError(try KeyWrap.unwrap(t, with: se))
    }

    func tmpDir() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("hs-\(UUID().uuidString)") }

    func testVaultCreateSignRefuseOverwriteBackup() throws {
        let dir = tmpDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let v = KeyVault(dir: dir, provider: SoftProvider())
        XCTAssertFalse(v.hasKey)
        XCTAssertThrowsError(try v.sign(manifest: Data(), reason: "x"))
        let line = try v.createKey()
        XCTAssertTrue(v.hasKey)
        XCTAssertEqual(try v.publicKeyLine(), line)
        XCTAssertThrowsError(try v.createKey()) { XCTAssertEqual($0 as? SignerError, .keyExists) }
        let attrs = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent("wrapped.json").path)
        XCTAssertEqual(attrs[.posixPermissions] as? Int, 0o600)
        let m = Format.manifest(version: "1.0.0", sha256: String(repeating: "0", count: 64))
        let sig = try v.sign(manifest: m, reason: "x")
        XCTAssertEqual(sig.count, 64)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Format.rawPublicKey(fromSPKILine: line)!)
        XCTAssertTrue(pub.isValidSignature(sig, for: m))
        let backup = try v.backupAndRemove()
        XCTAssertFalse(v.hasKey)
        XCTAssertTrue(FileManager.default.fileExists(atPath: backup.appendingPathComponent("pubkey.txt").path))
        XCTAssertNotEqual(try v.createKey(), line)
    }

    func bundle(_ ed: String, _ ver: String?) -> Data {
        var s = "var x=1;\nvar e = \"HEGAI_AGENT_EDITION=\(ed)\";\n"
        if let ver { s += "var AGENT_VERSION = true ? \"\(ver)\" : \"dev\";\n" }
        return Data(s.utf8)
    }

    func testBundleChecks() throws {
        let b = bundle("external", "0.3.3")
        let sha = Format.sha256Hex(b)
        XCTAssertEqual(BundleChecks.edition(b), "external")
        XCTAssertEqual(BundleChecks.version(b), "0.3.3")
        XCTAssertEqual(try BundleChecks.verify(bytes: b, expectedSha256: sha, expectedVersion: "0.3.3"),
                       Format.manifest(version: "0.3.3", sha256: sha))
        XCTAssertThrowsError(try BundleChecks.verify(bytes: b, expectedSha256: String(repeating: "0", count: 64), expectedVersion: "0.3.3"))
        XCTAssertThrowsError(try BundleChecks.verify(bytes: b, expectedSha256: sha, expectedVersion: "0.3.4"))
        let i = bundle("internal", "0.3.3")
        XCTAssertThrowsError(try BundleChecks.verify(bytes: i, expectedSha256: Format.sha256Hex(i), expectedVersion: "0.3.3"))
        let both = Data((String(decoding: b, as: UTF8.self) + "\"HEGAI_AGENT_EDITION=internal\"").utf8)
        XCTAssertNil(BundleChecks.edition(both))
        let nov = bundle("external", nil)
        XCTAssertThrowsError(try BundleChecks.verify(bytes: nov, expectedSha256: Format.sha256Hex(nov), expectedVersion: "1"))
    }

    func testVersionRegex() {
        XCTAssertEqual(BundleChecks.version(Data("AGENT_VERSION = true ? \"1.2.3-rc.1+b5\" :".utf8)), "1.2.3-rc.1+b5")
        XCTAssertNil(BundleChecks.version(Data("AGENT_VERSION = true ? \"bad version\" :".utf8)))
        XCTAssertNil(BundleChecks.version(Data("AGENT_VERSION = true ? \"\" :".utf8)))
        XCTAssertTrue(Format.isValidVersion("0.3.3"))
        XCTAssertFalse(Format.isValidVersion("0.3.3\n"))
        XCTAssertFalse(Format.isValidVersion(String(repeating: "a", count: 65)))
    }

    func testURLAndGrouping() throws {
        XCTAssertNoThrow(try HubClient.checkedBundleURL("https://code.acme.test/dl/external/0.3.3/agent-external.mjs"))
        for bad in ["http://code.acme.test/x", "https://evil.net/x", "https://code.acme.test.evil.net/x", "https://u@code.acme.test/x", "ftp://code.acme.test/x"] {
            XCTAssertThrowsError(try HubClient.checkedBundleURL(bad), bad)
        }
        XCTAssertEqual(Format.grouped("0123456789abcdef"), "01234567 89abcdef")
    }

    func testIncompleteKeyRefused() throws {
        let dir = tmpDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let v = KeyVault(dir: dir, provider: SoftProvider())
        try v.createKey()
        try FileManager.default.removeItem(at: dir.appendingPathComponent("wrapped.json"))
        XCTAssertFalse(v.hasKey)
        XCTAssertTrue(v.anyKeyFiles)
        XCTAssertThrowsError(try v.createKey()) { XCTAssertEqual($0 as? SignerError, .keyIncomplete) }
        _ = try v.backupAndRemove()
        XCTAssertFalse(v.anyKeyFiles)
        XCTAssertNoThrow(try v.createKey())
        let left = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix(".new-") }
        XCTAssertEqual(left, [])
    }

    func testPendingOptionalFields() throws {
        let sha = String(repeating: "a", count: 64)
        let j = Data("{\"version\":\"0.3.3\",\"sha256\":\"\(sha)\",\"signed\":false}".utf8)
        let p = try JSONDecoder().decode(PendingRelease.self, from: j)
        XCTAssertNoThrow(try p.validate())
        XCTAssertEqual(p.bundleURL, "https://code.acme.test/dl/external/0.3.3/agent-external.mjs")
        XCTAssertEqual(p.shortCommit, "—")
        var q = p; q.url = "https://evil.net/x"
        XCTAssertThrowsError(try q.validate())
    }
}
