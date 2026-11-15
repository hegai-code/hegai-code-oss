// Creates bundle id net.hegai.signer + Developer ID (MAC_APP_DIRECT) profile via the ASC API.
// Usage: swift tools/asc-profile.swift <out.provisionprofile>   (run on the mini)
import CryptoKit
import Foundation

let home = NSHomeDirectory()
let pem = try! String(contentsOfFile: "\(home)/.appstoreconnect/private_keys/AuthKey_MTUNQ6ARKS.p8")
let kid = "MTUNQ6ARKS", iss = "a7b3038d-738d-4f94-81ec-00124cddfd4b"
func b64u(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
func jwt() -> String {
    let h = b64u(Data("{\"alg\":\"ES256\",\"kid\":\"\(kid)\",\"typ\":\"JWT\"}".utf8))
    let p = b64u(Data("{\"iss\":\"\(iss)\",\"exp\":\(Int(Date().timeIntervalSince1970) + 600),\"aud\":\"appstoreconnect-v1\"}".utf8))
    let k = try! P256.Signing.PrivateKey(pemRepresentation: pem)
    return "\(h).\(p).\(b64u(try! k.signature(for: Data("\(h).\(p)".utf8)).rawRepresentation))"
}
func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> (Int, [String: Any]) {
    var r = URLRequest(url: URL(string: "https://api.appstoreconnect.apple.com\(path)")!)
    r.httpMethod = method
    r.setValue("Bearer \(jwt())", forHTTPHeaderField: "Authorization")
    if let body { r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try! JSONSerialization.data(withJSONObject: body) }
    var out: (Int, [String: Any]) = (0, [:])
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: r) { d, resp, e in
        let j = (try? JSONSerialization.jsonObject(with: d ?? Data())) as? [String: Any] ?? ["raw": String(decoding: d ?? Data(), as: UTF8.self), "err": "\(String(describing: e))"]
        out = ((resp as? HTTPURLResponse)?.statusCode ?? 0, j); sem.signal()
    }.resume()
    sem.wait()
    return out
}
func die(_ s: String, _ j: Any) -> Never { print("FAIL \(s): \(j)"); exit(1) }

var (c, j) = call("GET", "/v1/bundleIds?filter[identifier]=net.hegai.signer")
guard c == 200 else { die("list bundleIds", j) }
var bundleId = ((j["data"] as? [[String: Any]])?.first { ($0["attributes"] as? [String: Any])?["identifier"] as? String == "net.hegai.signer" })?["id"] as? String
if bundleId == nil {
    (c, j) = call("POST", "/v1/bundleIds", ["data": ["type": "bundleIds", "attributes": ["identifier": "net.hegai.signer", "name": "Hegai Signer", "platform": "MAC_OS"]]])
    guard c == 201, let id = (j["data"] as? [String: Any])?["id"] as? String else { die("create bundleId", j) }
    bundleId = id
}
print("bundleId", bundleId!)
(c, j) = call("GET", "/v1/certificates?limit=200")
guard c == 200 else { die("list certificates", j) }
let certs = ((j["data"] as? [[String: Any]]) ?? []).filter { (($0["attributes"] as? [String: Any])?["certificateType"] as? String ?? "").hasPrefix("DEVELOPER_ID_APPLICATION") }; print("all types", ((j["data"] as? [[String: Any]]) ?? []).map { (($0["attributes"] as? [String: Any])?["certificateType"] as? String ?? "?") })
print("certs", certs.map { ($0["id"] as? String ?? "?") + ":" + ((($0["attributes"] as? [String: Any])?["displayName"] as? String) ?? "") })
guard let cert = certs.first?["id"] as? String else { die("no DEVELOPER_ID_APPLICATION certificate", j) }
(c, j) = call("POST", "/v1/profiles", ["data": ["type": "profiles",
    "attributes": ["name": "Hegai Signer DevID \(Int(Date().timeIntervalSince1970))", "profileType": "MAC_APP_DIRECT"],
    "relationships": ["bundleId": ["data": ["type": "bundleIds", "id": bundleId!]], "certificates": ["data": [["type": "certificates", "id": cert]]]]]])
guard c == 201, let content = ((j["data"] as? [String: Any])?["attributes"] as? [String: Any])?["profileContent"] as? String,
      let data = Data(base64Encoded: content) else { die("create profile", j) }
try! data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("OK profile written", data.count)
