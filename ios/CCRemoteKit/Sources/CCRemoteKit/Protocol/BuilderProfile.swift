import Foundation

/// A {name, count} row — language and skill leaderboards.
public struct NamedCount: Codable, Hashable, Sendable {
    public let name: String
    public let count: Double
    public init(name: String, count: Double) {
        self.name = name
        self.count = count
    }
}

/// Locally-computed "how you build with AI" profile (mirror `BuilderProfile`
/// in shared/src/protocol.ts). Computed on the agent machine from its own
/// transcripts; nothing leaves the machine but these aggregates.
///
/// Every numeric field is `Double`: zod's `z.number()` promises nothing about
/// integrality, and several aggregates are genuinely fractional.
public struct BuilderProfile: Codable, Hashable, Sendable {
    public let machine: String
    public var machineId: String?
    /// Epoch ms the scan ran.
    public let generatedAt: Double
    public let transcriptsScanned: Double
    public let sessions: Double
    public let messages: Messages
    public let span: Span
    public let cadence: Cadence
    public let tools: Tools
    public let steering: Steering
    public let engineering: Engineering
    public let planning: Planning
    public let models: Models
    /// Each 0..10 — a documented function of the raw metrics (agent/src/profile.ts).
    public let scores: Scores
    public let archetype: Archetype

    public struct Messages: Codable, Hashable, Sendable {
        public let user: Double
        public let assistant: Double
    }
    public struct Span: Codable, Hashable, Sendable {
        public let firstTs: Double
        public let lastTs: Double
        public let activeDays: Double
        public let longestStreakDays: Double
    }
    public struct Cadence: Codable, Hashable, Sendable {
        /// Length 24, local hour.
        public let hourHistogram: [Double]
        /// Length 7, Sun..Sat.
        public let weekdayHistogram: [Double]
        /// 0..1 share of activity 22:00–05:00.
        public let nightOwlShare: Double
        public let avgSessionMessages: Double
        public let avgSessionMinutes: Double
    }
    public struct Tools: Codable, Hashable, Sendable {
        /// Tool name -> uses.
        public let counts: [String: Double]
        /// editWrite / (editWrite + readGrep), 0..1.
        public let buildVsExplore: Double
        public let testRunShare: Double
        public let gitOpShare: Double
        public let toolCallsPerSession: Double
    }
    public struct Steering: Codable, Hashable, Sendable {
        public let avgPromptChars: Double
        public let shortPromptShare: Double
        public let longPromptShare: Double
        public let followUpsPerSession: Double
    }
    public struct Engineering: Codable, Hashable, Sendable {
        public let filesTouched: Double
        public let topLanguages: [NamedCount]
        public let repos: Double
        public let branches: Double
    }
    public struct Planning: Codable, Hashable, Sendable {
        public let planModeShare: Double
        public let todoShare: Double
        public let topSkills: [NamedCount]
    }
    public struct Models: Codable, Hashable, Sendable {
        /// Model id -> assistant turns.
        public let histogram: [String: Double]
        public let avgModelsPerSession: Double
    }
    public struct Scores: Codable, Hashable, Sendable {
        public let steering: Double
        public let execution: Double
        public let engineering: Double
        public let planning: Double
        /// Deliberately-weak proxy (UI/doc/css work) — label it as such.
        public let product: Double
    }
    public struct Archetype: Codable, Hashable, Sendable {
        public let primary: String
        public let badges: [String]
    }
}
