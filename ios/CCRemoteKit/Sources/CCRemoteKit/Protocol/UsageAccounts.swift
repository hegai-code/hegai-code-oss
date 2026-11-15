import Foundation

/// Web UsageMeter parity: newest reading per account, providers kept separate.
public struct UsageAccount: Identifiable, Sendable {
    public let id: String
    public let provider: String
    public var usage: UsageInfo
    public var machines: [String]
    public var peak: Double { usage.normalizedLimits.map(\.percent).filter(\.isFinite).max() ?? 0 }

    public static func collect(machines: [MachineSnapshot], gateway: UsageInfo?, budget: UsageInfo?) -> [UsageAccount] {
        var result: [UsageAccount] = []
        for provider in ["Claude", "Codex"] {
            var accounts: [String: UsageAccount] = [:]
            for machine in machines {
                // A machine with Claude switched off has no Claude limits, even
                // a reading cached from before the switch (web 0fb379f).
                if provider == "Claude" && machine.claudeOff { continue }
                guard let usage = provider == "Claude" ? machine.usage : machine.codexUsage,
                      !usage.normalizedLimits.isEmpty else { continue }
                let key = usage.account ?? "\(usage.subscription ?? "account"):\(usage.normalizedLimits.map { "\($0.key):\($0.resetsAt ?? 0)" }.joined(separator: "|"))"
                if var old = accounts[key] {
                    if !old.machines.contains(machine.machine.name) { old.machines.append(machine.machine.name) }
                    if usage.updatedAt > old.usage.updatedAt { old.usage = usage }
                    accounts[key] = old
                } else {
                    accounts[key] = UsageAccount(id: "\(provider):\(key)", provider: provider, usage: usage, machines: [machine.machine.name])
                }
            }
            result += accounts.values.sorted { $0.peak == $1.peak ? $0.id < $1.id : $0.peak > $1.peak }
        }
        if let gateway, !gateway.normalizedLimits.isEmpty {
            result.append(UsageAccount(id: "gateway", provider: "Gateway", usage: gateway, machines: []))
        }
        if let budget, !budget.normalizedLimits.isEmpty {
            result.insert(UsageAccount(id: "budget", provider: "Мой лимит", usage: budget, machines: []), at: 0)
        }
        return result
    }
}

public struct BudgetInfo: Decodable, Sendable {
    public let plan: String?
    public let limits: Limits?
    public struct Limits: Decodable, Sendable {
        let tokens: Double?
        let tokensUsed: Double?
        let tokensWindow: JSONValue?
        let requests: Double?
        let requestsUsed: Double?
        let requestsWindow: JSONValue?
        let resetAt: Double?
    }
    public var asUsage: UsageInfo? {
        guard plan == "community", let limits else { return nil }
        var rows: [UsageLimit] = []
        func add(_ key: String, _ label: String, _ cap: Double?, _ used: Double?, _ window: JSONValue?, reset: Double?) {
            guard let cap, cap.isFinite, cap > 0, let used, used.isFinite else { return }
            let suffix: String
            switch window {
            case .string(let value):
                let label = ["1d": "день", "7d": "неделя", "1h": "час", "5h": "5 ч"][value] ?? value
                suffix = " · \(label)"
            case .number(let seconds): suffix = " · \(Int(seconds / 3600)) ч"
            default: suffix = ""
            }
            rows.append(UsageLimit(key: key, label: label + suffix, group: key == "budget_tokens" ? "session" : "requests",
                                   percent: max(0, used / cap * 100), resetsAt: reset))
        }
        let reset = limits.resetAt.flatMap { $0 > 0 ? ($0 < 1e12 ? $0 * 1000 : $0) : nil }
        add("budget_tokens", "Токены", limits.tokens, limits.tokensUsed, limits.tokensWindow, reset: reset)
        add("budget_requests", "Запросы", limits.requests, limits.requestsUsed, limits.requestsWindow, reset: nil)
        return rows.isEmpty ? nil : UsageInfo(limits: rows, subscription: plan, updatedAt: Date().timeIntervalSince1970 * 1000)
    }
}
