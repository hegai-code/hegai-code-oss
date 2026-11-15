import SwiftUI
import UIKit
import WebKit
import CCRemoteKit

/// Отчёт с платформы (`/w/reports/<id>`) — внутри приложения, листом.
///
/// Раньше ссылка уходила в Safari: там над страницей стояли адресная строка,
/// топбар веба (☰ и лимиты) и шапка отчёта — около трети экрана до первой
/// строки (20.10.2026, по просьбе владельца). Здесь — лист `.large` с язычком
/// и одной полосой: «Поделиться», название, «×».
///
/// HTML приходит тем же REST-клиентом и той же сессией, что и всё остальное
/// приложение (`Authorization: Bearer`), и грузится в `WKWebView` строкой: без
/// origin, с неперсистентным хранилищем, так что скрипты отчёта не видят ни
/// куки, ни токена. Политику хаба (`REPORT_CSP`) заменяет `<meta>`, который
/// ставит `ReportLink.hardened` — сеть отчёту закрыта так же, как в iframe веба.
///
/// Показ — UIKit-ом, с самого верхнего контроллера. Не `fullScreenCover` на
/// корне: ссылка, нажатая внутри листа (транскрипт помощника, «Действия»),
/// не смогла бы показаться поверх него — корень «уже что-то показывает», и
/// тап молча пропадал бы.
@MainActor
enum ReportPresenter {
    static func present(_ link: ReportLink, hubURL: String, token: String) {
        guard let top = topController() else {
            UIApplication.shared.open(link.webURL)
            return
        }
        var host: UIViewController?
        let viewer = ReportViewer(start: link, hubURL: hubURL, token: token) {
            host?.dismiss(animated: true)
        }
        let controller = UIHostingController(rootView: viewer)
        // Лист, как транскрипт помощника: язычок сверху, свайп вниз закрывает
        // (20.10.2026, по просьбе владельца — полноэкранная обложка была
        // чужой для приложения). Светлый всегда: отчёты свёрстаны под
        // `prefers-color-scheme`, и в тёмной теме телефона открывались тёмными,
        // а их читают как документ.
        controller.modalPresentationStyle = .pageSheet
        controller.overrideUserInterfaceStyle = .light
        if let sheet = controller.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        host = controller
        top.present(controller, animated: true)
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.first { $0.activationState == .foregroundActive }?.keyWindow
            ?? scenes.first?.keyWindow
        var top = window?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }
}

struct ReportViewer: View {
    let hubURL: String
    let token: String
    let close: () -> Void

    /// Отчёт, который сейчас на экране: ссылка на другой отчёт изнутри
    /// открывается здесь же, заменяя этот.
    @State private var link: ReportLink
    @State private var title = "Отчёт"
    @State private var html: String?
    @State private var failure: String?
    @State private var attempt = 0

    init(start: ReportLink, hubURL: String, token: String, close: @escaping () -> Void) {
        _link = State(initialValue: start)
        self.hubURL = hubURL
        self.token = token
        self.close = close
    }

    var body: some View {
        NavigationStack {
            Group {
                if let html {
                    ReportWebView(html: html, onLink: follow)
                        .ignoresSafeArea(edges: .bottom)
                        .accessibilityIdentifier("report.web")
                } else if let failure {
                    VStack(spacing: Theme.s3) {
                        Text(failure)
                            .foregroundStyle(Theme.textMuted)
                            .multilineTextAlignment(.center)
                        Button("Повторить") { attempt += 1 }
                            .buttonStyle(.bordered)
                    }
                    .padding(Theme.s4)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Шапка — как у листа помощника: название по центру, «×»
                // справа. «Поделиться» слева, той же иконкой без подписи.
                ToolbarItem(placement: .topBarLeading) {
                    ShareLink(item: link.webURL) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(.subheadline, weight: .semibold))
                    }
                    .tint(Theme.text)
                    .accessibilityLabel("Поделиться")
                }
                ToolbarItem(placement: .principal) {
                    Text(title).font(.ui(Theme.sizeSmall, weight: .semibold))
                        .foregroundStyle(Theme.text).lineLimit(1)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SheetCloseButton(action: close)
                        .accessibilityIdentifier("report.close")
                }
            }
        }
        .tint(Theme.action)
        .task(id: "\(link.id)#\(attempt)") { await load() }
    }

    private func follow(_ url: URL) {
        if let next = ReportLink(url, hubURL: hubURL) {
            guard next.id != link.id else { return }
            html = nil
            title = "Отчёт"
            link = next
        } else {
            UIApplication.shared.open(url)
        }
    }

    private func load() async {
        let rest = RestClient()
        rest.configure(hubURL: hubURL, token: token)
        let current = link
        failure = nil
        do {
            let data = try await rest.getData(current.contentPath)
            guard current == link else { return }
            html = ReportLink.hardened(String(decoding: data, as: UTF8.self))
        } catch {
            if current == link, !(error is CancellationError) { failure = Self.describe(error) }
            return
        }
        // Название — второе: страница важнее подписи над ней, и отказ здесь
        // ничего не ломает, остаётся «Отчёт».
        struct Meta: Decodable { let title: String }
        if let meta = try? await rest.get(current.metaPath, as: Meta.self),
           current == link, !meta.title.isEmpty {
            title = meta.title
        }
    }

    private static func describe(_ error: Error) -> String {
        let text = error.localizedDescription
        if text.contains("not found") || text.contains("HTTP 404") {
            return "Отчёт не найден: его удалили, или он не ваш."
        }
        if text.contains("HTTP 403") { return "Отчёты вам пока не показываются." }
        return "Не удалось загрузить: \(text)"
    }
}

/// `WKWebView` под отчёт. Своя навигация у страницы одна — якоря внутри неё
/// (`about:blank#…`); ссылка наружу отдаётся `onLink`: другой отчёт откроется
/// здесь же, остальное — в Safari. Переходы на `data:`/`blob:` закрыты: такой
/// документ пришёл бы уже без политики.
private struct ReportWebView: UIViewRepresentable {
    let html: String
    let onLink: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onLink: onLink) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.dataDetectorTypes = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        // Прозрачный, пока страница не нарисовала свой фон: иначе в тёмной
        // теме отчёт открывается белой вспышкой.
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.loadHTMLString(html, baseURL: nil)
        context.coordinator.loaded = html
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onLink = onLink
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        view.loadHTMLString(html, baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var loaded: String?
        var onLink: (URL) -> Void

        init(onLink: @escaping (URL) -> Void) { self.onLink = onLink }

        private static let inPage: Set<String> = ["about"]
        private static let outward: Set<String> = ["http", "https", "mailto", "tel"]

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return .cancel }
            if Self.inPage.contains(scheme) { return .allow }
            // Наружу — только по нажатию: скрипт отчёта не уводит экран сам.
            if action.navigationType == .linkActivated, Self.outward.contains(scheme) {
                onLink(url)
            }
            return .cancel
        }

        /// `target="_blank"` и `window.open` — та же ссылка наружу.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, let scheme = url.scheme?.lowercased(),
               Self.outward.contains(scheme) {
                onLink(url)
            }
            return nil
        }
    }
}
