import Foundation

/// What to do with a frame this phone is about to send (web: `privateTarget` and
/// `sealFrame` in useCentral.ts). The key ring decides, not the hub: a hub that
/// says "not private" must not make a phone that holds a machine's key type into
/// it in the clear. The hub's flag can only ADD a reason to seal.
public struct E2eeOutbound: Sendable {
    public enum Decision: Equatable, Sendable {
        /// Nothing to protect: send as is.
        case plain
        /// Seal for this machine (the key is held).
        case seal(machineId: String)
        /// The machine is private and this phone has no key: send nothing, offer pairing.
        case needKey(machineId: String)
        /// Fail closed: the frame cannot be placed on one machine.
        case refuse(String)
    }

    public enum SealError: LocalizedError {
        case noKey, noEpoch
        public var errorDescription: String? {
            switch self {
            case .noKey: return "Нет ключа этой машины."
            case .noEpoch: return "Машина ещё не сообщила свою эпоху - повторите через мгновение."
            }
        }
    }

    public var keys: E2eeKeys
    /// Machines the hub says are private.
    public var privateMachines: Set<String>
    /// Each machine's per-process epoch (`MachineInfo.e2eEpoch`).
    public var epochs: [String: String]

    public init(keys: E2eeKeys, privateMachines: Set<String>, epochs: [String: String]) {
        self.keys = keys; self.privateMachines = privateMachines; self.epochs = epochs
    }

    /// `candidates` is every machine the frame could be for: the one it names, the
    /// one its run / terminal belongs to by this phone's own record, and the one the
    /// hub's run list says. If ANY of them is a machine whose key this phone holds,
    /// the frame is sealed for it.
    public func decide(_ frame: E2ee.Obj, candidates: Set<String>) -> Decision {
        guard E2ee.needsSeal(frame) else { return .plain }
        let keyed = candidates.filter { keys.hasKey(for: $0) }
        if keyed.count > 1 { return .refuse("Хаб указал две зашифрованные машины для одного сообщения — оно не отправлено.") }
        if let one = keyed.first { return .seal(machineId: one) }
        if let flagged = candidates.sorted().first(where: { privateMachines.contains($0) }) { return .needKey(machineId: flagged) }
        // No candidate says private. With no candidate at all, only a frame that
        // really carries the person's words is held back (a mode switch or a bare
        // approval of an ordinary machine goes through).
        if candidates.isEmpty, !keys.isEmpty, E2ee.hasRealContent(frame) {
            return .refuse("Не удалось определить машину для зашифрованной отправки — сообщение не отправлено.")
        }
        return .plain
    }

    /// Seal for `machineId`. Throws rather than ever returning content in the clear.
    public func seal(_ frame: E2ee.Obj, machineId: String) throws -> E2ee.Obj {
        guard let k = keys.latest(for: machineId) else { throw SealError.noKey }
        guard let epoch = epochs[machineId], !epoch.isEmpty else { throw SealError.noEpoch }
        let sealer: E2ee.Sealer = { secret, bind in
            try E2eeCipher.seal(secret, key: k.key, kid: k.kid, bind: E2ee.withMachine(machineId, bind))
        }
        var out = try E2ee.sealFrame(frame, epoch: epoch, seal: sealer)
        if ["input", "open", "new_session", "takeover"].contains(E2ee.str(frame["type"])),
           let turn = E2ee.turnSecret(frame) {
            out["turnE2e"] = try sealer(turn, E2ee.turnEchoBind).json
        }
        return out
    }
}
