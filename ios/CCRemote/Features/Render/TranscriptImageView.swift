import SwiftUI
import ImageIO
import CCRemoteKit

struct TranscriptImageSource: Hashable {
    let machineId: String
    let sessionId: String
    let source: String
}

private struct TranscriptImageSourceKey: EnvironmentKey {
    static let defaultValue: TranscriptImageSource? = nil
}

extension EnvironmentValues {
    var transcriptImageSource: TranscriptImageSource? {
        get { self[TranscriptImageSourceKey.self] }
        set { self[TranscriptImageSourceKey.self] = newValue }
    }
}

/// Bounded, memory-only thumbnails. Identity includes the account, machine,
/// session, runtime and ref; concurrent renderings share one request.
@MainActor
final class TranscriptImageStore {
    static let shared = TranscriptImageStore()
    struct Key: Hashable {
        let scope: String
        let source: TranscriptImageSource
        let ref: String
        var cacheKey: NSString {
            [scope, source.machineId, source.sessionId, source.source, ref]
                .map { "\($0.utf8.count):\($0)" }.joined() as NSString
        }
    }
    private let cache = NSCache<NSString, UIImage>()
    private var pending: [Key: Task<UIImage?, Never>] = [:]
    private var scope: String?

    init() { cache.totalCostLimit = 96 * 1024 * 1024; cache.countLimit = 40 }

    func load(_ key: Key, fetch: @escaping @MainActor () async throws -> SessionImageResult) async -> UIImage? {
        if scope != key.scope {
            pending.values.forEach { $0.cancel() }; pending.removeAll()
            cache.removeAllObjects(); scope = key.scope
        }
        if let image = cache.object(forKey: key.cacheKey) { return image }
        if let task = pending[key] {
            let image = await task.value
            return scope == key.scope && !task.isCancelled ? image : nil
        }
        let task = Task<UIImage?, Never> {
            guard let result = try? await fetch(), !Task.isCancelled,
                  result.mediaType.hasPrefix("image/"), result.dataB64.utf8.count <= 24 * 1024 * 1024 else { return nil }
            return await Task.detached(priority: .utility) {
                guard let data = Data(base64Encoded: result.dataB64),
                      let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 1600,
                        kCGImageSourceShouldCacheImmediately: true,
                      ] as CFDictionary) else { return nil }
                return UIImage(cgImage: image)
            }.value
        }
        pending[key] = task
        let image = await task.value
        guard scope == key.scope, !task.isCancelled else { return nil }
        pending[key] = nil
        if let image {
            let cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0)
            cache.setObject(image, forKey: key.cacheKey, cost: cost)
        }
        return image
    }
}

/// Attachments sit above the user's text, on the same trailing edge.
/// A fixed tile shape keeps tall screenshots readable without moving the scroll
/// anchor when image bytes arrive. The viewer always shows the whole picture.
struct TranscriptImageSeed {
    let key: TranscriptImageStore.Key
    let image: UIImage
}

struct TranscriptImageGallery: View {
    let refs: [String?]
    @State private var selected: Selection?
    private struct Selection: Identifiable { let id: Int; let seed: TranscriptImageSeed }

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Theme.s2),
                                 count: refs.count == 1 ? 1 : 2), spacing: Theme.s2) {
            ForEach(refs.indices, id: \.self) { index in
                TranscriptImageView(ref: refs[index], onOpen: { selected = Selection(id: index, seed: $0) })
                    .accessibilityHint("Изображение \(index + 1) из \(refs.count). Открыть целиком")
            }
        }
        .frame(maxWidth: refs.count == 1 ? 240 : 288)
        .accessibilityIdentifier("transcript.image.gallery")
        .fullScreenCover(item: $selected) { selection in
            TranscriptImageViewer(refs: refs, initialIndex: selection.id, seed: selection.seed)
        }
    }
}

struct TranscriptImageView: View {
    let ref: String?
    var fullSize = false
    var seed: TranscriptImageSeed? = nil
    var onOpen: ((TranscriptImageSeed) -> Void)? = nil
    /// Told once the bytes are on screen — the viewer's share button needs them.
    var onLoaded: ((UIImage) -> Void)? = nil
    @Environment(CentralClient.self) private var client
    @Environment(\.transcriptImageSource) private var source
    @State private var loaded: UIImage?
    @State private var loadedKey: TranscriptImageStore.Key?
    @State private var loading = false
    @State private var retry = 0
    @State private var showing = false

    private var key: TranscriptImageStore.Key? {
        guard let source, let ref, !ref.isEmpty else { return nil }
        return .init(scope: client.storageScope, source: source, ref: ref)
    }
    private var image: UIImage? {
        if loadedKey == key, let loaded { return loaded }
        return seed?.key == key ? seed?.image : nil
    }
    private var placeholderLabel: String {
        loading ? "Загрузка изображения…" : key == nil ? "Изображение недоступно" : "Повторить загрузку"
    }

    var body: some View {
        Group {
            if fullSize {
                if let image { ZoomableTranscriptImage(image: image) }
                else { placeholder.frame(maxWidth: .infinity, maxHeight: .infinity) }
            } else {
                Button {
                    if let image, let key {
                        if let onOpen { onOpen(.init(key: key, image: image)) } else { showing = true }
                        Haptics.light()
                    } else { retry += 1 }
                } label: {
                    GeometryReader { geometry in
                        if let image {
                            Image(uiImage: image).resizable().scaledToFill()
                                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
                                .clipped().accessibilityHidden(true)
                        } else { placeholderLabelView.frame(width: geometry.size.width, height: geometry.size.height) }
                    }
                    .aspectRatio(1, contentMode: .fit)
                    .background(Theme.chip)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg))
                    .overlay { RoundedRectangle(cornerRadius: Theme.radiusLg).strokeBorder(Theme.rim, lineWidth: 0.5) }
                    .contentShape(Rectangle())
                }
                .frame(maxWidth: 280)
                .buttonStyle(.plain).disabled(image == nil && (loading || key == nil))
                .accessibilityLabel(image != nil ? "Открыть изображение" : placeholderLabel)
                .accessibilityIdentifier(image != nil ? "transcript.image.\(ref ?? "")" : "transcript.image.placeholder.\(ref ?? "missing")")
            }
        }
        .task(id: key) { await load() }
        .task(id: retry) { if retry > 0 { await load() } }
        .fullScreenCover(isPresented: $showing) {
            TranscriptImageViewer(refs: [ref], initialIndex: 0,
                                  seed: loadedKey.flatMap { key in loaded.map { .init(key: key, image: $0) } })
        }
    }

    private var placeholderLabelView: some View {
        VStack(spacing: Theme.s2) {
            if loading { ProgressView() }
            else { Image(systemName: key == nil ? "photo" : "arrow.clockwise").font(.system(size: 22)) }
            Text(placeholderLabel).font(.system(.caption)).multilineTextAlignment(.center)
        }.foregroundStyle(Theme.textMuted).padding(Theme.s3)
    }
    private var placeholder: some View {
        Button { retry += 1 } label: { placeholderLabelView }
            .buttonStyle(.plain).disabled(loading || key == nil)
    }

    private func load() async {
        guard let key else { loaded = nil; loadedKey = nil; return }
        if let seed, seed.key == key {
            loaded = seed.image; loadedKey = key; loading = false
            onLoaded?(seed.image)
            return
        }
        loading = true
        let next = await TranscriptImageStore.shared.load(key) {
            try await client.sessionImage(machineId: key.source.machineId, sessionId: key.source.sessionId,
                                          ref: key.ref, source: key.source.source)
        }
        guard !Task.isCancelled, key == self.key else { return }
        loaded = next; loadedKey = key; loading = false
        if let next { onLoaded?(next) }
    }
}

struct TranscriptImageViewer: View {
    let refs: [String?]
    let initialIndex: Int
    let seed: TranscriptImageSeed?
    @State private var page: Int
    /// Decoded pictures by page — what the share button hands over.
    @State private var shown: [Int: UIImage] = [:]
    @Environment(\.dismiss) private var dismiss

    init(refs: [String?], initialIndex: Int, seed: TranscriptImageSeed? = nil) {
        self.refs = refs
        self.initialIndex = initialIndex
        self.seed = seed
        _page = State(initialValue: initialIndex)
    }

    var body: some View {
        TabView(selection: $page) {
            ForEach(refs.indices, id: \.self) { index in
                TranscriptImageView(ref: refs[index], fullSize: true,
                                    seed: index == initialIndex ? seed : nil,
                                    onLoaded: { shown[index] = $0 }).tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(Color.black).ignoresSafeArea(edges: .bottom)
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                Text(refs.count > 1 ? "\(page + 1) / \(refs.count)" : "Изображение")
                    .font(.system(.subheadline, weight: .medium))
                    .accessibilityIdentifier("transcript.gallery.count")
                Spacer()
                if let picture = shown[page] {
                    ShareLink(item: Image(uiImage: picture),
                              preview: SharePreview("Изображение", image: Image(uiImage: picture))) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 17, weight: .medium))
                            .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                            .background(.white.opacity(0.12), in: Circle())
                    }
                    .buttonStyle(.plain).accessibilityLabel("Поделиться или сохранить")
                    .accessibilityIdentifier("transcript.image.share")
                }
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 17, weight: .medium))
                        .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                        .background(.white.opacity(0.12), in: Circle())
                }.buttonStyle(.plain).accessibilityLabel("Закрыть")
            }
            .foregroundStyle(.white).padding(.horizontal, Theme.s4).padding(.vertical, Theme.s2)
            .background(Color.black)
        }
        .background(Color.black.ignoresSafeArea()).preferredColorScheme(.dark)
    }
}

/// Native pinch/pan keeps the enlarged picture independent of chat scrolling.
struct ZoomableTranscriptImage: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.accessibilityIdentifier = "transcript.image.viewer"
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 4
        scroll.contentInsetAdjustmentBehavior = .never
        let picture = context.coordinator.picture
        picture.contentMode = .scaleAspectFit; picture.image = image
        picture.isAccessibilityElement = true
        picture.accessibilityLabel = "Изображение из сообщения"
        scroll.addSubview(picture)
        picture.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            picture.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            picture.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            picture.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            picture.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            picture.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            picture.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }
    func updateUIView(_ uiView: UIScrollView, context: Context) { context.coordinator.picture.image = image }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        let picture = UIImageView()
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
        @objc func toggleZoom(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: true) }
            else {
                let point = gesture.location(in: picture)
                let size = CGSize(width: scroll.bounds.width / 2, height: scroll.bounds.height / 2)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                                      width: size.width, height: size.height), animated: true)
            }
        }
    }
}
