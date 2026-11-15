import XCTest
@testable import CCRemoteKit

/// Radio / battery economy of the socket: what the client says on the wire and
/// how it backs off (REQUESTS-AUDIT, 24.10.2026).
@MainActor
final class ClientNetworkEconomyTests: XCTestCase {
    func testReconnectDelayHasJitterAndCeilings() {
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 0, jitter: 1), 0.3, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 3, jitter: 1), 4, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 5, jitter: 1), 10, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 6, jitter: 1), 10, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 7, jitter: 1), 30, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 500, jitter: 1), 30, accuracy: 0.001)
        // ±20 %, never outside it whatever the random source says.
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 7, jitter: 0.8), 24, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 7, jitter: 1.2), 36, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 7, jitter: 9), 36, accuracy: 0.001)
        XCTAssertEqual(CentralClient.reconnectDelay(retry: 7, jitter: 0), 24, accuracy: 0.001)
    }

    func testHelloAnnouncesStatsOnDemandAndInterestIsCounted() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        let hello = try XCTUnwrap(socket.frames(of: "hello").first)
        XCTAssertTrue((hello["caps"] as? [String] ?? []).contains("statsOnDemand"))
        XCTAssertTrue(socket.frames(of: "stats_interest").isEmpty, "no screen asks for stats yet")

        h.client.setStatsInterest(true)
        h.client.setStatsInterest(true)   // a second screen: no second frame
        XCTAssertEqual(socket.frames(of: "stats_interest").map { $0["on"] as? Bool }, [true])
        h.client.setStatsInterest(false)
        XCTAssertEqual(socket.frames(of: "stats_interest").count, 1, "one screen still looks")
        h.client.setStatsInterest(false)
        XCTAssertEqual(socket.frames(of: "stats_interest").map { $0["on"] as? Bool }, [true, false])
        h.client.setStatsInterest(false)  // unbalanced call must not go negative
        h.client.setStatsInterest(true)
        XCTAssertEqual(socket.frames(of: "stats_interest").map { $0["on"] as? Bool }, [true, false, true])
    }

    func testStatsInterestIsRepeatedOnAReplacementSocketAndDroppedInBackground() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        h.client.setStatsInterest(true)
        let first = h.sockets.last!
        XCTAssertEqual(first.frames(of: "stats_interest").count, 1)

        h.client.appWillBackground()
        XCTAssertEqual(first.frames(of: "stats_interest").map { $0["on"] as? Bool }, [true, false],
                       "backgrounded: telemetry off")
        XCTAssertEqual(first.frames(of: "pause").count, 1)
        // A frame without an assertion for housekeeping; the pause itself is the one that flushes.
        h.client.appDidBecomeActive(fromBackground: true)
        first.pongs.last?(ClientError.connectionClosed)
        for _ in 0..<100 where h.sockets.count < 2 { await h.settle() }
        let second = try XCTUnwrap(h.sockets.last)
        XCTAssertEqual(h.sockets.count, 2)
        XCTAssertEqual(second.frames(of: "stats_interest").map { $0["on"] as? Bool }, [true],
                       "the new socket repeats the interest right after hello")
    }

    func testSocketThatOpensInTheBackgroundIsPausedAgain() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        h.client.appWillBackground()
        // The hub forgot `pause` together with the old socket.
        h.client.connect(endpoint: h.endpoint, token: "alice")
        let second = try XCTUnwrap(h.sockets.last)
        XCTAssertEqual(h.sockets.count, 2)
        let types = second.sent.compactMap {
            (try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])?["type"] as? String
        }
        XCTAssertEqual(types, ["hello", "pause"])
    }

    /// Пока сокет на паузе, хаб отбрасывает `mirror_data`; возврат на ТОМ ЖЕ сокете — это
    /// `resume` после пинга. Счётчик, по которому зеркало переоткрывается, растёт ровно тогда.
    func testResumeOnTheSameSocketBumpsResumeCount() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let socket = try XCTUnwrap(h.sockets.last)
        XCTAssertEqual(h.client.resumeCount, 0)
        h.client.appWillBackground()
        h.client.appDidBecomeActive(fromBackground: true)
        let pong = try XCTUnwrap(socket.pongs.last, "the foreground return probes the socket")
        pong(nil)
        await h.settle()
        XCTAssertEqual(h.client.resumeCount, 1)
        XCTAssertEqual(socket.frames(of: "resume").count, 1)
    }

    /// Проба, начатая на виду, не заканчивается в фоне: её pong не снимает паузу хаба с
    /// сокета, который ОС вот-вот заморозит, а её ошибка не открывает сокет вслепую.
    func testProbeFinishingInTheBackgroundNeitherResumesNorReconnects() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let socket = try XCTUnwrap(h.sockets.last)
        h.client.appWillBackground()
        h.client.appDidBecomeActive(fromBackground: true)
        let pong = try XCTUnwrap(socket.pongs.last)
        h.client.appWillBackground()
        pong(nil)
        await h.settle()
        XCTAssertEqual(h.client.resumeCount, 0)
        XCTAssertTrue(socket.frames(of: "resume").isEmpty)

        h.client.appDidBecomeActive(fromBackground: true)
        h.client.appWillBackground()
        socket.pongs.last?(ClientError.connectionClosed)
        await h.settle()
        XCTAssertEqual(h.sockets.count, 1, "a failed pong in the background is judged by the next return probe")
    }

    /// Новый сокет считается каждый раз, а не только когда `status` успел побывать `.closed`
    /// на глазах у SwiftUI: по нему перезапрашиваются кэши, которые сокет-в-сокет не меняет.
    func testSocketGenerationCountsEveryOpenedSocket() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        XCTAssertEqual(h.client.socketGeneration, 1)
        h.client.connect(endpoint: h.endpoint, token: "alice")
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[],"activeRuns":[]}"#)
        await h.settle()
        XCTAssertEqual(h.client.socketGeneration, 2)
    }

    func testNoApplicationLevelPingOnTheWire() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        XCTAssertTrue(h.sockets.last!.frames(of: "ping").isEmpty)
    }
    /// A `session_updates` patch re-judges only the patched sessions and touches
    /// only its own machine, yet the visible/hidden split stays exactly right.
    func testSessionPatchKeepsAutomatedFilterConsistent() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        func machine(_ id: String, _ sessions: String) -> String {
            #"{"machine":{"machineId":"\#(id)","name":"\#(id)","os":"linux","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[\#(sessions)]}"#
        }
        func session(_ id: String, cwd: String, at: Int) -> String {
            #"{"sessionId":"\#(id)","title":"T \#(id)","cwd":"\#(cwd)","lastModified":\#(at)}"#
        }
        socket.feed(#"{"type":"snapshot","machines":[\#(machine("a", session("a1", cwd: "/work/a", at: 1) + "," + session("a2", cwd: "/tmp/x", at: 2))),\#(machine("b", session("b1", cwd: "/work/b", at: 3)))],"activeRuns":[]}"#)
        for _ in 0..<100 where h.client.allMachines.count < 2 { await h.settle() }
        func visible(_ machineId: String) -> [String] {
            h.client.machines.first { $0.machine.machineId == machineId }?.sessions.map(\.sessionId) ?? []
        }
        XCTAssertEqual(visible("a"), ["a1"])
        XCTAssertEqual(h.client.hiddenAutomatedSessionKeys, ["a::a2"])

        // a1 turns into a scratch session, a3 appears fresh, b untouched.
        socket.feed(#"{"type":"session_updates","machineId":"a","sessions":[\#(session("a1", cwd: "/tmp/y", at: 5)),\#(session("a3", cwd: "/work/a3", at: 6))],"removed":[]}"#)
        for _ in 0..<100 where visible("a") != ["a3"] { await h.settle() }
        XCTAssertEqual(visible("a"), ["a3"])
        XCTAssertEqual(visible("b"), ["b1"])
        XCTAssertEqual(h.client.hiddenAutomatedSessionKeys, ["a::a1", "a::a2"])
        XCTAssertEqual(h.client.allMachines.first { $0.machine.machineId == "a" }?.sessions.map(\.sessionId), ["a3", "a1", "a2"])

        // Removing a hidden one drops its key.
        socket.feed(#"{"type":"session_updates","machineId":"a","sessions":[],"removed":["a2"]}"#)
        for _ in 0..<100 where h.client.hiddenAutomatedSessionKeys.count != 1 { await h.settle() }
        XCTAssertEqual(h.client.hiddenAutomatedSessionKeys, ["a::a1"])
    }
}
