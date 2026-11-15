import Foundation

public struct PendingRelease: Codable, Equatable {
    public var version: String
    public var sha256: String
    public var url: String?
    public var commit: String?
    public var createdAt: String?
    public var signed: Bool

    public init(version: String, sha256: String, url: String? = nil, commit: String? = nil, createdAt: String? = nil, signed: Bool) {
        self.version = version; self.sha256 = sha256; self.url = url
        self.commit = commit; self.createdAt = createdAt; self.signed = signed
    }

    public var shortCommit: String { commit.map { String($0.prefix(7)) } ?? "—" }

    /// The hub's url, or the conventional external-bundle location when it is absent.
    public var bundleURL: String { url ?? "https://\(HubClient.host)/dl/external/\(version)/agent-external.mjs" }

    /// Strict validation of what the hub sent before it is shown or used.
    public func validate() throws {
        guard Format.isValidVersion(version) else { throw SignerError.badPending("version") }
        guard Format.isHex64(sha256) else { throw SignerError.badPending("sha256") }
        _ = try HubClient.checkedBundleURL(bundleURL)
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)  // surface the 3xx as the final response; callers reject it
    }
}

public final class HubClient {
    public static let host = "code.acme.test"
    public static let maxBundle = 32 * 1024 * 1024
    let base: URL
    let session: URLSession
    private let delegate = NoRedirect()

    public init(base: URL = URL(string: "https://code.acme.test")!) {
        self.base = base
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 300
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    }

    public static func checkedBundleURL(_ s: String) throws -> URL {
        guard let u = URL(string: s), u.scheme == "https", u.host == host, u.user == nil, u.password == nil,
              u.port == nil || u.port == 443 else { throw SignerError.badURL(s) }
        return u
    }

    private func fail(_ e: Error) -> SignerError { (e as? SignerError) ?? .network(e.localizedDescription) }

    public func fetchPending() async throws -> PendingRelease? {
        do {
            var req = URLRequest(url: base.appendingPathComponent("api/release-signing/pending"))
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw SignerError.network("нет ответа") }
            if http.statusCode == 204 { return nil }
            guard http.statusCode == 200 else { throw SignerError.hubStatus(http.statusCode, Self.text(data)) }
            guard let p = try? JSONDecoder().decode(PendingRelease.self, from: data) else {
                throw SignerError.badPending("не разобрать JSON")
            }
            try p.validate()
            return p
        } catch { throw fail(error) }
    }

    public func download(_ urlString: String) async throws -> Data {
        let url = try Self.checkedBundleURL(urlString)
        do {
            let (bytes, resp) = try await session.bytes(from: url)
            guard let http = resp as? HTTPURLResponse else { throw SignerError.network("нет ответа") }
            guard http.statusCode == 200 else { throw SignerError.hubStatus(http.statusCode, "загрузка сборки") }
            if http.expectedContentLength > Int64(Self.maxBundle) { throw SignerError.tooLarge }
            var out = Data()
            for try await b in bytes {
                out.append(b)
                if out.count > Self.maxBundle { throw SignerError.tooLarge }
            }
            return out
        } catch { throw fail(error) }
    }

    public func postSignature(version: String, sha256: String, signature: Data) async throws {
        do {
            var req = URLRequest(url: base.appendingPathComponent("api/release-signing/signature"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: [
                "version": version, "sha256": sha256, "signature": signature.base64EncodedString(),
            ])
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw SignerError.network("нет ответа") }
            guard http.statusCode == 200 else { throw SignerError.hubStatus(http.statusCode, Self.text(data)) }
            // A 200 that is not the hub's acknowledgement (a proxy page) is not success.
            let ack = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            guard ack?["ok"] as? Bool == true else { throw SignerError.hubStatus(http.statusCode, Self.text(data)) }
        } catch { throw fail(error) }
    }

    static func text(_ d: Data) -> String { String(String(decoding: d.prefix(300), as: UTF8.self)) }
}
