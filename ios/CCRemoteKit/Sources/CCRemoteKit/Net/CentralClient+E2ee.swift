import Foundation

/// Private machine (docs/E2EE.md) on the phone: pairing, what is sealed on the
/// way out, what is opened on the way in. Mirrors web/src/e2ee and the E2EE
/// parts of web/src/useCentral.ts; the pure halves are `E2ee` (the traversal),
/// `E2eeOutbound` and `E2eeInbound`.
///
/// The rule everywhere: FAIL CLOSED. A frame that carries content for a machine
/// that is private, or whose key this phone holds, is sealed or not sent; a
/// failure to seal is a failed send, never a plaintext one.

/// A request to show the pairing sheet.
public struct PairRequest: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public var machineId: String?
    public var machineName: String?
    public init(machineId: String? = nil, machineName: String? = nil) {
        self.machineId = machineId; self.machineName = machineName
    }
}

public extension E2eeKeyRing {
    /// May a quick action on a notification (approve, deny, reply) go to the hub as it
    /// stands, over a channel that cannot seal it? Not for a private machine: the push
    /// says so (`private`), or this phone holds the machine's key, or - with keys on the
    /// phone - the push does not say which machine it is.
    func pushActionAllowed(userInfo: [AnyHashable: Any]) -> Bool {
        // A Keychain that could not be read says nothing about which machines are private.
        let keys = snapshot
        if isUnreadable { return false }
        let flag = userInfo["private"]
        if flag as? Bool == true { return false }
        if let s = flag as? String, ["true", "1", "yes"].contains(s.lowercased()) { return false }
        guard let machineId = userInfo["machineId"] as? String, !machineId.isEmpty else { return keys.isEmpty }
        return !keys.hasKey(for: machineId)
    }

    /// One ring for the whole process: the main connection and every pane read the same keys.
    static let shared = E2eeKeyRing()
}

/// A send to a private machine that did not go out, kept in memory so the person gets the words back.
public struct FailedPrivateSend: Identifiable {
    public let id = UUID()
    /// The store it was made in: a send from one account is never handed to another.
    public let scope: String
    public let machineId: String
    public let sessionId: String
    public let text: String
    public let images: [ImageAttachment]
}

extension ClientMessage {
    /// Whether this frame can carry something the person wrote or chose: the
    /// ones `E2ee.isContentFrame` names. Only these ever pass through sealing.
    var carriesContent: Bool {
        switch self {
        case .open, .newSession, .takeover, .input, .toolDecision, .setPermissionMode, .termInput, .rpcRequest:
            return true
        default:
            return false
        }
    }
}

@MainActor
public extension CentralClient {
    // MARK: What is private

    private func machineInfo(_ machineId: String) -> MachineInfo? {
        allMachines.first { $0.machine.machineId == machineId }?.machine
    }

    /// Whether this phone holds a key for the machine.
    func hasKey(for machineId: String) -> Bool {
        _ = e2eeRevision
        return keyRing.snapshot.hasKey(for: machineId)
    }

    /// The owner marked the machine private, or this phone holds its key: either
    /// way its content is never sent to a hub service in the clear and never parked on disk.
    func isPrivateMachine(_ machineId: String) -> Bool {
        machineInfo(machineId)?.isPrivate == true || hasKey(for: machineId)
    }

    /// Private and no key here: the session shows «нужен ключ», not broken content.
    func isLocked(_ machineId: String) -> Bool {
        machineInfo(machineId)?.isPrivate == true && (!hasKey(for: machineId) || e2eeStale.contains(machineId))
    }

    /// Words of a send to `machineId`/`sessionId` that did not go out, given back once.
    func takeFailedPrivate(machineId: String, sessionId: String) -> [FailedPrivateSend] {
        failedPrivate.removeAll { $0.scope != storageScope }
        let mine = failedPrivate.filter { $0.machineId == machineId && $0.sessionId == sessionId }
        if !mine.isEmpty { failedPrivate.removeAll { f in mine.contains { $0.id == f.id } } }
        return mine
    }

    /// The machine is no longer private but this phone still holds its key: a
    /// phone with a key refuses clear content for that machine, so the key has to go.
    func hasLeftoverKey(for machineId: String) -> Bool {
        guard hasKey(for: machineId) else { return false }
        return machineInfo(machineId).map { !$0.isPrivate } ?? false
    }

    // MARK: Pairing

    /// Pair this phone with a private machine from the code the machine printed.
    /// `expectMachineId`: the machine the person is looking at, so a wrong scan
    /// cannot silently pair another.
    @discardableResult
    func pair(code: String, expectMachineId: String? = nil) throws -> String {
        let paired = try keyRing.add(code: code, expectMachineId: expectMachineId)
        e2eeStale.remove(paired.machineId)
        // Everything that arrived before was a placeholder (or a hub's invention): drop it
        // before the key change is published, then read it again.
        reconnectForKeyChange(scrub: paired.machineId)
        return paired.machineId
    }

    /// Forget every key of a machine: this phone can no longer read it.
    @discardableResult
    func forgetKey(machineId: String) -> Bool {
        guard keyRing.forget(machineId: machineId) else {
            flashError("Не удалось удалить ключ из Keychain.")
            return false
        }
        e2eeStale.remove(machineId)
        reconnectForKeyChange(scrub: machineId)
        return true
    }

    func requestPairing(machineId: String?) {
        let name = machineId.flatMap { machineInfo($0)?.name }
        pairRequest = PairRequest(machineId: machineId, machineName: name)
    }

    // MARK: Bookkeeping of what this phone itself asked for

    internal func rememberRunMachine(_ runId: String, _ machineId: String) {
        if e2eeRunMachine.count > 2000 { e2eeRunMachine.removeAll() }
        e2eeRunMachine[runId] = machineId
    }

    /// First sight of a machine's private flag: what this phone cached before (transcripts,
    /// generated names) is plaintext that must not outlive it. Once per launch.
    internal func purgePrivateTraces(_ machineId: String, incoming: [SessionSummary] = []) {
        guard e2eePurged.insert(machineId).inserted else { return }
        purgeDiskTraces(machineId, incoming: incoming)
    }

    internal func purgeDiskTraces(_ machineId: String, incoming: [SessionSummary] = []) {
        let known = allMachines.first { $0.machine.machineId == machineId }?.sessions ?? []
        var seen = Set<String>()
        let sessions = (known + incoming).filter { seen.insert($0.sessionId).inserted }
        navigationTitles.purge(machineId: machineId, sessions: sessions)
        let cache = transcripts
        Task { await cache.purge(machineId: machineId) }
    }

    /// Every machine a frame could be for, not just the first: the one it names, the one its
    /// run or terminal belongs to by this phone's record, the one the hub's list says.
    internal func e2eeMachines(of msg: ClientMessage) -> [String] {
        switch msg {
        case let .open(machineId, _, _, _), let .newSession(machineId, _, _, _, _, _, _, _, _),
             let .takeover(machineId, _, _), let .rpcRequest(_, machineId, _, _):
            return [machineId]
        case let .input(runId, _, _), let .toolDecision(runId, _, _, _, _, _), let .setPermissionMode(runId, _):
            return e2eeMachine(forRun: runId)
        case let .termInput(termId, _):
            return e2eeTermMachine[termId].map { [$0] } ?? []
        default:
            return []
        }
    }

    /// For a failed send that carries words to a private machine: put them back in memory.
    internal func privateSendRecovery(_ msg: ClientMessage) -> (() -> Void)? {
        let machines = e2eeMachines(of: msg)
        let unplaced = machines.isEmpty && msg.carriesContent
            && (!keyRing.snapshot.isEmpty || allMachines.contains { $0.machine.isPrivate })
        guard machines.contains(where: { isPrivateMachine($0) }) || unplaced else { return nil }
        let failed: FailedPrivateSend
        switch msg {
        case let .input(runId, text, images):
            guard let target = activeRuns.first(where: { $0.runId == runId }).map({ ($0.machineId, $0.sessionId) })
                    ?? (active?.runId == runId ? active.map { ($0.machineId, $0.sessionId) } : nil) else { return { [weak self] in
                        self?.flashError("Сообщение не отправлено. Наберите его ещё раз.") } }
            failed = FailedPrivateSend(scope: storageScope, machineId: target.0, sessionId: target.1, text: text, images: images ?? [])
        case let .open(machineId, sessionId, text, images):
            guard !(text ?? "").isEmpty || !(images ?? []).isEmpty else { return {} }
            failed = FailedPrivateSend(scope: storageScope, machineId: machineId, sessionId: sessionId, text: text ?? "", images: images ?? [])
        default:
            return nil
        }
        return { [weak self] in
            guard let self else { return }
            self.failedPrivate.append(failed)
            self.flashError("Сообщение в зашифрованную машину не отправлено — текст вернётся в поле ввода.")
        }
    }

    /// The machine a run belongs to: by what this phone opened first, then by the
    /// focused run, then by the hub's run list.
    internal func e2eeMachine(forRun runId: String) -> [String] {
        var found: [String] = []
        if let m = e2eeRunMachine[runId] { found.append(m) }
        if let a = active, a.runId == runId { found.append(a.machineId) }
        if let m = e2eeRunIndex[runId] { found.append(m) }
        return found
    }

    /// The machine a frame is addressed to, for the places that only need one answer.
    internal func e2eeTarget(of msg: ClientMessage) -> String? {
        switch msg {
        case let .open(machineId, _, _, _), let .newSession(machineId, _, _, _, _, _, _, _, _),
             let .takeover(machineId, _, _), let .rpcRequest(_, machineId, _, _):
            return machineId
        case let .input(runId, _, _), let .toolDecision(runId, _, _, _, _, _), let .setPermissionMode(runId, _):
            return e2eeMachine(forRun: runId).first
        case let .termInput(termId, _):
            return e2eeTermMachine[termId]
        default:
            return nil
        }
    }

    /// Whether an answer typed into a notification may go to the hub as is, over a
    /// one-shot connection that cannot seal it. Not for a private machine - and not
    /// when the run cannot be placed on a machine while this phone holds keys or
    /// knows a private machine (fail closed).
    internal func pushMayLeaveInClear(runId: String) -> Bool {
        let machines = e2eeMachine(forRun: runId)
        if machines.contains(where: { isPrivateMachine($0) }) { return false }
        if machines.isEmpty, !keyRing.snapshot.isEmpty || allMachines.contains(where: { $0.machine.isPrivate }) { return false }
        return true
    }

    // MARK: Inbound

    /// What opens an incoming frame, when it has anything to open (or must be
    /// checked for clear content next to a key); nil for every ordinary frame.
    internal func e2eeInbound(for text: String) -> E2eeInbound? {
        let keys = keyRing.snapshot
        let carries = E2ee.mayCarryE2e(text)
        let runFrame = E2eeInbound.needsInspection(text, hasKeys: !keys.isEmpty)
        guard carries || runFrame else { return nil }
        var inbound = E2eeInbound(keys: keys)
        inbound.runIndex = e2eeRunIndex
        inbound.runMachine = e2eeRunMachine
        if let a = active, let r = a.runId, inbound.runMachine[r] == nil { inbound.runMachine[r] = a.machineId }
        inbound.rpc = e2eeRpcMachine
        inbound.rpcMethod = e2eeRpcMethod
        inbound.term = e2eeTermMachine
        inbound.mirror = e2eeMirrorMachine
        return inbound
    }

    // MARK: Outbound

    /// The JSON to put on the wire for `msg`, sealed where it must be, or nil when
    /// it must not be sent at all (the person is told why unless `quiet`).
    internal func e2eeWire(_ original: ClientMessage, quiet: Bool) -> String? {
        var msg = original
        // A private machine's folder is content: the agent finds it from the
        // session id in its own inventory, so none goes to the hub.
        if case let .mirrorOpen(mirrorId, machineId, sessionId, _) = original, isPrivateMachine(machineId) {
            msg = .mirrorOpen(mirrorId: mirrorId, machineId: machineId, sessionId: sessionId, cwd: "")
        }
        switch msg {
        case let .rpcRequest(requestId, machineId, method, _):
            if e2eeRpcMachine.count > 5000 { e2eeRpcMachine.removeAll(); e2eeRpcMethod.removeAll() }
            e2eeRpcMachine[requestId] = machineId
            e2eeRpcMethod[requestId] = method
        case let .termOpen(termId, machineId, _):
            e2eeTermMachine[termId] = machineId
        case let .mirrorOpen(mirrorId, machineId, _, _):
            e2eeMirrorMachine[mirrorId] = machineId
        case let .enrichRequest(_, machineId, _, _, _, _, _, _, _):
            // A suggestion would send the conversation to a model: never from a private machine.
            if isPrivateMachine(machineId) { return nil }
        default:
            break
        }
        let data: Data
        do { data = try JSONEncoder().encode(msg) } catch {
            flashError("Не удалось подготовить сообщение.")
            return nil
        }
        let plain = String(decoding: data, as: UTF8.self)
        let keys = keyRing.snapshot
        let flagged = Set(allMachines.filter { $0.machine.isPrivate }.map { $0.machine.machineId })
        guard msg.carriesContent, !(keys.isEmpty && flagged.isEmpty),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? E2ee.Obj else { return plain }

        var candidates = Set<String>()
        if let id = frame["machineId"] as? String, !id.isEmpty { candidates.insert(id) }
        if let run = frame["runId"] as? String, !run.isEmpty { e2eeMachine(forRun: run).forEach { candidates.insert($0) } }
        if let term = frame["termId"] as? String, let m = e2eeTermMachine[term] { candidates.insert(m) }

        var epochs: [String: String] = [:]
        for snap in allMachines { if let e = snap.machine.e2eEpoch { epochs[snap.machine.machineId] = e } }
        let outbound = E2eeOutbound(keys: keys, privateMachines: flagged, epochs: epochs)
        switch outbound.decide(frame, candidates: candidates) {
        case .plain:
            return plain
        case let .refuse(why):
            if !quiet { flashError(why) }
            return nil
        case let .needKey(machineId):
            if !quiet {
                flashError("Эта машина зашифрована — введите код пары, чтобы работать в ней.")
                requestPairing(machineId: machineId)
            }
            return nil
        case let .seal(machineId):
            do {
                let sealed = try outbound.seal(frame, machineId: machineId)
                let out = try JSONSerialization.data(withJSONObject: sealed, options: [.withoutEscapingSlashes])
                return String(decoding: out, as: UTF8.self)
            } catch {
                if !quiet {
                    flashError((error as? E2eeOutbound.SealError)?.errorDescription
                               ?? "Не удалось зашифровать сообщение — оно не отправлено.")
                }
                return nil
            }
        }
    }
}
