#if DEBUG
import UIKit

/// Opt-in diagnostic: main-run-loop frame opportunities after the real button
/// action. Not a GPU/presentation latency measurement; use Instruments on-device
/// for render hitches. Writes only after the measured interval has finished.
@MainActor
final class DrawerPerformanceProbe: NSObject {
    static let shared = DrawerPerformanceProbe()
    static var shelfBuilds = 0
    static var drawerBodies = 0
    private var link: CADisplayLink?
    private var start = 0.0
    private var initialBuilds = 0
    private var ticks: [Double] = []
    private var samples: [[String: Any]] = []
    private var dragEvents: [[String: Double]] = []

    func dragChanged(dx: Double, time: Double) {
        guard ProcessInfo.processInfo.environment["CC_DRAWER_METRICS"] == "1" else { return }
        dragEvents.append(["dx": dx, "time": time, "received": CACurrentMediaTime(),
                           "drawerBodies": Double(Self.drawerBodies)])
    }

    func dragEnded() {
        guard !dragEvents.isEmpty else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("drawer-drag.json")
        if let data = try? JSONSerialization.data(withJSONObject: dragEvents, options: .prettyPrinted) {
            try? data.write(to: url, options: .atomic)
        }
        dragEvents = []
    }

    func begin() {
        guard ProcessInfo.processInfo.environment["CC_DRAWER_METRICS"] == "1", link == nil else { return }
        start = CACurrentMediaTime()
        initialBuilds = Self.shelfBuilds
        ticks = []
        let display = CADisplayLink(target: self, selector: #selector(frame))
        display.add(to: .main, forMode: .common)
        link = display
    }

    @objc private func frame() {
        let now = CACurrentMediaTime()
        ticks.append(now)
        guard now - start >= 0.5 else { return }
        link?.invalidate()
        link = nil
        let gaps = zip(ticks, ticks.dropFirst()).map { ($1 - $0) * 1000 }
        samples.append([
            "firstCallbackMs": (ticks[0] - start) * 1000,
            "maxFrameGapMs": gaps.max() ?? 0,
            "frameGapsMs": gaps,
            "shelfBuilds": Self.shelfBuilds - initialBuilds
        ])
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("drawer-metrics.json")
        if let data = try? JSONSerialization.data(withJSONObject: samples, options: .prettyPrinted) {
            try? data.write(to: url, options: .atomic)
        }
    }
}
#endif
