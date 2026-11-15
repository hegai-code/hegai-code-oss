import SwiftUI
import UIKit

/// Верхняя полоса приложения — та её часть, которую SwiftUI рисует сама.
///
/// Зачем это вообще существует: с iOS 26 системная панель кладёт КАЖДЫЙ свой
/// элемент в стеклянную КАПСУЛУ. Для своих элементов её снимает
/// `bareToolbarItem` (`PlatformModifiers.swift`), но кнопка «назад» — не свой
/// элемент: её ставит навигационный стек, и до неё тот модификатор не достаёт.
/// Результатом был белый КРУГ с шевроном в левом верхнем углу каждого
/// вытолкнутого экрана — настройки, команда, уведомления, открытая сессия — то
/// есть самый заметный круг в системе, где «кругов не бывает» записано первым
/// же инвариантом (DESIGN.md, «Прямоугольники, никогда не круги»).
///
/// Снимается это не во вью, а через `UIBarButtonItemAppearance`: пустая
/// `backgroundImage` убирает подложку, оставляя сам шеврон и, главное, ЖИВОЙ
/// жест возврата свайпом — альтернатива («спрятать системную кнопку и
/// нарисовать свою») этот жест ломает, и чинить его пришлось бы залезая в
/// `UINavigationController` под SwiftUI.
enum NavigationChrome {

    /// Зовётся один раз на старте, до появления первой панели.
    static func apply() {
        let bare = UIBarButtonItemAppearance(style: .plain)
        for state in [bare.normal, bare.highlighted, bare.disabled, bare.focused] {
            state.backgroundImage = UIImage()
            state.titleTextAttributes = [
                .foregroundColor: UIColor(Theme.text),
                .font: UIFont(name: "Onest-Medium", size: Theme.sizeSmall) ?? .systemFont(ofSize: 15)
            ]
        }

        // Острова лежат поверх чата: ни заливки, ни материала на всю ширину.
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.backgroundColor = .clear
        appearance.backgroundEffect = nil
        appearance.shadowColor = .clear
        appearance.backButtonAppearance = bare
        appearance.buttonAppearance = bare
        appearance.doneButtonAppearance = bare
        // Заголовок панели — голос структуры, а не системный SF; кегль
        // карточки (17), тот же, которым подписана карточка под ним.
        appearance.titleTextAttributes = [
            .foregroundColor: UIColor(Theme.text),
            .font: UIFont(name: "Onest-Medium", size: Theme.sizeCard) ?? .systemFont(ofSize: 17)
        ]

        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactScrollEdgeAppearance = appearance
        UINavigationBar.appearance().isTranslucent = true
        UINavigationBar.appearance().tintColor = UIColor(Theme.text)
    }
}

// `PlatformColor(_ token:)` — это `UIColor(_: Color)` из SwiftUI, и токен
// остаётся ДИНАМИЧЕСКИМ: каждый построен на `UIColor { trait in … }`, так что
// UIKit разрешает его в своём окружении сам, включая смену темы на лету.
