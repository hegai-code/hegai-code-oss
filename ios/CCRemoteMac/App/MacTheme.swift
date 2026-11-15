import SwiftUI

/// These keep the existing compact AppKit chrome pixel-identical while removing
/// visual literals from individual controls.
extension Theme {
    static let macCategoryMarkRadius: CGFloat = 1.5
    static let macKeycapRadius: CGFloat = 4
    static let macCompactControlRadius: CGFloat = 5
    static let macPaletteScrim = Color.black.opacity(0.25)
    static let macPaletteShadow = Color.black.opacity(0.35)
    static let macPaletteShadowRadius: CGFloat = 28
}
