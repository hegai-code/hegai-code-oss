import Foundation

/// Resolves aliases without letting the literal "default" hide a real model.
public enum ModelLabel {
    public static func explicit(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value != "default" else { return nil }
        return value
    }

    public static func row(models: [ModelInfoLite], model: String?) -> ModelInfoLite? {
        guard let model = explicit(model) else { return nil }
        return models.first { $0.id != "default" && $0.id == model }
            ?? models.first { $0.id != "default" && $0.resolved == model }
    }

    public static func name(models: [ModelInfoLite], model: String?, activeModel: String? = nil) -> String {
        let id = explicit(model) ?? explicit(activeModel)
            ?? explicit(models.first { $0.id == "default" }?.resolved)
        guard let id else { return "Модель аккаунта" }
        if let hit = row(models: models, model: id)?.name { return hit }
        // `claude-opus-5-5[1m]` — та же модель с контекстом 1M: имя базовой
        // строки плюс пометка, а не сырой id.
        let (base, wide) = splitContext(id)
        let name = row(models: models, model: base)?.name ?? humanize(base) ?? id
        return wide ? "\(name) · 1M" : name
    }

    static func splitContext(_ id: String) -> (String, Bool) {
        id.hasSuffix("[1m]") ? (String(id.dropLast(4)), true) : (id, false)
    }

    /// `claude-opus-5-5` → `Opus 5.5`; nil, если id не похож на семейство Claude.
    static func humanize(_ id: String) -> String? {
        let parts = id.split(separator: "-").map(String.init)
        guard parts.count >= 3, parts[0] == "claude" else { return nil }
        let family = parts[1].prefix(1).uppercased() + parts[1].dropFirst()
        let version = parts.dropFirst(2).prefix { $0.allSatisfy(\.isNumber) && $0.count <= 2 }
        guard !version.isEmpty else { return nil }
        return "\(family) \(version.joined(separator: "."))"
    }
}
