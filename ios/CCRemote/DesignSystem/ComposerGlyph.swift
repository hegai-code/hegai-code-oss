import SwiftUI

/// Shared 24pt optical box and rounded stroke for the composer's controls.
struct ComposerGlyph: View {
    enum Symbol { case plus, microphone }
    let symbol: Symbol

    var body: some View {
        Path { path in
            switch symbol {
            case .plus:
                path.move(to: CGPoint(x: 3, y: 12))
                path.addLine(to: CGPoint(x: 21, y: 12))
                path.move(to: CGPoint(x: 12, y: 3))
                path.addLine(to: CGPoint(x: 12, y: 21))
            case .microphone:
                path.addRoundedRect(in: CGRect(x: 9, y: 1.5, width: 6, height: 13),
                                    cornerSize: CGSize(width: 3, height: 3))
                path.move(to: CGPoint(x: 5.5, y: 10.5))
                path.addLine(to: CGPoint(x: 5.5, y: 12.5))
                path.addCurve(to: CGPoint(x: 18.5, y: 12.5),
                              control1: CGPoint(x: 5.5, y: 21), control2: CGPoint(x: 18.5, y: 21))
                path.addLine(to: CGPoint(x: 18.5, y: 10.5))
                path.move(to: CGPoint(x: 12, y: 19))
                path.addLine(to: CGPoint(x: 12, y: 22.5))
                path.move(to: CGPoint(x: 9, y: 22.5))
                path.addLine(to: CGPoint(x: 15, y: 22.5))
            }
        }
        .stroke(style: StrokeStyle(lineWidth: 1.9, lineCap: .round, lineJoin: .round))
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
    }
}
