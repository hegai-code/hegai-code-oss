import Foundation

/// What the hub's `/transcribe` came to.
///
/// `.failed` and `.unavailable` both leave the phone's own text in hand, but
/// they mean different things to the person: `.failed` is a service that may
/// answer a second later (a dead tunnel, a mobile network that drops new
/// connections, a busy card) — the recording is worth keeping for «Повторить»
/// and the phone's text must not go out on its own. `.unavailable` is a hub
/// that will say the same thing again (not configured, bad audio, signed out),
/// so retrying is pointless. 25.10.2026: a dictation sent during an 8-minute
/// spell when no new request reached the hub went out as the phone's text,
/// with everything said before a pause missing, and the audio was deleted.
public enum TranscribeOutcome: Equatable, Sendable {
    case text(String)
    /// The hub heard nothing in it.
    case silence
    case unavailable
    case failed

    /// (HTTP status, body) → outcome. Pure, so the mapping is testable without
    /// a network. A nil status is a transport failure or timeout.
    public static func map(status: Int?, body: Data?) -> TranscribeOutcome {
        guard let status else { return .failed }
        switch status {
        case 200:
            struct Answer: Decodable { let text: String }
            guard let body, let answer = try? JSONDecoder().decode(Answer.self, from: body) else { return .failed }
            let text = answer.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? .silence : .text(text)
        case 400, 401, 403, 413, 415:
            return .unavailable
        case 503:
            // Only the hub's own «not configured» is final; a 503 from a
            // proxy or an overloaded box passes.
            let said = body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            return said.contains("not configured") ? .unavailable : .failed
        default:
            // 429 (busy), 499, 502 (both engines refused), 504 and the relay's
            // own errors: worth another try.
            return .failed
        }
    }
}

extension RestClient {
    /// Server-side recognition — `POST /transcribe` (raw audio body, hub ASR:
    /// the GPU raced by a cloud engine). Far better than the phone's
    /// on-device recognizer on terms and punctuation.
    public func transcribe(fileURL: URL, contentType: String, project: String?) async -> TranscribeOutcome {
        guard let base, !token.isEmpty,
              var comps = URLComponents(url: base.appendingPathComponent("transcribe"), resolvingAgainstBaseURL: false)
        else { return .unavailable }
        // Same auth as `/polish`: the session token rides the query.
        var items = [URLQueryItem(name: "token", value: token)]
        if let project = project?.trimmingCharacters(in: .whitespacesAndNewlines), !project.isEmpty {
            items.append(URLQueryItem(name: "project", value: String(project.prefix(200))))
        }
        comps.queryItems = items
        guard let url = comps.url else { return .unavailable }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        // The hub answers only when done, and gives the card at most ~10 s
        // before the cloud engine runs alongside it. 45 s also covers a slow
        // mobile upload of a long recording.
        req.timeoutInterval = 45
        guard let (data, response) = try? await URLSession.shared.upload(for: req, fromFile: fileURL) else {
            return .failed
        }
        return TranscribeOutcome.map(status: (response as? HTTPURLResponse)?.statusCode, body: data)
    }
}
