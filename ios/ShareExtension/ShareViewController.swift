import UIKit
import UniformTypeIdentifiers
import CCRemoteKit

/// Share-sheet entry point. Grabs the shared text / URL / image, puts it on the
/// system pasteboard, hands off to the host app via the `ccremote://share`
/// scheme, then dismisses. UIPasteboard is cross-process and needs no App Group
/// (so no extra provisioning) — the host app reads it on the deep link. This is
/// deliberately UI-less; the real screen is the app's prefilled New Session.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        Task { await process() }
    }

    private static let maxImages = 4
    private enum SharePiece { case text(String), image(Data), none }

    private func process() async {
        var text: String?
        var imageDatas: [Data] = []
        for item in (extensionContext?.inputItems as? [NSExtensionItem]) ?? [] {
            for provider in item.attachments ?? [] {
                switch await loadPiece(provider, canLoadImage: imageDatas.count < Self.maxImages) {
                case .image(let d): imageDatas.append(d)
                case .text(let s): text = joined(text, s)
                case .none: break
                }
            }
        }
        stash(text: text, imageDatas: imageDatas)
        // Закрываем лист ТОЛЬКО после попытки открыть хозяина: `completeRequest`
        // сносит расширение вместе с недоделанной работой, и открытие,
        // отправленное следом, отправляется в никуда.
        openHost()
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    /// Load one attachment: an image (while under the limit) takes precedence over
    /// a URL, which takes precedence over plain text.
    private func loadPiece(_ provider: NSItemProvider, canLoadImage: Bool) async -> SharePiece {
        if canLoadImage, provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            if let d = await loadImage(provider) { return .image(d) }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await loadURL(provider) { return .text(url.absoluteString) }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let s = await loadText(provider) { return .text(s) }
        }
        return .none
    }

    private func joined(_ a: String?, _ b: String) -> String {
        guard let a, !a.isEmpty else { return b }
        return a + "\n" + b
    }

    /// Put the shared content on the general pasteboard: the text as one item, then
    /// one item per image. The host app reads `pb.string` + `pb.images` on
    /// `ccremote://share`. One item per image is what makes `pb.images` see them all.
    private func stash(text: String?, imageDatas: [Data]) {
        var items: [[String: Any]] = []
        if let text, !text.isEmpty { items.append([UTType.plainText.identifier: text]) }
        for d in imageDatas { items.append([UTType.image.identifier: d]) }
        guard !items.isEmpty else { return }
        UIPasteboard.general.setItems(items, options: [:])
    }

    // MARK: Item loaders (a provider can vend a file URL, a UIImage, or raw Data)

    private func loadImage(_ p: NSItemProvider) async -> Data? {
        await withCheckedContinuation { cont in
            p.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
                if let url = item as? URL, let d = try? Data(contentsOf: url) { cont.resume(returning: d) }
                else if let img = item as? UIImage { cont.resume(returning: img.jpegData(compressionQuality: 0.85)) }
                else if let d = item as? Data { cont.resume(returning: d) }
                else { cont.resume(returning: nil) }
            }
        }
    }

    private func loadURL(_ p: NSItemProvider) async -> URL? {
        await withCheckedContinuation { cont in
            p.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                cont.resume(returning: item as? URL)
            }
        }
    }

    private func loadText(_ p: NSItemProvider) async -> String? {
        await withCheckedContinuation { cont in
            p.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                cont.resume(returning: item as? String)
            }
        }
    }

    // MARK: Host hand-off
    //
    // Расширение не может позвать `UIApplication.shared.open` — метод помечен
    // недоступным для расширений и такой код просто не собирается.
    //
    // ЧТО ЗДЕСЬ БЫЛО СЛОМАНО. Раньше эта функция шла по цепочке респондеров и
    // звала селектор `openURL:` — ОДНОаргументный `UIApplication.openURL:`,
    // объявленный устаревшим в iOS 10 и к нынешним системам из UIKit просто
    // убранный. Значит `responds(to:)` отвечал `false` на каждом звене, цикл
    // добегал до конца и молча возвращался: лист закрывался, буфер был
    // заполнен, приложение не открывалось — и со стороны это выглядело как
    // «шаринг не работает», без единой строчки в логе.
    //
    // Поймать это можно было только НАСТОЯЩИМ шарингом: открытие
    // `ccremote://share` ссылкой минует расширение целиком и всегда зелено.
    //
    // ЧТО РАБОТАЕТ НА САМОМ ДЕЛЕ (замерено на iOS 26.2, 22.09.2026, лог ниже):
    //
    //     extensionContext.open           -> false   // Today/iMessage only
    //     ShareViewController             responds=false
    //     UIView / _UIViewServiceRootVC   responds=false
    //     UIWindow                        responds=false
    //     _UIHostedWindowScene            responds=TRUE   <-- вот эта дверь
    //     _UIHostedWindowScene.openURL    -> true          <-- и она открылась
    //
    // То есть `NSExtensionContext.open` документирован как единственный
    // санкционированный путь, но для share-расширения он честно отвечает
    // `false`. Реально открывает СЦЕНА, до которой достаёт цепочка респондеров.
    // До `UIApplication` цепочка тоже доходит, но в процессе расширения у неё
    // этого метода нет — линкуется extension-safe вариант класса.
    private func openHost() {
        guard let url = URL(string: "ccremote://share") else { return }
        extensionContext?.open(url) { [weak self] ok in
            if !ok { self?.openViaResponderChain(url) }
        }
    }

    /// Запасной (и на деле единственный работающий) ход: дойти по цепочке до
    /// того, кто умеет `openURL:options:completionHandler:`, и позвать его.
    private func openViaResponderChain(_ url: URL) {
        // Имя СЕЛЕКТОРА, а не Swift-метода: `open(_:options:completionHandler:)`
        // мостится из ObjC-метода `-openURL:options:completionHandler:` и
        // префикс `openURL` сохраняет. Селектор `open:options:…` не существует
        // вовсе, и цепочка с ним молча добегает до конца — ровно тот же отказ
        // без единой строчки, что и с убранным одноаргументным `openURL:`.
        let selector = sel_registerName("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let r = responder {
            if r !== self, r.responds(to: selector) {
                // Зовём IMP с НАСТОЯЩЕЙ сигнатурой из трёх аргументов.
                // `perform(_:with:with:)` умеет только два, и третьим —
                // блоком-хендлером — в метод уехал бы мусор со стека.
                typealias OpenFn = @convention(c)
                    (AnyObject, Selector, NSURL, NSDictionary?, ((Bool) -> Void)?) -> Void
                guard let imp = class_getMethodImplementation(type(of: r), selector) else { return }
                let open = unsafeBitCast(imp, to: OpenFn.self)
                open(r, selector, url as NSURL, nil, { ok in
                    if !ok { NSLog("[share] \(type(of: r)) отказался открыть \(url)") }
                })
                return
            }
            responder = r.next
        }
        // Досюда доходить НЕ ДОЛЖНО. Если дошло — значит очередная iOS убрала
        // и этот селектор, передача снова тихо умерла, и единственный способ
        // это заметить — вот эта строка. Ровно её отсутствие стоило фазе 4
        // четырёх прогонов вслепую.
        NSLog("[share] НИКТО в цепочке не умеет \(selector) — передача не доехала")
    }
}
