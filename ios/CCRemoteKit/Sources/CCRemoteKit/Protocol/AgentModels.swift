import Foundation

/// «OpenCode» is not a runtime. On the wire it is a Codex session whose model id
/// starts with `pool-go/` (agent/src/opencode-go.ts); the third start-screen
/// segment is a client-side view over the Codex model list. These helpers are
/// the one place that knows the prefix.
public enum AgentModels {
    /// Client-local choice value; never sent (the wire source is "codex").
    public static let opencode = "opencode"
    public static let goPrefix = "pool-go/"
    /// Preferred Go model when the pick is missing or no longer listed.
    public static let preferredGoModel = "pool-go/glm-5.3"

    public static func isGoModel(_ id: String?) -> Bool {
        id?.hasPrefix(goPrefix) == true
    }

    public static func hasGoRows(_ models: [ModelInfoLite]) -> Bool {
        models.contains { isGoModel($0.id) }
    }

    /// The Codex list narrowed to one agent: "opencode" keeps only Go rows,
    /// anything else ("codex") keeps only the non-Go rows. A Claude list has no
    /// Go rows, so it passes through the non-Go branch unchanged.
    public static func rows(_ models: [ModelInfoLite], for agent: String) -> [ModelInfoLite] {
        agent == opencode
            ? models.filter { isGoModel($0.id) }
            : models.filter { !isGoModel($0.id) }
    }

    /// The model an OpenCode start must send: the remembered pick while it is
    /// still a listed Go row, else `preferredGoModel` when listed, else the
    /// first Go row. Nil only when the list has no Go rows at all.
    public static func defaultGoModel(models: [ModelInfoLite], remembered: String?) -> String? {
        let go = rows(models, for: opencode)
        if let remembered, go.contains(where: { $0.id == remembered }) { return remembered }
        if go.contains(where: { $0.id == preferredGoModel }) { return preferredGoModel }
        return go.first?.id
    }
}
