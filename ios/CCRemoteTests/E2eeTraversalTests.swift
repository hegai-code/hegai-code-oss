import XCTest
@testable import CCRemoteKit

/// The pure half of the envelope (Protocol/E2eeTraversal.swift) against what
/// shared/src/e2e.ts does. No crypto here, so it also runs on Linux
/// (`ios/scripts/check-protocol-linux.sh`); the cipher and the cross-language
/// vectors are in E2eeTests.
final class E2eeTraversalTests: XCTestCase {
    typealias Obj = E2ee.Obj

    /// A "cipher" that records what it was asked to seal and hands back a recognisable envelope.
    private final class Spy {
        var sealed: [(secret: Any, bind: String)] = []
        lazy var sealer: E2ee.Sealer = { [unowned self] secret, bind in
            self.sealed.append((secret, bind))
            return E2ee.Envelope(kid: "kid1", n: "n", c: "c\(self.sealed.count)")
        }
    }

    func testPairingCode() {
        // Bytes 0..31, base64url without padding — built, not written out, so
        // a secret scanner does not read a key-shaped literal (gitleaks).
        let key = Data((0..<32).map { UInt8($0) }).base64EncodedString()
            .replacingOccurrences(of: "=", with: "")
        let code = "hcp1.m-1.\(key)"
        XCTAssertEqual(E2ee.parsePairingCode(code), .init(machineId: "m-1", key: key))
        XCTAssertEqual(E2ee.parsePairingCode("  \(code)\n")?.machineId, "m-1")
        // The machine id may contain dots: the key is the LAST segment.
        XCTAssertEqual(E2ee.parsePairingCode("hcp1.host.example.\(key)")?.machineId, "host.example")
        XCTAssertNil(E2ee.parsePairingCode("hcp2.m-1.\(key)"))
        XCTAssertNil(E2ee.parsePairingCode("hcp1.m-1.short"))
        XCTAssertNil(E2ee.parsePairingCode("hcp1..\(key)"))
        XCTAssertNil(E2ee.parsePairingCode("hcp1.m-1.\(key.dropLast())!"))
    }

    func testBindings() {
        XCTAssertEqual(E2ee.frameBind(dir: "a2c", frame: ["type": "stream", "runId": "r1"]), "a2c|stream|r1")
        XCTAssertEqual(E2ee.frameBind(dir: "a2c", frame: ["type": "tool_request", "requestId": "q"]), "a2c|tool_request|q")
        XCTAssertEqual(E2ee.frameBind(dir: "a2c", frame: ["type": "term_data", "termId": "t"]), "a2c|term_data|t")
        XCTAssertEqual(E2ee.frameBind(dir: "a2c", frame: ["type": "rpc_response", "requestId": "x"]), "a2c|rpc|x")
        XCTAssertEqual(E2ee.frameBind(dir: "a2c", frame: ["type": "user_turn", "runId": "r"]), "c2a|turnecho|")
        // Every turn frame shares one binding, and a client-to-agent one names the epoch.
        for t in ["input", "open", "new_session", "takeover", "resume"] {
            XCTAssertEqual(E2ee.frameBind(dir: "c2a", frame: ["type": t], epoch: "ep"), "c2a:ep|turn|", t)
        }
        XCTAssertEqual(E2ee.frameBind(dir: "c2a", frame: ["type": "tool_decision", "requestId": "q"], epoch: "ep"), "c2a:ep|tool_decision|q")
        XCTAssertEqual(E2ee.frameBind(dir: "c2a", frame: ["type": "set_permission_mode", "runId": "r"], epoch: "ep"), "c2a:ep|set_permission_mode|r")
        XCTAssertEqual(E2ee.frameBind(dir: "c2a", frame: ["type": "rpc_request", "requestId": "x"], epoch: "ep"), "c2a:ep|rpc|x")
        XCTAssertEqual(E2ee.aad(kid: "k", bind: E2ee.withMachine("m", "a2c|stream|r")), "k|m|a2c|stream|r")
    }

    func testSealInputLeavesNoContentAndCarriesTheTurnMarkers() throws {
        let spy = Spy()
        let frame: Obj = ["type": "input", "runId": "r1", "text": "secret words",
                          "images": [["media_type": "image/png", "data": "AAAA"]]]
        let out = try E2ee.sealFrame(frame, epoch: "ep", seal: spy.sealer)
        XCTAssertEqual(out["text"] as? String, "")
        XCTAssertNil(out["images"])
        XCTAssertEqual(out["runId"] as? String, "r1")
        XCTAssertNotNil(E2ee.Envelope(out["e2e"]))
        XCTAssertEqual(spy.sealed.count, 1)
        XCTAssertEqual(spy.sealed[0].bind, "c2a:ep|turn|")
        let secret = try XCTUnwrap(spy.sealed[0].secret as? Obj)
        XCTAssertEqual(secret["text"] as? String, "secret words")
        XCTAssertEqual(secret["_k"] as? String, "input")
        XCTAssertEqual(secret["_r"] as? String, "r1")
        XCTAssertNil(secret["_s"])
    }

    func testNewSessionSealsTheChoicesAndKeepsRoutingHints() throws {
        let spy = Spy()
        let frame: Obj = ["type": "new_session", "machineId": "m", "cwd": "/home/x", "message": "hi",
                          "model": "opus", "permissionMode": "plan", "category": "code"]
        let out = try E2ee.sealFrame(frame, epoch: "ep", seal: spy.sealer)
        XCTAssertNil(out["message"])
        // Routing hints stay in the clear for the hub; the sealed copy is the truth.
        XCTAssertEqual(out["cwd"] as? String, "/home/x")
        XCTAssertEqual(out["model"] as? String, "opus")
        XCTAssertEqual(out["category"] as? String, "code")
        let secret = try XCTUnwrap(spy.sealed[0].secret as? Obj)
        XCTAssertEqual(secret["cwd"] as? String, "/home/x")
        XCTAssertEqual(secret["permissionMode"] as? String, "plan")
        XCTAssertEqual(secret["_k"] as? String, "new_session")
    }

    func testToolDecisionAndModeAreSealed() throws {
        let spy = Spy()
        let out = try E2ee.sealFrame(["type": "tool_decision", "runId": "r", "requestId": "q", "allow": true, "message": "ok"],
                                     epoch: "ep", seal: spy.sealer)
        XCTAssertEqual(out["allow"] as? Bool, true)      // routing hint
        XCTAssertNil(out["message"])
        XCTAssertEqual(spy.sealed[0].bind, "c2a:ep|tool_decision|q")
        XCTAssertEqual((spy.sealed[0].secret as? Obj)?["_r"] as? String, "r")

        let spy2 = Spy()
        _ = try E2ee.sealFrame(["type": "set_permission_mode", "runId": "r", "mode": "plan"], epoch: "ep", seal: spy2.sealer)
        XCTAssertEqual(spy2.sealed[0].bind, "c2a:ep|set_permission_mode|r")
        XCTAssertEqual((spy2.sealed[0].secret as? Obj)?["mode"] as? String, "plan")
    }

    func testRpcSealsContentParamsAndRepeatsTheBoundOnes() throws {
        let spy = Spy()
        let frame: Obj = ["type": "rpc_request", "requestId": "x", "machineId": "m", "method": "fs.write",
                          "params": ["path": "/a/b", "content": "file body", "cwd": "/a"]]
        let out = try E2ee.sealFrame(frame, epoch: "ep", seal: spy.sealer)
        let params = try XCTUnwrap(out["params"] as? Obj)
        XCTAssertNil(params["content"])
        XCTAssertEqual(params["path"] as? String, "/a/b")
        XCTAssertNotNil(E2ee.Envelope(params["e2e"]))
        XCTAssertEqual(spy.sealed[0].bind, "c2a:ep|rpc|x")
        let secret = try XCTUnwrap(spy.sealed[0].secret as? Obj)
        XCTAssertEqual(secret["content"] as? String, "file body")
        XCTAssertEqual(secret["_m"] as? String, "fs.write")
        let bound = try XCTUnwrap(secret["_p"] as? Obj)
        XCTAssertEqual(bound["path"] as? String, "/a/b")
        XCTAssertEqual(bound["cwd"] as? String, "/a")

        // A read has nothing to seal and goes as it is.
        let read: Obj = ["type": "rpc_request", "requestId": "y", "method": "fs.read", "params": ["path": "/a"]]
        let spy3 = Spy()
        let same = try E2ee.sealFrame(read, epoch: "ep", seal: spy3.sealer)
        XCTAssertTrue(spy3.sealed.isEmpty)
        XCTAssertNil((same["params"] as? Obj)?["e2e"])
    }

    func testTurnSecretIsTheLightEcho() {
        XCTAssertNil(E2ee.turnSecret(["type": "open"]))
        let s = E2ee.turnSecret(["type": "input", "text": "hi", "images": [1, 2],
                                 "files": [["name": "a.txt", "data": "x"], ["name": ""]]])
        XCTAssertEqual(s?["text"] as? String, "hi")
        XCTAssertEqual(s?["images"] as? Int, 2)
        XCTAssertEqual(s?["files"] as? [String], ["a.txt"])
        XCTAssertEqual(E2ee.turnSecret(["type": "open", "message": "m"])?["text"] as? String, "m")
        XCTAssertEqual(E2ee.turnEchoBind, "c2a|turnecho|")
    }

    func testNeedsSealAndRealContent() {
        XCTAssertFalse(E2ee.needsSeal(["type": "open", "machineId": "m", "sessionId": "s"]))
        XCTAssertTrue(E2ee.needsSeal(["type": "open", "machineId": "m", "sessionId": "s", "message": "hi"]))
        XCTAssertFalse(E2ee.needsSeal(["type": "rpc_request", "method": "projects.list", "params": [String: Any]()]))
        XCTAssertTrue(E2ee.needsSeal(["type": "term_input", "termId": "t", "data": "ls\n"]))
        XCTAssertFalse(E2ee.needsSeal(["type": "interrupt", "runId": "r"]))
        // A bare approval or a mode switch is sealed only because of the machine it goes to.
        XCTAssertTrue(E2ee.needsSeal(["type": "tool_decision", "runId": "r", "requestId": "q", "allow": true]))
        XCTAssertFalse(E2ee.hasRealContent(["type": "tool_decision", "runId": "r", "requestId": "q", "allow": true]))
        XCTAssertFalse(E2ee.hasRealContent(["type": "set_permission_mode", "runId": "r", "mode": "plan"]))
        XCTAssertTrue(E2ee.hasRealContent(["type": "tool_decision", "runId": "r", "requestId": "q", "allow": false, "message": "no"]))
        XCTAssertTrue(E2ee.hasRealContent(["type": "input", "runId": "r", "text": "hi"]))
        XCTAssertTrue(E2ee.hasRealContent(["type": "term_input", "termId": "t", "data": "x"]))
    }

    func testOpenPutsContentBackAndDropsAClearCopy() throws {
        // A stream event the agent sealed: the clear text a hub left next to it must not survive.
        let env = E2ee.Envelope(kid: "kid1", n: "n", c: "c")
        let frame: Obj = ["type": "stream", "runId": "r1",
                          "event": ["kind": "assistant", "text": "hub wrote this", "e2e": env.json]]
        var seen: [String] = []
        let out = E2ee.openFrame(frame) { e, bind in
            seen.append(bind)
            XCTAssertEqual(e, env)
            return ["text": "real"]
        }
        XCTAssertEqual(seen, ["a2c|stream|r1"])
        let ev = try XCTUnwrap(out["event"] as? Obj)
        XCTAssertEqual(ev["text"] as? String, "real")
        XCTAssertNil(ev["e2e"])
        XCTAssertEqual(ev["kind"] as? String, "assistant")
    }

    func testAnEnvelopeThatDoesNotOpenStaysAsItWas() {
        let env = E2ee.Envelope(kid: "kid1", n: "n", c: "c")
        let frame: Obj = ["type": "user_turn", "runId": "r", "text": "", "e2e": env.json]
        let out = E2ee.openFrame(frame) { _, _ in nil }
        XCTAssertNotNil(E2ee.Envelope(out["e2e"]))
    }

    func testOpenRpcResultsAndHistoryMessages() throws {
        let env = E2ee.Envelope(kid: "kid1", n: "n", c: "c").json
        var binds: [String] = []
        let whole = E2ee.openFrame(["type": "rpc_response", "requestId": "x", "ok": true, "result": ["e2e": env]]) { _, b in
            binds.append(b); return ["files": ["a"]]
        }
        XCTAssertEqual((whole["result"] as? Obj)?["files"] as? [String], ["a"])
        XCTAssertEqual(binds, ["a2c|rpc|x"])

        let err = E2ee.openFrame(["type": "rpc_response", "requestId": "x", "ok": false, "error": "Зашифровано", "e2e": env]) { _, _ in
            ["error": "no such file"]
        }
        XCTAssertEqual(err["error"] as? String, "no such file")
        XCTAssertNil(err["e2e"])

        var msgBinds: [String] = []
        let page = E2ee.openFrame(["type": "rpc_response", "requestId": "y", "ok": true,
                                   "result": ["messages": [["uuid": "u1", "type": "assistant", "blocks": [Any](), "e2e": env]]]]) { _, b in
            msgBinds.append(b); return ["blocks": [["type": "text", "text": "hi"]], "ts": 5]
        }
        let messages = try XCTUnwrap((page["result"] as? Obj)?["messages"] as? [Obj])
        XCTAssertEqual(msgBinds, ["a2c|msg|u1"])
        XCTAssertEqual(messages[0]["ts"] as? Int, 5)
        XCTAssertEqual((messages[0]["blocks"] as? [Obj])?.count, 1)
        XCTAssertNil(messages[0]["e2e"])
    }

    func testSummaryOpens() {
        let env = E2ee.Envelope(kid: "kid1", n: "n", c: "c").json
        var binds: [String] = []
        let s = E2ee.openSummary(["sessionId": "s1", "title": E2ee.placeholderTitle, "titleE2e": env, "cwdE2e": env]) { _, b in
            binds.append(b)
            return b.contains("|title|") ? "Real title" : ["cwd": "/home/x", "project": "x", "gitBranch": "main"] as Obj
        }
        XCTAssertEqual(binds, ["a2c|title|s1", "a2c|cwd|s1"])
        XCTAssertEqual(s["title"] as? String, "Real title")
        XCTAssertEqual(s["cwd"] as? String, "/home/x")
        XCTAssertEqual(s["gitBranch"] as? String, "main")
        XCTAssertNil(s["titleE2e"])
        XCTAssertNil(s["cwdE2e"])
    }

    func testMayCarryE2e() {
        XCTAssertTrue(E2ee.mayCarryE2e(#"{"event":{"e2e":{"e2e":1}}}"#))
        XCTAssertTrue(E2ee.mayCarryE2e(#"{"titleE2e":{}}"#))
        XCTAssertFalse(E2ee.mayCarryE2e(#"{"type":"stream","text":"hello"}"#))
    }
}
