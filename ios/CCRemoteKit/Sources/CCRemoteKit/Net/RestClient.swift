import Foundation
import os

/// The hub's HTTP surface, which the app could not reach at all while it
/// authenticated with a shared device token: identity (`/api/me`), the shared
/// gateway quota, and the workspace endpoints. Everything rides the same
/// workspace session as the WebSocket, presented as `Authorization: Bearer`.
@MainActor
public final class RestClient {
    public init() {}
    private let session = URLSession(configuration: .default)
    private let log = Logger(subsystem: "net.hegai.ccremote", category: "rest")

    /// Base origin (https) + the session token. Both come from AppSettings.
    public var base: URL?
    public var token: String = ""

    public func configure(hubURL: String, token: String) {
        self.base = HegaiAuth.apiBase(hubURL: hubURL)
        self.token = token
    }

    public var isConfigured: Bool { base != nil && !token.isEmpty }

    /// One transport for every verb. Mirrors the web's `teamApi.request`: JSON
    /// content-type whenever a body rides along, non-2xx surfaces the hub's own
    /// `{"error": …}` text, 204 comes back as empty data.
    private func send(_ method: String, _ path: String, body: Data?, timeout: TimeInterval = 15) async throws -> Data {
        let (data, status) = try await perform(method, path, body: body, timeout: timeout)
        guard (200..<300).contains(status) else { throw ClientError.rpc(Self.failureText(data, status: status)) }
        return status == 204 ? Data() : data
    }

    /// The transport under `send`, with the status handed back instead of
    /// thrown.
    ///
    /// `path` may carry a `?query`, which must already be percent-encoded:
    /// `appendingPathComponent` would turn the `?` into `%3F` and the hub would
    /// look for a route named `x?limit=…`.
    private func perform(_ method: String, _ path: String, body: Data?, timeout: TimeInterval = 15) async throws -> (Data, Int) {
        guard let base else { throw ClientError.rpc("hub URL is not configured") }
        let url: URL
        if let q = path.firstIndex(of: "?") {
            var comps = URLComponents(url: base.appendingPathComponent(String(path[..<q])),
                                      resolvingAgainstBaseURL: false)
            comps?.percentEncodedQuery = String(path[path.index(after: q)...])
            guard let withQuery = comps?.url else { throw ClientError.rpc("bad URL: \(path)") }
            url = withQuery
        } else {
            url = base.appendingPathComponent(path)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = timeout
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.rpc("no response")
        }
        return (data, http.statusCode)
    }

    private static func failureText(_ data: Data, status: Int) -> String {
        struct ErrorBody: Decodable { let error: String? }
        let hubText = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
        return hubText ?? "HTTP \(status)"
    }

    public func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let data = try await send("GET", path, body: nil)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The body as is — for a page the hub serves raw (a report's HTML, up to
    /// 100 MB, hence the longer wait than the JSON calls get).
    public func getData(_ path: String) async throws -> Data {
        try await send("GET", path, body: nil, timeout: 60)
    }

    @discardableResult
    public func post(_ path: String) async throws -> Bool {
        _ = try await send("POST", path, body: Data("{}".utf8))
        return true
    }

    public func post<B: Encodable, T: Decodable>(_ path: String, body: B, as type: T.Type) async throws -> T {
        let data = try await send("POST", path, body: try JSONEncoder().encode(body))
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Void POST. The hub expects a JSON body on every mutating call (the web
    /// always sends `'{}'`), so an empty object goes out even with no payload.
    public func post<B: Encodable>(_ path: String, body: B) async throws {
        _ = try await send("POST", path, body: try JSONEncoder().encode(body))
    }

    public func patch<B: Encodable>(_ path: String, body: B) async throws {
        _ = try await send("PATCH", path, body: try JSONEncoder().encode(body))
    }

    public func delete(_ path: String) async throws {
        _ = try await send("DELETE", path, body: Data("{}".utf8))
    }

    /// An `Encodable` "{}" for bodiless mutations.
    public struct EmptyBody: Encodable, Sendable {
        public init() {}
    }

    // MARK: Typed calls

    public func me() async throws -> ViewerContext {
        try await get("api/me", as: ViewerContext.self)
    }

    /// Shared Codex subscription quota — one figure for the whole team, so it is
    /// NOT per-machine usage and arrives over HTTP rather than the socket.
    public func gatewayQuota() async -> UsageInfo? {
        do {
            let payload = try await get("api/gateway-quota", as: GatewayQuotaResponse.self)
            return payload.gatewayQuota?.asUsage
        } catch {
            log.debug("gateway quota unavailable: \(String(describing: error))")
            return nil
        }
    }

    public func logout() async {
        _ = try? await post("api/logout")
    }
}

// MARK: - Wire shapes

private struct GatewayQuotaResponse: Decodable {
    let gatewayQuota: GatewayQuota?
}

/// `/api/gateway-quota` is snake_case and its timestamps are epoch **seconds**,
/// unlike everything on the WebSocket (milliseconds) — convert once, here.
struct GatewayQuota: Decodable {
    var ok: Bool?
    var plan: String?
    var primary_used_percent: Double?
    var primary_window_minutes: Double?
    var primary_reset_at: Double?
    var secondary_used_percent: Double?
    var secondary_window_minutes: Double?
    var secondary_reset_at: Double?
    var updated_at: Double?

    static func windowLabel(_ minutes: Double) -> String {
        switch minutes {
        case 300: return "5 часов"
        case 1440: return "День"
        case 10_080: return "Неделя"
        default:
            if minutes.truncatingRemainder(dividingBy: 1440) == 0 { return "\(Int(minutes / 1440)) д" }
            if minutes.truncatingRemainder(dividingBy: 60) == 0 { return "\(Int(minutes / 60)) ч" }
            return "\(Int(minutes)) мин"
        }
    }

    var asUsage: UsageInfo? {
        guard ok == true else { return nil }
        var limits: [UsageLimit] = []
        func add(_ key: String, _ percent: Double?, _ windowMinutes: Double?, _ resetAt: Double?) {
            guard let windowMinutes, windowMinutes.isFinite, windowMinutes > 0, let percent, percent.isFinite else { return }
            let weekly = windowMinutes >= 10_080
            limits.append(UsageLimit(
                key: key,
                label: Self.windowLabel(windowMinutes),
                group: weekly ? "weekly" : "session",
                percent: percent,
                resetsAt: resetAt.map { $0 * 1000 },
                active: nil
            ))
        }
        add("primary", primary_used_percent, primary_window_minutes, primary_reset_at)
        add("secondary", secondary_used_percent, secondary_window_minutes, secondary_reset_at)
        guard !limits.isEmpty else { return nil }
        return UsageInfo(limits: limits, fiveHour: nil, sevenDay: nil, account: nil,
                         subscription: plan, updatedAt: (updated_at ?? 0) * 1000)
    }
}
