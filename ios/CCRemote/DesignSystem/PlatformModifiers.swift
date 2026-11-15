import SwiftUI
import UIKit

/// Модификаторы и мелкие обёртки над платформой.
///
/// Раньше здесь жили ветки `#if os(macOS)`: файл описывал ОДИН дизайн для двух
/// хостов и на каждом втором модификаторе объяснял, что Mac делает вместо. Этого
/// хоста больше нет — нативный Mac-таргет удалён из `project.yml` 21.09.2026, и
/// Mac-приложение теперь Tauri-шелл в `windows/`, который рендерит тот же
/// хостинговый SPA. Ветки, оставшиеся после удаления таргета, — это не
/// «задел на будущее», а код, который никогда не компилируется и потому тихо
/// расходится с правдой; следующий агент читает его как описание живого
/// продукта.
extension View {
    /// Только область чтения, не общий контейнер вместе с композером.
    /// Одновременный жест сохраняет действия ссылок и кнопок сообщений.
    func dismissKeyboardOnTap() -> some View {
        contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                                to: nil, from: nil, for: nil)
            })
    }

    /// iOS 26 добавляет к краям ScrollView отдельный градиент материала.
    /// Прозрачные края оставляют видимым чат за плавающими островами.
    @ViewBuilder func unifiedScrollEdges() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectHidden()
        } else {
            self
        }
    }

    /// Мягкие края переписки, как в ChatGPT (08.10.2026): строки проходят под
    /// часами, островами шапки и композером и гаснут к краю экрана, а не
    /// обрезаются глухой полосой.
    ///
    /// Это МАСКА на прокрутке, а не слой канвы поверх. Слой не работает: и
    /// `overlay` на ChatView, и `safeAreaInset` нулевой высоты рисовались ПОД
    /// строками прокрутки (снято на симуляторе 08.10.2026 — текст в красном
    /// отладочном слое не покраснел). Маска режет сам слой прокрутки, так что
    /// гаснет только текст, а острова шапки и композер остаются как есть.
    ///
    /// Ставится на прокрутку ДО `safeAreaInset` композера. Рамка маски — это
    /// область МЕЖДУ шапкой и композером, а `safeAreaInsets` — зоны вне неё до
    /// краёв экрана (снято на iPhone 17 Pro: рамка 116…772 при экране 874,
    /// insets 116 / 102). Верхняя зона — от края экрана до 16pt ниже шапки,
    /// нижняя — от верха композера до края экрана; `scrollClipDisabled` рисует
    /// и за краем, поэтому маска заходит ещё на `spill` вниз.
    /// Экран с ней сообщает об этом шеллу (`ShellRoute.fadesOwnTopEdge`),
    /// чтобы тот не клал поверх свою непрозрачную полосу под часами.
    ///
    /// `extraTop`/`extraBottom` — свои острова ВНУТРИ рамки (меню рисует шапку
    /// и подвал поверх прокрутки, а не inset'ами): зона гашения продлевается
    /// на их высоту, чтобы строки гасли под ними, а не рядом.
    func chatEdgeFade(extraTop: CGFloat = Theme.s4, extraBottom: CGFloat = 0) -> some View {
        mask {
            GeometryReader { geo in
                let above = geo.safeAreaInsets.top
                // С клавиатурой inset включает и её: зона не растягивается
                // на 400pt, а гаснет за высоту композера и полоски «домой».
                let below = min(geo.safeAreaInsets.bottom, 120)
                let spill: CGFloat = 400
                VStack(spacing: 0) {
                    Theme.topEdgeMask.frame(height: above + extraTop)
                    Color.black.frame(height: max(0, geo.size.height - extraTop - extraBottom))
                    Theme.bottomEdgeMask.frame(height: below + extraBottom)
                    Color.black.opacity(Theme.edgeFloor).frame(height: spill)
                }
                .offset(y: -above)
            }
        }
    }

    /// Компактный заголовок навигации.
    func inlineTitle() -> some View {
        navigationBarTitleDisplayMode(.inline)
    }

    /// Размер листа: детенты плюс индикатор перетаскивания.
    func sheetSize(detents: Set<PresentationDetent> = [.medium, .large]) -> some View {
        presentationDetents(detents).presentationDragIndicator(.visible)
    }

    /// `Menu`, выглядящее как иконочная кнопка, которой оно нарисовано.
    /// На iOS ничего снимать не нужно — оставлено как точка сопряжения для мест
    /// вызова, которые уже её зовут.
    func plainMenu() -> some View { self }

    /// Поле ввода для данных, а не для прозы: без автозаглавных и автокоррекции.
    func plainTextEntry() -> some View {
        textInputAutocapitalization(.never).autocorrectionDisabled()
    }

    /// Ввод адреса почты: почтовая клавиатура, без автозаглавных и коррекции —
    /// адрес это данные.
    func emailField() -> some View {
        keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }
}

extension ToolbarItemPlacement {
    static var trailingActions: ToolbarItemPlacement { .topBarTrailing }
    static var leadingActions: ToolbarItemPlacement { .topBarLeading }
}

/// `UIImage` под именем, которое не обещает второй платформы.
typealias PlatformImage = UIImage

extension Image {
    init(platformImage: PlatformImage) { self.init(uiImage: platformImage) }
}

/// Скопировать текст в системный буфер обмена.
func copyToPasteboard(_ text: String) {
    UIPasteboard.general.string = text
}

/// Элемент тулбара БЕЗ системной подложки.
///
/// С iOS 26 панель оборачивает каждый свой элемент в стеклянную КАПСУЛУ. В этой
/// дизайн-системе кругов не бывает вообще («Прямоугольники, никогда круги»:
/// `border-radius: 50%` не встречается ни разу), а icon-кнопка — это квадрат.
/// Подложка превращала ☰ в самый заметный и самый чужой элемент экрана.
///
/// Обёрткой, а не модификатором вида: `sharedBackgroundVisibility` живёт на
/// `ToolbarContent`, а не на `View`, — и под `#available`, потому что таргет
/// развёртывания iOS 17, где снимать нечего.
@ToolbarContentBuilder
func bareToolbarItem<Content: View>(placement: ToolbarItemPlacement = .leadingActions,
                                    @ViewBuilder content: () -> Content) -> some ToolbarContent {
    if #available(iOS 26.0, *) {
        ToolbarItem(placement: placement, content: content)
            .sharedBackgroundVisibility(.hidden)
    } else {
        ToolbarItem(placement: placement, content: content)
    }
}
