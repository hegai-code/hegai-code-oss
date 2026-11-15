import SwiftUI
import ImageIO
import CCRemoteKit

// ============================================================================
// Превью файлов, которые назвал ответ агента.
//
// «Скриншот: /tmp/agents-0/-srv-x/<id>/scratchpad/mail.png» последней строкой
// ответа — это адрес на ДИСКЕ МАШИНЫ, а не картинка в разговоре. Лента находит
// такие пути (`PreviewPaths`), просит у агента окна файла (`fs.peek`) и рисует
// под текстом миниатюру (нажатие — на весь экран с щипком) или, для .md,
// чип, открывающий лист с разметкой.
//
// Без `\.filePreviewSource` в окружении (чужие места, где живёт MarkdownText)
// не рисуется ничего: нет сессии — нет и папки, от которой считать путь.
// ============================================================================

/// Откуда читать: машина и папка сессии. `loader` подменяет сеть (стенд
/// транскрипта без хаба); в приложении он nil, и читает `fs.peek`.
struct FilePreviewSource {
    let machineId: String
    let cwd: String
    var loader: (@MainActor (_ path: String, _ maxBytes: Int) async throws -> Data)? = nil
}

private struct FilePreviewSourceKey: EnvironmentKey {
    static let defaultValue: FilePreviewSource? = nil
}

extension EnvironmentValues {
    var filePreviewSource: FilePreviewSource? {
        get { self[FilePreviewSourceKey.self] }
        set { self[FilePreviewSourceKey.self] = newValue }
    }
}

/// Потолки, зеркало агента: картинка до 16 МБ, markdown — 512 КБ (лист с
/// мегабайтом разметки — не превью).
private enum FilePreviewLimit {
    static let image = 16 * 1024 * 1024
    static let markdown = 512 * 1024
}

/// Ограниченный кэш в памяти. Кладёт только УСПЕХИ; неудача помнится 30 секунд
/// — иначе мёртвый путь в длинном ответе дёргал бы агента при каждой прокрутке.
/// Одновременные запросы одного файла делят один поход за байтами.
@MainActor
final class FilePreviewStore {
    static let shared = FilePreviewStore()

    struct Key: Hashable {
        let scope: String
        let machineId: String
        let cwd: String
        let path: String
        var id: String {
            [scope, machineId, cwd, path].map { "\($0.utf8.count):\($0)" }.joined()
        }
    }

    private let cache = NSCache<NSString, AnyObject>()
    private var pending: [String: Task<AnyObject?, Never>] = [:]
    private var failedAt: [String: Date] = [:]
    /// Когда положен успех. Путь часто перезаписывается следующим скриншотом
    /// под тем же именем, поэтому успех живёт 5 минут, как в вебе.
    private var storedAt: [String: Date] = [:]
    private static let successMemory: TimeInterval = 300
    /// Не больше трёх чтений сразу, как в вебе: лента монтирует десятки строк,
    /// а хаб отказывает соединению после 32 запросов в полёте.
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private static let maxConcurrent = 3

    private func acquire() async {
        if active < Self.maxConcurrent { active += 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { active -= 1 } else { waiters.removeFirst().resume() }
    }
    private var scope: String?
    private static let failureMemory: TimeInterval = 30

    init() { cache.totalCostLimit = 96 * 1024 * 1024; cache.countLimit = 40 }

    func cachedImage(_ key: Key) -> UIImage? { cache.object(forKey: key.id as NSString) as? UIImage }
    func cachedText(_ key: Key) -> String? { (cache.object(forKey: key.id as NSString) as? NSString).map { $0 as String } }

    func image(_ key: Key, force: Bool = false, fetch: @escaping @MainActor (Int) async throws -> Data) async -> UIImage? {
        await run(key, force: force) {
            guard let data = try? await fetch(FilePreviewLimit.image), !data.isEmpty, !Task.isCancelled else { return nil }
            return await Task.detached(priority: .utility) { decodePreviewThumbnail(data) }.value
        }
    }

    func text(_ key: Key, force: Bool = false, fetch: @escaping @MainActor (Int) async throws -> Data) async -> String? {
        let made: NSString? = await run(key, force: force) {
            guard let data = try? await fetch(FilePreviewLimit.markdown), !Task.isCancelled else { return nil }
            let head = String(decoding: data, as: UTF8.self)
            // `clip` вернул ровно потолок — значит, файл длиннее, чем показано.
            return (data.count >= FilePreviewLimit.markdown ? head + "\n\n_Показано начало файла._" : head) as NSString
        }
        return made.map { $0 as String }
    }

    private func run<T: AnyObject>(_ key: Key, force: Bool, make: @escaping @MainActor () async -> T?) async -> T? {
        if scope != key.scope {
            pending.values.forEach { $0.cancel() }; pending.removeAll()
            cache.removeAllObjects(); failedAt.removeAll(); storedAt.removeAll(); scope = key.scope
        }
        let id = key.id
        if force { failedAt[id] = nil }
        if let hit = cache.object(forKey: id as NSString) as? T,
           let at = storedAt[id], Date().timeIntervalSince(at) < Self.successMemory, !force { return hit }
        if let at = failedAt[id], Date().timeIntervalSince(at) < Self.failureMemory { return nil }
        if let task = pending[id] {
            let value = await task.value as? T
            return scope == key.scope ? value : nil
        }
        let task = Task<AnyObject?, Never> { [weak self] in
            await self?.acquire()
            defer { self?.release() }
            return await make()
        }
        pending[id] = task
        let value = await task.value as? T
        guard scope == key.scope, !task.isCancelled else { return nil }
        pending[id] = nil
        if let value {
            var cost = 0
            if let image = value as? UIImage { cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0) }
            else if let text = value as? NSString { cost = text.length * 2 }
            cache.setObject(value, forKey: id as NSString, cost: cost)
            storedAt[id] = Date()
        } else {
            // Устаревший успех не должен прятать неудачу (файл удалён, доступ отозван).
            cache.removeObject(forKey: id as NSString); storedAt[id] = nil
            failedAt[id] = Date()
        }
        return value
    }
}

/// 2400 px по длинной стороне: хватает на щипок до 4× на экране телефона и
/// держит ~15 МБ на картинку после распаковки.
private func decodePreviewThumbnail(_ data: Data) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2400,
            kCGImageSourceShouldCacheImmediately: true,
          ] as CFDictionary) else { return nil }
    return UIImage(cgImage: image)
}

/// Полоса под абзацем ответа: по строке на каждый найденный в нём путь.
struct FilePreviewStrip: View {
    let text: String
    @Environment(\.filePreviewSource) private var source
    @Environment(CentralClient.self) private var client

    var body: some View {
        if let source {
            let paths = PreviewPaths.find(in: text)
            if !paths.isEmpty {
                VStack(alignment: .leading, spacing: Theme.s2) {
                    ForEach(paths, id: \.self) { path in
                        // Идентичность строки — весь ключ файла, а не только путь: тот же
                        // `/tmp/a.png` в другом аккаунте, машине или папке — другой файл,
                        // и @State прошлого (картинка, открытый лист) не должен его показать.
                        FilePreviewItem(path: path, source: source)
                            .id(FilePreviewStore.Key(scope: client.storageScope, machineId: source.machineId,
                                                     cwd: source.cwd, path: path).id)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Theme.s2)
            }
        }
    }
}

private struct FilePreviewItem: View {
    let path: String
    let source: FilePreviewSource
    @Environment(CentralClient.self) private var client
    @State private var image: UIImage?
    @State private var markdown: String?
    @State private var failed = false
    @State private var attempt = 0
    @State private var fullScreen: PictureBox?
    @State private var showMarkdown = false

    private struct PictureBox: Identifiable { let id = UUID(); let image: UIImage }

    private var isImage: Bool { PreviewPaths.isImage(path) }
    private var name: String { PreviewPaths.fileName(path) }
    private var key: FilePreviewStore.Key {
        .init(scope: client.storageScope, machineId: source.machineId, cwd: source.cwd, path: path)
    }
    /// Из памяти сразу, без мигания «загрузка», когда строка вернулась на экран.
    private var shownImage: UIImage? { image ?? FilePreviewStore.shared.cachedImage(key) }
    private var shownText: String? { markdown ?? FilePreviewStore.shared.cachedText(key) }

    var body: some View {
        Group {
            if isImage { imageBody } else { markdownBody }
        }
        .task(id: "\(key.id)|\(attempt)") { await load() }
        .fullScreenCover(item: $fullScreen) { box in
            FilePreviewImageViewer(image: box.image, title: name)
        }
        .sheet(isPresented: $showMarkdown) { MarkdownPreviewSheet(name: name, text: shownText ?? "") }
    }

    // MARK: Picture

    @ViewBuilder private var imageBody: some View {
        if let picture = shownImage {
            Button {
                fullScreen = PictureBox(image: picture); Haptics.light()
            } label: {
                Image(uiImage: picture).resizable().scaledToFit()
                    .frame(maxWidth: 320, maxHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).strokeBorder(Theme.rim, lineWidth: 0.5) }
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Открыть изображение \(name)")
            .accessibilityIdentifier("filePreview.image")
        } else if failed {
            unavailable(icon: "photo")
        } else {
            RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous)
                .fill(Theme.chip)
                .frame(maxWidth: 240).frame(height: 120)
                .overlay { ProgressView() }
                .accessibilityLabel("Загрузка изображения \(name)")
                .accessibilityIdentifier("filePreview.loading")
        }
    }

    // MARK: Markdown

    @ViewBuilder private var markdownBody: some View {
        if shownText != nil {
            Button {
                showMarkdown = true; Haptics.light()
            } label: {
                chipLabel(icon: "doc.text", text: name, tone: Theme.text)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Открыть файл \(name)")
            .accessibilityIdentifier("filePreview.markdown")
        } else if failed {
            unavailable(icon: "doc.text")
        } else {
            chipLabel(icon: "doc.text", text: name, tone: Theme.textMuted)
                .opacity(0.6)
                .accessibilityIdentifier("filePreview.loading")
        }
    }

    // MARK: Shared

    private func chipLabel(icon: String, text: String, tone: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: Theme.sizeSmall, weight: .regular))
            Text(text).font(.mono(Theme.sizeMeta)).lineLimit(1).truncationMode(.middle)
        }
        .foregroundStyle(tone)
        .padding(.horizontal, Theme.s3).padding(.vertical, 7)
        .background(Theme.chip, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
    }

    /// Абсолютный путь, который не открылся: честная приглушённая строка, по
    /// нажатию — ещё попытка. Относительный путь в прозе чаще всего не файл,
    /// а слово с косой чертой, — он при неудаче просто исчезает.
    @ViewBuilder private func unavailable(icon: String) -> some View {
        if PreviewPaths.isAbsolute(path) {
            Button { attempt += 1 } label: {
                HStack(spacing: 6) {
                    Image(systemName: icon).font(.system(size: Theme.sizeSmall, weight: .regular))
                    Text(name).font(.mono(Theme.sizeMeta)).lineLimit(1).truncationMode(.middle)
                    Text("· недоступен").font(.ui(Theme.sizeMeta))
                }
                .foregroundStyle(Theme.textFaint)
                .padding(.horizontal, Theme.s3).padding(.vertical, 7)
                .background(Theme.chip.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(name), недоступен. Повторить")
            .accessibilityIdentifier("filePreview.unavailable")
        }
    }

    private func load() async {
        let key = key
        let force = attempt > 0
        // Состояние прошлого ключа (другой аккаунт, другая папка) не показываем:
        // из памяти строка и так берёт то, что есть для ЭТОГО ключа.
        image = nil; markdown = nil
        let clip = !isImage
        let fetch: @MainActor (Int) async throws -> Data = { [client, source, path] limit in
            if let loader = source.loader { return try await loader(path, limit) }
            return try await client.peekFile(machineId: source.machineId, cwd: source.cwd, path: path, maxBytes: limit, clip: clip)
        }
        if isImage {
            if shownImage == nil { failed = false }
            let made = await FilePreviewStore.shared.image(key, force: force, fetch: fetch)
            guard !Task.isCancelled else { return }
            image = made; failed = made == nil
        } else {
            if shownText == nil { failed = false }
            let made = await FilePreviewStore.shared.text(key, force: force, fetch: fetch)
            guard !Task.isCancelled else { return }
            markdown = made; failed = made == nil
        }
    }
}

/// Весь экран, щипок и двойной тап — тот же `ZoomableTranscriptImage`, что и у
/// картинок ленты; шапка — та же: название, поделиться, закрыть.
private struct FilePreviewImageViewer: View {
    let image: UIImage
    let title: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZoomableTranscriptImage(image: image)
            .background(Color.black).ignoresSafeArea(edges: .bottom)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack {
                    Text(title).font(.mono(Theme.sizeMeta)).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    ShareLink(item: Image(uiImage: image), preview: SharePreview(title, image: Image(uiImage: image))) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 17, weight: .medium))
                            .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                            .background(.white.opacity(0.12), in: Circle())
                    }
                    .buttonStyle(.plain).accessibilityLabel("Поделиться или сохранить")
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

private struct MarkdownPreviewSheet: View {
    let name: String
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                MarkdownText(text: text.isEmpty ? "_Файл пуст._" : text)
                    .padding(Theme.s4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.bg)
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Закрыть") { dismiss() } }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("filePreview.markdown.sheet")
    }
}
