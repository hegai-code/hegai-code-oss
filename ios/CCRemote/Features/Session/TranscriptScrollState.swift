import SwiftUI

/// Layout growth is not reader intent. Only a vertical drag detaches following;
/// returning to the bottom or pressing Down attaches it again.
struct TranscriptScrollState {
    private(set) var followsTail = true
    private(set) var dragging = false
    private(set) var gap: CGFloat = 0
    var atBottom: Bool { gap <= 60 }

    mutating func moved(gap: CGFloat) {
        self.gap = gap
        if !dragging && atBottom { followsTail = true }
    }
    mutating func drag(dx: CGFloat, dy: CGFloat) {
        guard abs(dy) > abs(dx), abs(dy) > 4 else { return }
        dragging = true
        followsTail = false
    }
    mutating func endDrag() {
        guard dragging else { return }
        dragging = false
        followsTail = atBottom
    }
    mutating func follow() { followsTail = true }
    mutating func detach() { followsTail = false }
}

extension View {
    @ViewBuilder func transcriptAnchor(following: Bool) -> some View {
        if #available(iOS 18.0, *) {
            self.defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(following ? .bottom : nil, for: .sizeChanges)
                .defaultScrollAnchor(.bottom, for: .alignment)
        } else {
            self.defaultScrollAnchor(.bottom)
        }
    }
}
