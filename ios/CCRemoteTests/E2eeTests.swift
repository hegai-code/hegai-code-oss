import CryptoKit
import XCTest
@testable import CCRemoteKit

/// The cipher against `shared/test/e2e-vectors.json` - the same bytes the agent
/// (Node crypto) and the web (WebCrypto) produce and open - plus the rest of the
/// phone's side: the key ring, what is opened on the way in, what is sealed (or
/// refused) on the way out.
final class E2eeTests: XCTestCase {
    // MARK: Vectors

    struct Vector: Decodable {
        let keyHex: String
        let nonceHex: String
        let kid: String
        let value: [String: String]
        let envelope: Env
        let pairingCode: String
        let bind: String
        struct Env: Decodable { let e2e: Int; let kid: String; let n: String; let c: String }
    }

    /// The repository's own file when the checkout is there (it is on the Mac mini
    /// and in CI, where drift matters); the embedded copy otherwise.
    static let vector: Vector = {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/test/e2e-vectors.json")
        if let data = try? Data(contentsOf: repo), let v = try? JSONDecoder().decode(Vector.self, from: data) { return v }
        return try! JSONDecoder().decode(Vector.self, from: Data(embeddedVector.utf8))
    }()

    static let embeddedVector = #"""
    {"keyHex":"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f","nonceHex":"a0a1a2a3a4a5a6a7a8a9aaab","kid":"630dcd2966c43366","value":{"text":"привет, synthetic-marker"},"envelope":{"e2e":1,"kid":"630dcd2966c43366","n":"oKGio6Slpqeoqaqr","c":"nToISD2/IIVAtTgCh6p4DsJ87MEQm2If5WBS7hrfHGL/GyaNxEchHyKk1wzVP77y4MJMI3qfQ58G"},"pairingCode":"hcp1.m-1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","bind":"m-1|a2c|stream|run-1"}
    """#

    static func hex(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let j = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<j], radix: 16)!); i = j }
        return d
    }
    var key: SymmetricKey { SymmetricKey(data: Self.hex(Self.vector.keyHex)) }

    func testKeyIdMatchesTheVector() {
        XCTAssertEqual(E2eeCipher.keyId(of: Self.hex(Self.vector.keyHex)), Self.vector.kid)
    }

    func testPairingCodeOfTheVectorGivesTheVectorKey() throws {
        let parsed = try XCTUnwrap(E2ee.parsePairingCode(Self.vector.pairingCode))
        XCTAssertEqual(parsed.machineId, "m-1")
        XCTAssertEqual(E2eeCipher.bytes(fromBase64URL: parsed.key), Self.hex(Self.vector.keyHex))
    }

    func testSealWithTheVectorNonceProducesTheVectorEnvelope() throws {
        let v = Self.vector
        let env = try E2eeCipher.seal(v.value, key: key, kid: v.kid, bind: v.bind, nonce: Self.hex(v.nonceHex))
        XCTAssertEqual(env.kid, v.envelope.kid)
        XCTAssertEqual(env.n, v.envelope.n)
        XCTAssertEqual(env.c, v.envelope.c)
        XCTAssertEqual(env.json["e2e"] as? Int, v.envelope.e2e)
    }

    func testOpenTheVectorEnvelope() throws {
        let v = Self.vector
        let env = E2ee.Envelope(kid: v.envelope.kid, n: v.envelope.n, c: v.envelope.c)
        let opened = try E2eeCipher.open(env, key: key, bind: v.bind)
        XCTAssertEqual((opened as? [String: Any])?["text"] as? String, v.value["text"])
    }

    func testTheBindingIsPartOfTheKey() {
        let v = Self.vector
        let env = E2ee.Envelope(kid: v.envelope.kid, n: v.envelope.n, c: v.envelope.c)
        // another machine, another run, the other direction, another key id
        for bind in ["m-2|a2c|stream|run-1", "m-1|a2c|stream|run-2", "m-1|c2a|stream|run-1", "m-1|a2c|stream_x|run-1"] {
            XCTAssertThrowsError(try E2eeCipher.open(env, key: key, bind: bind), bind)
        }
        let otherKid = E2ee.Envelope(kid: "ffffffffffffffff", n: env.n, c: env.c)
        XCTAssertThrowsError(try E2eeCipher.open(otherKid, key: key, bind: v.bind))
        XCTAssertThrowsError(try E2eeCipher.open(env, key: SymmetricKey(size: .bits256), bind: v.bind))
        // a flipped byte of the ciphertext
        var raw = Data(base64Encoded: env.c)!; raw[0] ^= 1
        XCTAssertThrowsError(try E2eeCipher.open(.init(kid: env.kid, n: env.n, c: raw.base64EncodedString()), key: key, bind: v.bind))
    }

    func testRandomNonceRoundTripAndNoncesDiffer() throws {
        let a = try E2eeCipher.seal(["x": [1, 2, "я/\"\\"]], key: key, kid: "k", bind: "b")
        let b = try E2eeCipher.seal(["x": [1, 2, "я/\"\\"]], key: key, kid: "k", bind: "b")
        XCTAssertNotEqual(a.n, b.n)
        XCTAssertNotEqual(a.c, b.c)
        let back = try E2eeCipher.open(a, key: key, bind: "b") as? [String: Any]
        XCTAssertEqual((back?["x"] as? [Any])?.count, 3)
        // A bare string is a valid secret (a session title).
        let t = try E2eeCipher.seal("Заголовок", key: key, kid: "k", bind: "b")
        XCTAssertEqual(try E2eeCipher.open(t, key: key, bind: "b") as? String, "Заголовок")
    }

    // MARK: Key ring

    private func code(_ machine: String, byte: UInt8) -> (code: String, kid: String) {
        let raw = Data(repeating: byte, count: 32)
        let b64 = raw.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return ("hcp1.\(machine).\(b64)", E2eeCipher.keyId(of: raw))
    }

    func testRingPairsPersistsAndForgets() throws {
        let storage = InMemoryE2eeStorage()
        let ring = E2eeKeyRing(storage: storage)
        let a = code("m-1", byte: 1)
        let paired = try ring.add(code: a.code, expectMachineId: "m-1")
        XCTAssertEqual(paired.kid, a.kid)
        XCTAssertTrue(ring.snapshot.hasKey(for: "m-1"))
        XCTAssertFalse(ring.snapshot.hasKey(for: "m-2"))
        // A new ring over the same storage (an app restart) still holds it.
        XCTAssertTrue(E2eeKeyRing(storage: storage).snapshot.hasKey(for: "m-1"))
        // The newest key of a machine seals; the old one still opens.
        let b = code("m-1", byte: 2)
        _ = try ring.add(code: b.code, now: Date().addingTimeInterval(5))
        XCTAssertEqual(ring.snapshot.latest(for: "m-1")?.kid, b.kid)
        XCTAssertNotNil(ring.snapshot.forKid(a.kid))
        XCTAssertTrue(ring.forget(machineId: "m-1"))
        XCTAssertFalse(ring.snapshot.hasKey(for: "m-1"))
        XCTAssertFalse(E2eeKeyRing(storage: storage).snapshot.hasKey(for: "m-1"))
    }

    func testRingRefusesWrongCodes() {
        let ring = E2eeKeyRing(storage: InMemoryE2eeStorage())
        XCTAssertThrowsError(try ring.add(code: "hello")) { XCTAssertEqual($0 as? E2eeKeyRing.PairingError, .notACode) }
        XCTAssertThrowsError(try ring.add(code: code("m-1", byte: 1).code, expectMachineId: "m-2")) {
            XCTAssertEqual($0 as? E2eeKeyRing.PairingError, .otherMachine)
        }
        // 43 chars that are not 32 bytes once decoded cannot happen; a code with the wrong length is not a code.
        XCTAssertThrowsError(try ring.add(code: "hcp1.m-1.AAAA")) { XCTAssertEqual($0 as? E2eeKeyRing.PairingError, .notACode) }
        XCTAssertTrue(ring.snapshot.isEmpty)
    }

    private final class FailingStorage: E2eeKeyStorage {
        func load() -> E2eeStorageRead { .empty }
        func save(_ json: String) -> Bool { false }
    }

    func testAKeyThatCannotBeStoredIsNotPaired() {
        let ring = E2eeKeyRing(storage: FailingStorage())
        XCTAssertThrowsError(try ring.add(code: code("m-1", byte: 1).code)) {
            XCTAssertEqual($0 as? E2eeKeyRing.PairingError, .storage)
        }
        XCTAssertFalse(ring.snapshot.hasKey(for: "m-1"))
    }

    // MARK: Inbound

    private func inbound(runs: [String: String] = ["run-1": "m-1"]) -> E2eeInbound {
        let ring = E2eeKeyRing(storage: InMemoryE2eeStorage())
        _ = try? ring.add(code: Self.vector.pairingCode)
        var i = E2eeInbound(keys: ring.snapshot)
        i.runMachine = runs
        return i
    }

    private func json(_ s: String?) -> [String: Any]? {
        s.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }

    private var streamFrame: String {
        let v = Self.vector
        return #"{"type":"stream","runId":"run-1","sessionId":"s","event":{"kind":"assistant","text":"hub text","e2e":{"e2e":1,"kid":"\#(v.envelope.kid)","n":"\#(v.envelope.n)","c":"\#(v.envelope.c)"}}}"#
    }

    func testAStreamFrameOpensUnderTheMachineThePhoneAttributesItTo() throws {
        let out = json(inbound().process(streamFrame))
        let ev = try XCTUnwrap(out?["event"] as? [String: Any])
        XCTAssertEqual(ev["text"] as? String, "привет, synthetic-marker")
        XCTAssertNil(ev["e2e"])
        XCTAssertEqual(ev["kind"] as? String, "assistant")
    }

    func testTheSameFrameDoesNotOpenUnderAnotherMachineOrAnUnknownRun() throws {
        // The hub cannot lift a run onto another machine: the phone's own record decides.
        for runs in [["run-1": "m-2"], [:]] {
            let text = try XCTUnwrap(inbound(runs: runs).process(streamFrame))
            let ev = try XCTUnwrap(json(text)?["event"] as? [String: Any])
            XCTAssertNotNil(ev["e2e"], "must stay sealed")
            XCTAssertNotEqual(ev["text"] as? String, "привет, synthetic-marker")
        }
    }

    func testClearContentForARunOfAKeyedMachineIsDropped() {
        let clear = #"{"type":"stream","runId":"run-1","sessionId":"s","event":{"kind":"assistant","text":"forged"}}"#
        XCTAssertNil(inbound().process(clear))
        XCTAssertNil(inbound().process(#"{"type":"user_turn","runId":"run-1","turnId":"t","text":"forged"}"#))
        XCTAssertNil(inbound().process(#"{"type":"tool_request","runId":"run-1","requestId":"q","tool":"Bash","input":{"command":"rm"},"title":"x"}"#))
        // A status frame of the same run carries no content: it passes. So does a run of an unkeyed machine.
        XCTAssertNotNil(inbound().process(#"{"type":"stream","runId":"run-1","sessionId":"s","event":{"kind":"status","code":"turn_started"}}"#))
        XCTAssertNotNil(inbound(runs: ["run-1": "m-9"]).process(clear))
    }

    func testClearTerminalAndMirrorContentOfAKeyedMachineIsDropped() {
        var i = inbound()
        i.term = ["t1": "m-1", "t2": "m-9"]
        i.mirror = ["x1": "m-1"]
        XCTAssertNil(i.process(#"{"type":"term_data","termId":"t1","data":"forged\n"}"#))
        XCTAssertNotNil(i.process(#"{"type":"term_data","termId":"t2","data":"fine\n"}"#))
        XCTAssertNil(i.process(#"{"type":"mirror_data","mirrorId":"x1","replace":true,"messages":[{"uuid":"u","type":"assistant","blocks":[{"type":"text","text":"forged"}]}]}"#))
        XCTAssertNotNil(i.process(#"{"type":"mirror_data","mirrorId":"x1","replace":true,"messages":[]}"#))
    }

    func testAToolRequestOfAKeyedRunWithoutAnOpenableEnvelopeIsNeverACard() {
        // stripped envelope: an empty «Bash» card the person could approve blind
        XCTAssertNil(inbound().process(#"{"type":"tool_request","runId":"run-1","requestId":"q","tool":"Bash","input":{}}"#))
        // corrupted envelope
        XCTAssertNil(inbound().process(#"{"type":"tool_request","runId":"run-1","requestId":"q","tool":"Bash","input":{},"e2e":{"e2e":1,"kid":"630dcd2966c43366","n":"oKGio6Slpqeoqaqr","c":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}}"#))
        // an ordinary machine's prompt is untouched
        XCTAssertNotNil(inbound(runs: ["run-1": "m-9"]).process(#"{"type":"tool_request","runId":"run-1","requestId":"q","tool":"Bash","input":{}}"#))
    }

    func testAnUnreadableRingIsNeverOverwrittenAndUnreadableRowsSurvive() throws {
        let broken = InMemoryE2eeStorage("not json")
        let ring = E2eeKeyRing(storage: broken)
        XCTAssertThrowsError(try ring.add(code: code("m-1", byte: 1).code))
        XCTAssertEqual(broken.stored, "not json")
        // one bad row does not cost the others, and survives a write
        let good = Data(repeating: 3, count: 32).base64EncodedString()
        let row = #"[{"kid":"a","machineId":"m-9","key":"AAAA","addedAt":1},{"kid":"b","machineId":"m-8","key":"\#(good)","addedAt":1}]"#
        let st = InMemoryE2eeStorage(row)
        let r2 = E2eeKeyRing(storage: st)
        XCTAssertTrue(r2.snapshot.hasKey(for: "m-8"))
        _ = try r2.add(code: code("m-1", byte: 1).code)
        XCTAssertTrue(st.stored!.contains(#""kid":"a""#))
    }

    @MainActor
    func testForgettingAKeyScrubsDecryptedStateAtOnce() async throws {
        let h = ClientHarness(); defer { h.clean() }
        try h.keyRing.add(code: Self.vector.pairingCode)
        await privateFleet(h)
        XCTAssertTrue(h.client.open(machineId: "m-1", sessionId: "s1"))
        h.sockets.last!.feed(#"{"type":"opened","runId":"run-1","machineId":"m-1","sessionId":"s1"}"#)
        for _ in 0..<200 where h.client.active?.runId == nil { await h.settle() }
        h.sockets.last!.feed(streamFrame)
        for _ in 0..<400 where h.client.lines.isEmpty { await h.settle() }
        XCTAssertFalse(h.client.lines.isEmpty)
        XCTAssertTrue(h.client.forgetKey(machineId: "m-1"))
        XCTAssertTrue(h.client.lines.isEmpty)
        XCTAssertTrue(h.client.isLocked("m-1"))
        XCTAssertNil(h.client.allMachines.first?.sessions.first?.cwd)
    }

    private final class LockedThenReadable: E2eeKeyStorage, @unchecked Sendable {
        var readable = false
        var inner = InMemoryE2eeStorage()
        var saved = 0
        func load() -> E2eeStorageRead { readable ? inner.load() : .failed }
        func save(_ json: String) -> Bool { saved += 1; return inner.save(json) }
    }

    func testAKeychainThatCannotBeReadIsNeverWrittenOverAndIsRetried() throws {
        let st = LockedThenReadable()
        let existing = Data(repeating: 5, count: 32)
        _ = st.inner.save(#"[{"kid":"k5","machineId":"m-5","key":"\#(existing.base64EncodedString())","addedAt":1}]"#)
        let ring = E2eeKeyRing(storage: st)
        XCTAssertTrue(ring.snapshot.isEmpty)
        XCTAssertThrowsError(try ring.add(code: code("m-1", byte: 1).code))   // locked: no write
        XCTAssertEqual(st.saved, 0)
        st.readable = true
        _ = try ring.add(code: code("m-1", byte: 1).code)                       // retried first
        XCTAssertTrue(ring.snapshot.hasKey(for: "m-5"))
        XCTAssertTrue(ring.snapshot.hasKey(for: "m-1"))
    }

    func testAClearRpcResultForAKeyedMachineFailsTheRequest() throws {
        var i = inbound()
        i.rpc = ["x": "m-1", "y": "m-1", "z": "m-1"]
        i.rpcMethod = ["x": "fs.read", "y": "models.list", "z": "fs.write"]
        let forged = try XCTUnwrap(json(i.process(#"{"type":"rpc_response","requestId":"x","ok":true,"result":{"content":"forged"}}"#)))
        XCTAssertEqual(forged["ok"] as? Bool, false)
        XCTAssertEqual(forged["requestId"] as? String, "x")
        XCTAssertNotNil(i.process(#"{"type":"rpc_response","requestId":"y","ok":true,"result":{"models":[]}}"#))
        let bare = try XCTUnwrap(json(i.process(#"{"type":"rpc_response","requestId":"z","ok":true,"result":{"ok":true}}"#)))
        XCTAssertEqual(bare["ok"] as? Bool, true)
    }

    func testAnEnvelopeOfAnUnknownKeyMarksTheMachineStale() throws {
        let env = try E2eeCipher.seal(["text": "x"], key: SymmetricKey(size: .bits256), kid: "ffffffffffffffff", bind: "m-1|a2c|stream|run-1")
        let envJSON = String(decoding: try JSONSerialization.data(withJSONObject: env.json), as: UTF8.self)
        let r = inbound().processDetailed(#"{"type":"stream","runId":"run-1","sessionId":"s","event":{"kind":"assistant","e2e":\#(envJSON)}}"#)
        XCTAssertEqual(r.staleKeyMachine, "m-1")
    }

    func testPushActionsAreOffForPrivateMachines() {
        let ring = E2eeKeyRing(storage: InMemoryE2eeStorage())
        XCTAssertTrue(ring.pushActionAllowed(userInfo: ["machineId": "m-1"]))
        XCTAssertFalse(ring.pushActionAllowed(userInfo: ["machineId": "m-1", "private": "true"]))
        XCTAssertFalse(ring.pushActionAllowed(userInfo: ["machineId": "m-1", "private": true]))
        _ = try? ring.add(code: Self.vector.pairingCode)
        XCTAssertFalse(ring.pushActionAllowed(userInfo: ["machineId": "m-1"]))
        XCTAssertFalse(ring.pushActionAllowed(userInfo: [:]))
        XCTAssertTrue(ring.pushActionAllowed(userInfo: ["machineId": "m-2"]))
    }

    @MainActor
    func testAFailedSendToAPrivateMachineComesBackThroughMemoryOnly() async throws {
        let h = ClientHarness(); defer { h.clean() }
        try h.keyRing.add(code: Self.vector.pairingCode)
        await privateFleet(h)
        let socket = try XCTUnwrap(h.sockets.last)
        socket.autoComplete = false
        XCTAssertTrue(h.client.open(machineId: "m-1", sessionId: "s1"))
        socket.feed(#"{"type":"opened","runId":"run-1","machineId":"m-1","sessionId":"s1"}"#)
        for _ in 0..<200 where h.client.active?.runId == nil { await h.settle() }
        XCTAssertTrue(h.client.sendInput("my words"))
        let done = try XCTUnwrap(socket.completions.last)
        done(ClientError.connectionClosed)
        for _ in 0..<50 where h.client.failedPrivate.isEmpty { await h.settle() }
        XCTAssertEqual(h.client.takeFailedPrivate(machineId: "m-1", sessionId: "s1").first?.text, "my words")
        XCTAssertTrue(h.client.pending.isEmpty)
    }

    @MainActor
    func testARunListThatMovesAPrivateRunToAnotherMachineIsIgnored() async throws {
        let h = ClientHarness(); defer { h.clean() }
        try h.keyRing.add(code: Self.vector.pairingCode)
        await privateFleet(h)
        let socket = try XCTUnwrap(h.sockets.last)
        XCTAssertTrue(h.client.open(machineId: "m-1", sessionId: "s1"))
        socket.feed(#"{"type":"opened","runId":"run-1","machineId":"m-1","sessionId":"s1"}"#)
        for _ in 0..<200 where h.client.active?.runId == nil { await h.settle() }
        socket.feed(#"{"type":"activity","runs":[{"runId":"run-1","machineId":"m-9","sessionId":"s1","state":"idle","since":1}]}"#)
        for _ in 0..<50 { await h.settle() }
        XCTAssertNotEqual(h.client.active?.machineId, "m-9")
    }

    func testClearRpcContentMatchesTheWebRule() {
        func clear(_ method: String, _ result: Any, ok: Bool = true) -> Bool {
            E2eeInbound.clearRpcContent(method: method, frame: ["type": "rpc_response", "ok": ok, "result": result])
        }
        let env = E2ee.Envelope(kid: "k", n: "n", c: "c").json
        XCTAssertFalse(clear("models.list", ["models": [Any]()]))
        XCTAssertFalse(clear("git.commit", ["ok": true]))
        XCTAssertFalse(clear("fs.read", ["e2e": env]))
        XCTAssertTrue(clear("fs.read", ["content": "forged"]))
        XCTAssertTrue(clear("fs.read", ["e2e": env, "content": "beside"]))
        XCTAssertFalse(E2eeInbound.clearRpcContent(method: "fs.read", frame: ["ok": false, "error": "offline"]))
        // history: a sealed message keeps only routing; anything else beside the envelope is forged
        let sealed: [String: Any] = ["uuid": "u", "type": "assistant", "blocks": [Any](), "e2e": env]
        XCTAssertFalse(clear("session.messages", ["messages": [sealed], "stale": false]))
        XCTAssertTrue(clear("session.messages", ["messages": [sealed.merging(["ts": 5]) { $1 }]]))
        XCTAssertTrue(clear("session.messages", ["messages": [sealed.merging(["model": "x"]) { $1 }]]))
        XCTAssertTrue(clear("session.messages", ["messages": [sealed.merging(["blocks": [["type": "text"]]]) { $1 }]]))
        XCTAssertTrue(clear("session.messages", ["messages": [["uuid": "u", "type": "user", "blocks": [["type": "text"]]]]]))
        XCTAssertFalse(clear("session.messages", ["messages": [["uuid": "u", "type": "user"]]]))
        XCTAssertTrue(clear("session.subagent", ["messages": [["uuid": "u", "ts": 1]]]))
        // the per-message exemption is for those two methods only
        XCTAssertTrue(clear("fs.list", ["messages": [sealed]]))
    }

    func testTheSamePrefilterListServesTheClientAndTheOpener() {
        for t in E2eeInbound.inspectedTypes {
            XCTAssertTrue(E2eeInbound.needsInspection(#"{"type":"\#(t)"}"#, hasKeys: true), t)
            XCTAssertFalse(E2eeInbound.needsInspection(#"{"type":"\#(t)"}"#, hasKeys: false), t)
        }
        XCTAssertTrue(E2eeInbound.inspectedTypes.contains("rpc_response"))
    }

    func testACurrentKeyFrameHealsAStaleMachine() {
        let r = inbound().processDetailed(streamFrame)
        XCTAssertEqual(r.healedMachine, "m-1")
        XCTAssertNil(r.staleKeyMachine)
    }

    func testPushActionsAreOffWhileTheKeychainIsUnreadable() {
        let st = LockedThenReadable()
        let ring = E2eeKeyRing(storage: st)
        XCTAssertTrue(ring.isUnreadable)
        XCTAssertFalse(ring.pushActionAllowed(userInfo: ["machineId": "m-2"]))
        st.readable = true
        ring.reload()
        XCTAssertFalse(ring.isUnreadable)
        XCTAssertTrue(ring.pushActionAllowed(userInfo: ["machineId": "m-2"]))
    }

    func testPurgeRemovesACachedTranscript() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = TranscriptCache(directory: dir)
        let a = TranscriptCache.key(machineId: "m-1", sessionId: "s1")
        let b = TranscriptCache.key(machineId: "m-2", sessionId: "s1")
        await cache.write(a, payload: .object(["messages": .array([])]), lastModified: 1)
        await cache.write(b, payload: .object(["messages": .array([])]), lastModified: 1)
        await cache.purge(machineId: "m-1")
        let gone = await cache.cachedAt(a), kept = await cache.cachedAt(b)
        XCTAssertNil(gone)
        XCTAssertEqual(kept, 1)
    }

    @MainActor
    func testAForgedRpcResponseGoesThroughTheClientAndFailsTheRequest() async throws {
        let h = ClientHarness(); defer { h.clean() }
        try h.keyRing.add(code: Self.vector.pairingCode)
        await privateFleet(h)
        let socket = try XCTUnwrap(h.sockets.last)
        let call = Task { @MainActor in
            try await h.client.rpc(machineId: "m-1", method: "fs.read", params: .object(["path": .string("/a")]))
        }
        for _ in 0..<200 where socket.frames(of: "rpc_request").isEmpty { await h.settle() }
        let id = try XCTUnwrap(socket.frames(of: "rpc_request").last?["requestId"] as? String)
        socket.feed(#"{"type":"rpc_response","requestId":"\#(id)","ok":true,"result":{"content":"forged by hub"}}"#)
        do {
            _ = try await call.value
            XCTFail("a clear result for a keyed machine must not resolve the call")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("не подтверждён"))
        }
    }

    @MainActor
    func testUnsentPrivateWordsDoNotCrossStores() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        h.client.failedPrivate = [FailedPrivateSend(scope: "account-other", machineId: "m-1", sessionId: "s1", text: "x", images: []),
                                  FailedPrivateSend(scope: h.client.storageScope, machineId: "m-1", sessionId: "s1", text: "mine", images: [])]
        XCTAssertEqual(h.client.takeFailedPrivate(machineId: "m-1", sessionId: "s1").map(\.text), ["mine"])
        XCTAssertTrue(h.client.failedPrivate.isEmpty)
    }

    func testOnlyLiveFramesMoveTheStaleLockAndAnUnknownKeyWinsInAFrame() throws {
        let v = Self.vector
        let k2 = SymmetricKey(size: .bits256)
        let unknown = try E2eeCipher.seal("T2", key: k2, kid: "ffffffffffffffff", bind: "m-1|a2c|title|s2")
        let known = try E2eeCipher.seal("T1", key: key, kid: v.kid, bind: "m-1|a2c|title|s1")
        func j(_ e: E2ee.Envelope) -> String { String(decoding: try! JSONSerialization.data(withJSONObject: e.json), as: UTF8.self) }
        // a session list mixing an openable and an unknown-key envelope: no verdict either way
        let list = #"{"type":"snapshot","machines":[{"machine":{"machineId":"m-1","name":"n","os":"linux","agentVersion":"1","private":true},"sessions":[{"sessionId":"s1","title":"Зашифровано","lastModified":1,"titleE2e":\#(j(known))},{"sessionId":"s2","title":"Зашифровано","lastModified":1,"titleE2e":\#(j(unknown))}]}]}"#
        let r = inbound().processDetailed(list)
        XCTAssertNil(r.staleKeyMachine)
        XCTAssertNil(r.healedMachine)
        // history page, same
        let msgEnv = try E2eeCipher.seal(["blocks": [Any]()], key: key, kid: v.kid, bind: "m-1|a2c|msg|u1")
        let msgUnknown = try E2eeCipher.seal(["blocks": [Any]()], key: k2, kid: "ffffffffffffffff", bind: "m-1|a2c|msg|u2")
        var i = inbound(); i.rpc = ["x": "m-1"]; i.rpcMethod = ["x": "session.messages"]
        let page = #"{"type":"rpc_response","requestId":"x","ok":true,"result":{"messages":[{"uuid":"u1","type":"assistant","blocks":[],"e2e":\#(j(msgEnv))},{"uuid":"u2","type":"assistant","blocks":[],"e2e":\#(j(msgUnknown))}]}}"#
        let p = i.processDetailed(page)
        XCTAssertNil(p.staleKeyMachine); XCTAssertNil(p.healedMachine)
        // a live frame: an unknown key marks, a current key heals, and a frame that reports one never heals
        let liveUnknown = try E2eeCipher.seal(["text": "x"], key: k2, kid: "ffffffffffffffff", bind: "m-1|a2c|stream|run-1")
        let l = inbound().processDetailed(#"{"type":"stream","runId":"run-1","sessionId":"s","event":{"kind":"assistant","e2e":\#(j(liveUnknown))}}"#)
        XCTAssertEqual(l.staleKeyMachine, "m-1")
        XCTAssertNil(l.healedMachine)
        XCTAssertEqual(inbound().processDetailed(streamFrame).healedMachine, "m-1")
    }

    @MainActor
    func testAFailedSendBeforeSessionStartedComesBackToTheNewRunScreen() async throws {
        let h = ClientHarness(); defer { h.clean() }
        try h.keyRing.add(code: Self.vector.pairingCode)
        await privateFleet(h)
        let socket = try XCTUnwrap(h.sockets.last)
        XCTAssertTrue(h.client.newSession(machineId: "m-1", cwd: "/x", message: nil))
        socket.feed(#"{"type":"opened","runId":"run-1","machineId":"m-1","sessionId":""}"#)
        for _ in 0..<200 where h.client.active?.runId == nil { await h.settle() }
        socket.autoComplete = false
        XCTAssertTrue(h.client.sendInput("before the id"))
        socket.completions.last?(ClientError.connectionClosed)
        for _ in 0..<50 where h.client.failedPrivate.isEmpty { await h.settle() }
        XCTAssertEqual(h.client.active?.sessionId, "")
        XCTAssertEqual(h.client.takeFailedPrivate(machineId: "m-1", sessionId: "").map(\.text), ["before the id"])
    }

    func testOrdinaryFramesAreLeftAlone() {
        let ping = #"{"type":"activity","runs":[]}"#
        XCTAssertEqual(inbound().process(ping), ping)
    }

    func testRpcHistoryPageOpensUnderTheMachineOfTheRequest() throws {
        // A history message the agent sealed, bound to its uuid.
        let v = Self.vector
        let env = try E2eeCipher.seal(["blocks": [["type": "text", "text": "secret answer"]], "ts": 1_700_000_000_000],
                                      key: key, kid: v.kid, bind: "m-1|a2c|msg|u1")
        let envJSON = String(decoding: try JSONSerialization.data(withJSONObject: env.json), as: UTF8.self)
        let frame = #"{"type":"rpc_response","requestId":"x","ok":true,"result":{"messages":[{"uuid":"u1","type":"assistant","blocks":[],"e2e":\#(envJSON)}]}}"#
        var i = inbound(); i.rpc = ["x": "m-1"]; i.rpcMethod = ["x": "session.messages"]
        let out = json(i.process(frame))
        let m = try XCTUnwrap(((out?["result"] as? [String: Any])?["messages"] as? [[String: Any]])?.first)
        XCTAssertNil(m["e2e"])
        XCTAssertEqual(((m["blocks"] as? [[String: Any]])?.first)?["text"] as? String, "secret answer")
        XCTAssertEqual((m["ts"] as? NSNumber)?.int64Value, 1_700_000_000_000)
        // The same page for a request the phone sent to another machine stays sealed.
        var other = inbound(); other.rpc = ["x": "m-2"]
        let kept = json(other.process(frame))
        XCTAssertNotNil((((kept?["result"] as? [String: Any])?["messages"] as? [[String: Any]])?.first)?["e2e"])
    }

    func testSessionTitlesOpenInTheSnapshot() throws {
        let v = Self.vector
        let env = try E2eeCipher.seal("Тайный план", key: key, kid: v.kid, bind: "m-1|a2c|title|s1")
        let envJSON = String(decoding: try JSONSerialization.data(withJSONObject: env.json), as: UTF8.self)
        let frame = #"{"type":"snapshot","machines":[{"machine":{"machineId":"m-1","name":"n","os":"linux","agentVersion":"1","private":true},"sessions":[{"sessionId":"s1","title":"Зашифровано","lastModified":1,"titleE2e":\#(envJSON)}]}]}"#
        let out = json(inbound().process(frame))
        let session = try XCTUnwrap((((out?["machines"] as? [[String: Any]])?.first?["sessions"]) as? [[String: Any]])?.first)
        XCTAssertEqual(session["title"] as? String, "Тайный план")
        XCTAssertNil(session["titleE2e"])
    }

    // MARK: Outbound

    private func outbound(keyed: Bool = true, epoch: String? = "ep-1", privateMachines: Set<String> = ["m-1"]) -> E2eeOutbound {
        let ring = E2eeKeyRing(storage: InMemoryE2eeStorage())
        if keyed { _ = try? ring.add(code: Self.vector.pairingCode) }
        return E2eeOutbound(keys: ring.snapshot, privateMachines: privateMachines, epochs: epoch.map { ["m-1": $0] } ?? [:])
    }

    private let turn: [String: Any] = ["type": "input", "runId": "run-1", "text": "my secret message"]

    func testSealedInputHasNoPlaintextAndOpensWithTheAgentsBinding() throws {
        let out = try outbound().seal(turn, machineId: "m-1")
        let wire = String(decoding: try JSONSerialization.data(withJSONObject: out), as: UTF8.self)
        XCTAssertFalse(wire.contains("my secret message"))
        let env = try XCTUnwrap(E2ee.Envelope(out["e2e"]))
        XCTAssertEqual(env.kid, Self.vector.kid)
        // What the agent does: open with kid|machineId|c2a:<epoch>|turn|
        let secret = try XCTUnwrap(E2eeCipher.open(env, key: key, bind: "m-1|c2a:ep-1|turn|") as? [String: Any])
        XCTAssertEqual(secret["text"] as? String, "my secret message")
        XCTAssertEqual(secret["_k"] as? String, "input")
        XCTAssertEqual(secret["_r"] as? String, "run-1")
        // ...and under no other epoch (a replay into a later process).
        XCTAssertThrowsError(try E2eeCipher.open(env, key: key, bind: "m-1|c2a:ep-2|turn|"))
        // The light echo for the person's other screens.
        let echo = try XCTUnwrap(E2ee.Envelope(out["turnE2e"]))
        let light = try XCTUnwrap(E2eeCipher.open(echo, key: key, bind: "m-1|c2a|turnecho|") as? [String: Any])
        XCTAssertEqual(light["text"] as? String, "my secret message")
    }

    func testSealingNeedsTheEpoch() {
        XCTAssertThrowsError(try outbound(epoch: nil).seal(turn, machineId: "m-1")) {
            XCTAssertEqual($0 as? E2eeOutbound.SealError, .noEpoch)
        }
        XCTAssertThrowsError(try outbound(keyed: false).seal(turn, machineId: "m-1"))
    }

    func testDecisions() {
        // Key held: sealed, whatever the hub says about the machine.
        XCTAssertEqual(outbound(privateMachines: []).decide(turn, candidates: ["m-1"]), .seal(machineId: "m-1"))
        // Private, no key: nothing is sent, pairing is offered.
        XCTAssertEqual(outbound(keyed: false).decide(turn, candidates: ["m-1"]), .needKey(machineId: "m-1"))
        // Not private, no key: an ordinary machine.
        XCTAssertEqual(outbound(keyed: false, privateMachines: []).decide(turn, candidates: ["m-9"]), .plain)
        // Nothing to protect in a bare subscribe.
        XCTAssertEqual(outbound(keyed: false).decide(["type": "open", "machineId": "m-1", "sessionId": "s"], candidates: ["m-1"]), .plain)
        // A hub that names two machines, one of them keyed: the keyed one wins; two keyed ones refuse.
        XCTAssertEqual(outbound().decide(turn, candidates: ["m-1", "m-9"]), .seal(machineId: "m-1"))
    }

    func testAFrameThatCannotBePlacedIsHeldBackOnceKeysExist() {
        guard case .refuse = outbound().decide(turn, candidates: []) else { return XCTFail("must refuse") }
        // A bare approval of an unplaced run is not the person's words: it goes.
        XCTAssertEqual(outbound().decide(["type": "tool_decision", "runId": "r", "requestId": "q", "allow": true], candidates: []), .plain)
        // No keys at all: an ordinary phone is not affected.
        XCTAssertEqual(outbound(keyed: false, privateMachines: []).decide(turn, candidates: []), .plain)
    }

    // MARK: The client end to end

    @MainActor
    private func privateFleet(_ h: ClientHarness, epoch: String? = "ep-1") async {
        await h.connect()
        let e = epoch.map { #","e2eEpoch":"\#($0)""# } ?? ""
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[{"machine":{"machineId":"m-1","name":"Закрытая","os":"linux","agentVersion":"1","private":true\#(e)},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s1","title":"Зашифровано","lastModified":1}]}],"activeRuns":[]}"#)
        for _ in 0..<200 where h.client.allMachines.isEmpty { await h.settle() }
    }

    @MainActor
    func testNoKeyMeansNothingIsSentAndPairingIsOffered() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await privateFleet(h)
        XCTAssertTrue(h.client.isLocked("m-1"))
        let before = h.sockets.last!.sent.count
        XCTAssertFalse(h.client.open(machineId: "m-1", sessionId: "s1", message: "plaintext secret"))
        XCTAssertFalse(h.client.queuePending(machineId: "m-1", sessionId: "s1", text: "plaintext secret"))
        XCTAssertEqual(h.client.pairRequest?.machineId, "m-1")
        XCTAssertFalse(h.sockets.last!.sent.dropFirst(before).contains { $0.contains("plaintext secret") })
        XCTAssertEqual(h.sockets.last!.sent.count, before)
    }

    @MainActor
    func testWithAKeyTheMessageLeavesSealed() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await privateFleet(h)
        XCTAssertTrue(h.client.isLocked("m-1"))
        try h.client.pair(code: Self.vector.pairingCode, expectMachineId: "m-1")
        XCTAssertFalse(h.client.isLocked("m-1"))
        XCTAssertTrue(h.client.hasKey(for: "m-1"))
        // pairing reconnected: a fresh socket takes the snapshot
        for _ in 0..<200 where h.sockets.count < 2 { await h.settle() }
        let socket = try XCTUnwrap(h.sockets.last)
        socket.feed(#"{"type":"snapshot","machines":[{"machine":{"machineId":"m-1","name":"Закрытая","os":"linux","agentVersion":"1","private":true,"e2eEpoch":"ep-1"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s1","title":"Зашифровано","lastModified":1}]}],"activeRuns":[]}"#)
        for _ in 0..<200 where !h.client.hasKey(for: "m-1") { await h.settle() }
        await h.settle()
        XCTAssertTrue(h.client.open(machineId: "m-1", sessionId: "s1", message: "plaintext secret"))
        let frames = socket.frames(of: "open")
        let open = try XCTUnwrap(frames.last)
        XCTAssertNil(open["message"])
        XCTAssertNotNil(E2ee.Envelope(open["e2e"]))
        XCTAssertNotNil(E2ee.Envelope(open["turnE2e"]))
        XCTAssertFalse(socket.sent.contains { $0.contains("plaintext secret") })
        // A private machine's words do not go to the offline queue on disk, nor its title to a model.
        XCTAssertFalse(h.client.queuePending(machineId: "m-1", sessionId: "s1", text: "later"))
        let enrich = await h.client.enrichState(machineId: "m-1", sessionId: "s1", source: nil, uuid: "u", text: "x")
        XCTAssertEqual(enrich, .unavailable)
        h.keyRing.removeAll()
    }

    @MainActor
    func testANotificationReplyNeverLeavesInTheClearForAPrivateMachine() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await privateFleet(h)
        // The run is unknown to this phone (a cold start from a push) and it knows a private machine.
        XCTAssertFalse(h.client.pushMayLeaveInClear(runId: "r-unknown"))
        h.sockets.last!.feed(#"{"type":"activity","runs":[{"runId":"r1","machineId":"m-1","sessionId":"s1","state":"idle","since":1}]}"#)
        for _ in 0..<200 where h.client.activeRuns.isEmpty { await h.settle() }
        XCTAssertFalse(h.client.pushMayLeaveInClear(runId: "r1"))
    }

    @MainActor
    func testAnUnannouncedEpochFailsTheSendInsteadOfSendingClear() async throws {
        let h = ClientHarness(); defer { h.clean() }
        try h.keyRing.add(code: Self.vector.pairingCode)
        await privateFleet(h, epoch: nil)
        let socket = try XCTUnwrap(h.sockets.last)
        let before = socket.sent.count
        XCTAssertFalse(h.client.open(machineId: "m-1", sessionId: "s1", message: "plaintext secret"))
        XCTAssertEqual(socket.sent.count, before)
        XCTAssertNotNil(h.client.lastError)
    }

    @MainActor
    func testAnEncryptedFrameFromTheHubReachesTheTranscriptOpened() async throws {
        let h = ClientHarness(); defer { h.clean() }
        try h.keyRing.add(code: Self.vector.pairingCode)
        await privateFleet(h)
        let socket = try XCTUnwrap(h.sockets.last)
        // Open the session so the client records which machine the run belongs to.
        XCTAssertTrue(h.client.open(machineId: "m-1", sessionId: "s1"))
        socket.feed(#"{"type":"opened","runId":"run-1","machineId":"m-1","sessionId":"s1"}"#)
        for _ in 0..<200 where h.client.active?.runId == nil { await h.settle() }
        socket.feed(streamFrame)
        for _ in 0..<400 where !h.client.lines.contains(where: { $0.text.contains("synthetic-marker") }) { await h.settle() }
        XCTAssertTrue(h.client.lines.contains { $0.text == "привет, synthetic-marker" })
        // The hub's own invention for the same run is dropped, not shown.
        socket.feed(#"{"type":"stream","runId":"run-1","sessionId":"s1","event":{"kind":"assistant","text":"forged by hub"}}"#)
        for _ in 0..<50 { await h.settle() }
        XCTAssertFalse(h.client.lines.contains { $0.text.contains("forged by hub") })
    }
}
