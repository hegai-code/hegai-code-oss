import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import CCRemoteKit
#if canImport(UIKit)
import UIKit
#endif

/// Paperclip that offers the Photo Library, a file picker, or the camera, and
/// appends the downscaled result to `attachments`. Shared by the composer and
/// the new-session form so both attach images the same way.
struct AttachButton: View {
    @Binding var attachments: [ImageAttachment]
    var size: CGFloat = 36
    /// When false, the button is transparent (sits inside the composer pill).
    var filled: Bool = true

    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showLibrary = false
    @State private var showFiles = false
    @State private var showCamera = false

    /// Macs have no camera picker worth offering here — the built-in webcam is
    /// not what anyone attaches to a coding session.
    private var cameraAvailable: Bool {
        #if os(iOS)
        return UIImagePickerController.isSourceTypeAvailable(.camera)
        #else
        return false
        #endif
    }

    var body: some View {
        Menu {
            // Files first on a Mac. The Photo Library is the wrong door there —
            // a screenshot lives in Downloads or on the Desktop, and the Photos
            // library is usually empty, so the picker opened onto "Нет фото или
            // видео" and the attachment was simply unreachable. Reported from
            // the Mac app.
            #if os(macOS)
            Button { showFiles = true } label: { Label("Файлы…", systemImage: "folder") }
            Button { showLibrary = true } label: { Label("Медиатека", systemImage: "photo.on.rectangle") }
            #else
            Button { showLibrary = true } label: { Label("Медиатека", systemImage: "photo.on.rectangle") }
            Button { showFiles = true } label: { Label("Файлы…", systemImage: "folder") }
            #endif
            if cameraAvailable {
                Button { showCamera = true } label: { Label("Камера", systemImage: "camera") }
            }
        } label: {
            ComposerGlyph(symbol: .plus)
                .foregroundStyle(Theme.text)
                .frame(width: size, height: size)
                .background(filled ? Theme.surfaceSunken : Color.clear,
                            in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                // Рисуется на `size`, нажимается на 44: цель нажатия — это
                // отдельная величина от квадрата, который видно.
                .frame(width: max(size, Theme.tapTarget), height: max(size, Theme.tapTarget))
                .contentShape(Rectangle())
        }
        // AppKit draws a disclosure chevron next to every Menu label. Beside a
        // bare "+" that reads as a second, broken control — which is exactly how
        // it looked in the composer.
        .plainMenu()
        // …and even borderless, the AppKit menu control keeps its own intrinsic
        // height around the label, so in a bottom-aligned composer row the "+"
        // sank below the mic. Pin the OUTER geometry to the tap target.
        .frame(width: max(size, Theme.tapTarget), height: max(size, Theme.tapTarget))
        .accessibilityLabel("Вложение")
        .photosPicker(isPresented: $showLibrary, selection: $pickerItems,
                      maxSelectionCount: 4, matching: .images)
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await load(items) }
        }
        .fileImporter(isPresented: $showFiles,
                      allowedContentTypes: [.image],
                      allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            let picked = ImageAttachment.make(fromFiles: urls)
            guard !picked.isEmpty else { return }
            attachments.append(contentsOf: picked)
            Haptics.light()
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { attachments.append($0) }
                .ignoresSafeArea()
        }
        #endif
    }

    private func load(_ items: [PhotosPickerItem]) async {
        var picked: [ImageAttachment] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let att = ImageAttachment.make(from: data) {
                picked.append(att)
            }
        }
        await MainActor.run {
            attachments.append(contentsOf: picked)
            pickerItems = []
            if !picked.isEmpty { Haptics.light() }
        }
    }
}

/// Accept images dragged onto a composer — from Finder, from a browser, from
/// anywhere the system vends a file URL.
///
/// The menu alone was not enough: dragging a screenshot into the input is the
/// gesture people reach for first on a Mac, and the composer silently rejected
/// it. `isTargeted` drives a ring so the drop zone is visible while dragging;
/// an invisible target reads as "it doesn't take files".
struct AttachmentDrop: ViewModifier {
    @Binding var attachments: [ImageAttachment]
    @State private var targeted = false

    func body(content: Content) -> some View {
        content
            .dropDestination(for: URL.self) { urls, _ in
                let picked = ImageAttachment.make(fromFiles: urls)
                guard !picked.isEmpty else { return false }
                attachments.append(contentsOf: picked)
                Haptics.light()
                return true
            } isTargeted: { targeted = $0 }
            .overlay {
                if targeted {
                    RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous)
                        .stroke(Theme.focusRing, lineWidth: 2)
                        .allowsHitTesting(false)
                }
            }
    }
}

extension View {
    /// Make this composer accept dropped image files.
    func attachmentDrop(_ attachments: Binding<[ImageAttachment]>) -> some View {
        modifier(AttachmentDrop(attachments: attachments))
    }
}

/// Horizontal strip of attached-image thumbnails with a remove button on each.
/// Renders nothing when empty.
struct AttachmentStrip: View {
    @Binding var attachments: [ImageAttachment]
    var edge: CGFloat = 52

    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.s2) {
                    ForEach(attachments) { att in
                        thumb(att)
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func thumb(_ att: ImageAttachment) -> some View {
        if let img = PlatformImage(data: att.data) {
            Image(platformImage: img)
                .resizable()
                .scaledToFill()
                .frame(width: edge, height: edge)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSm))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm).stroke(Theme.border, lineWidth: 1))
                .overlay(alignment: .topTrailing) {
                    Button { attachments.removeAll { $0.id == att.id }; Haptics.light() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))  // бокс глифа
                            // Крестик лежит на ФОТОГРАФИИ человека, а не на
                            // поверхности темы: токен переворачивался бы вместе
                            // с ней и пропадал на половине снимков, тогда как
                            // белый глиф на чёрной подложке читается на любом.
                            .foregroundStyle(.white, Color.black.opacity(0.55))  // off-palette: поверх фотографии
                            .padding(2)
                    }
                    .accessibilityLabel("Убрать вложение")
                }
                // Картинка без подписи для VoiceOver — это ничто: прикреплено
                // или нет, вслух не отличить. Он же — якорь приёмки
                // (`LiveComposerUITests`): «вложение прикрепилось» иначе
                // проверяется тапом по координате превью.
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Вложение — картинка")
                .accessibilityIdentifier("composer.attachment")
        }
    }
}
