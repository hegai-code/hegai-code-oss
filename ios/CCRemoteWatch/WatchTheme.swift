import SwiftUI

/// The iPhone tokens (ios/DESIGN.md) that translate to a black watch face: ivory
/// text, ember for "needs you", green for "working". Buttons are rounded
/// rectangles, never circles.
enum WatchTheme {
    static let ivory = Color(red: 0xFC / 255, green: 0xFA / 255, blue: 0xF1 / 255)
    static let ink = Color(red: 0x10 / 255, green: 0x1F / 255, blue: 0x18 / 255)
    static let ember = Color(red: 1.0, green: 0x7F / 255, blue: 0x57 / 255)
    static let working = Color(red: 0x5B / 255, green: 0xD4 / 255, blue: 0x77 / 255)
    static let muted = ivory.opacity(0.65)
    static let chip = ivory.opacity(0.14)

    static func color(forState state: String) -> Color {
        switch state {
        case "needs_attention": return ember
        case "working": return working
        case "error": return Color.red
        default: return muted
        }
    }
}

/// Full-width rounded-rectangle button used for every action.
struct WatchButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .multilineTextAlignment(.leading)
            .foregroundStyle(prominent ? WatchTheme.ink : WatchTheme.ivory)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(prominent ? WatchTheme.ivory : WatchTheme.chip,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
