import Foundation

/// An arbitrary JSON value — used for `tool_request.input`, `rpc_request.params`,
/// and `rpc_response.result`, whose shapes vary per tool / RPC method. Decodes
/// losslessly and can be re-decoded into a concrete `Decodable` via `decode(as:)`.
public enum JSONValue: Codable, Hashable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unrecognized JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }

    /// Re-decode this value into a concrete Decodable type (roundtrip through JSON).
    public func decode<T: Decodable>(as type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// `decode(as:)` off the caller's actor. A `session.messages` reply is 1-2 MB:
    /// re-encoding and decoding it on the main actor (where `CentralClient` lives)
    /// dropped frames. `JSONValue` and `T` are `Sendable`, so the value crosses the
    /// executor boundary by copy. A detached task does not inherit cancellation,
    /// so callers re-check `Task.checkCancellation()` after awaiting.
    public func decodeOffMain<T: Decodable & Sendable>(as type: T.Type) async throws -> T {
        let value = self
        return try await Task.detached(priority: .userInitiated) {
            try value.decode(as: T.self)
        }.value
    }

    // MARK: Convenience accessors
    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }

    /// Pretty-printed JSON (sorted keys) — for the tool-approval inspector.
    public var prettyString: String {
        guard let data = try? JSONEncoder.pretty.encode(self),
              let s = String(data: data, encoding: .utf8) else { return "" }
        return s
    }
}

public extension JSONEncoder {
    public static let pretty: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
}
