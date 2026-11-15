import SwiftUI

/// Shared surface for the floating navigation controls and session identity.
extension View {
    func headerIsland() -> some View {
        background {
            Capsule(style: .continuous)
                .fill(Theme.composerBackground)
                .overlay { Capsule().strokeBorder(Theme.rim, lineWidth: 1) }
                .shadow(color: Theme.shadow.color, radius: Theme.shadow.radius, y: Theme.shadow.y)
        }
    }
}
