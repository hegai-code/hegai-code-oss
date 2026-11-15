import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import CCRemoteKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Turns picked/shared images into small, wire-ready `ImageAttachment`s. Claude
/// samples images at ~1568px on the long edge, so anything larger is wasted
/// bytes over the WebSocket; we downscale to that and JPEG-compress. A phone
/// photo (~5 MB) lands around 150–400 KB, keeping the input frame cheap to relay.
///
/// The work happens on `CGImage` rather than each platform's image class: the
/// pixel path is identical on both, so only decoding and encoding need a branch.
extension ImageAttachment {
    /// The long-edge cap and JPEG quality used for every attachment.
    static let maxEdge: CGFloat = 1568
    static let jpegQuality: CGFloat = 0.6

    static func make(from image: PlatformImage) -> ImageAttachment? {
        guard let cg = image.asCGImage else { return nil }
        return make(fromCGImage: cg)
    }

    static func make(from data: Data) -> ImageAttachment? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return make(fromCGImage: cg)
    }

    /// An image chosen in a file picker or dragged in from Finder.
    ///
    /// The security scope is the whole trick. A URL handed over by either of
    /// those routes is scoped, and reading it without claiming access fails —
    /// silently, returning nil, which on screen is indistinguishable from
    /// "nothing happened when I dropped the file".
    static func make(fromFile url: URL) -> ImageAttachment? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return make(from: data)
    }

    /// The same, for a whole drop or a multi-selection. Files that are not
    /// decodable images are dropped rather than failing the batch: a Finder
    /// selection routinely carries one stray PDF.
    static func make(fromFiles urls: [URL]) -> [ImageAttachment] {
        urls.compactMap { make(fromFile: $0) }
    }

    private static func make(fromCGImage cg: CGImage) -> ImageAttachment? {
        let scaled = cg.scaledDown(maxEdge: maxEdge)
        guard let data = scaled.jpegData(quality: jpegQuality) else { return nil }
        return ImageAttachment(mediaType: "image/jpeg", data: data)
    }
}

extension CGImage {
    /// Aspect-preserving downscale so the longer edge is at most `maxEdge`.
    /// Never upscales; output pixel dimensions are exactly the target.
    func scaledDown(maxEdge: CGFloat) -> CGImage {
        let longest = CGFloat(max(width, height))
        guard longest > maxEdge, longest > 0 else { return self }
        let ratio = maxEdge / longest
        let target = CGSize(width: (CGFloat(width) * ratio).rounded(),
                            height: (CGFloat(height) * ratio).rounded())
        guard let context = CGContext(
            data: nil,
            width: Int(target.width), height: Int(target.height),
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return self }
        context.interpolationQuality = .high
        context.draw(self, in: CGRect(origin: .zero, size: target))
        return context.makeImage() ?? self
    }

    func jpegData(quality: CGFloat) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, self, [
            kCGImageDestinationLossyCompressionQuality: quality
        ] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}

extension PlatformImage {
    /// The one genuinely platform-shaped step: getting pixels out of the
    /// platform's image class.
    var asCGImage: CGImage? {
        #if canImport(UIKit)
        return cgImage
        #else
        var rect = CGRect(origin: .zero, size: size)
        return cgImage(forProposedRect: &rect, context: nil, hints: nil)
        #endif
    }
}
