import Foundation
import UIKit
import CCRemoteKit

/// The iOS half of `BackgroundGrace`: a real `UIApplication` background assertion.
///
/// The expiration handler MUST end the task before it returns or iOS kills the
/// app, and it can fire while `CentralClient` still holds the token — so live
/// tokens are tracked here and `end` is idempotent. Ending the same identifier
/// twice is a hard error in UIKit, and that double-end is exactly what the naive
/// version of this class produces the moment an assertion expires on its own.
final class UIKitBackgroundGrace: BackgroundGrace, @unchecked Sendable {
    private let lock = NSLock()
    private var live: Set<Int> = []

    func begin(_ name: String) -> Int? {
        var id: UIBackgroundTaskIdentifier = .invalid
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            self?.end(id.rawValue)
        }
        guard id != .invalid else { return nil }
        lock.lock(); live.insert(id.rawValue); lock.unlock()
        return id.rawValue
    }

    func end(_ token: Int) {
        lock.lock()
        let owned = live.remove(token) != nil
        lock.unlock()
        guard owned else { return }
        UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: token))
    }
}
