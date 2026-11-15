import Foundation
import UserNotifications

/// WATCH.md §6. The phone and the watch register exactly these. The first action
/// of every category is what the watch's double tap fires, so it is never an
/// acceptance.
enum HegaiNotificationCategories {
    struct ActionSpec: Equatable {
        enum Kind: Equatable { case button, destructive, text(placeholder: String), authenticated }
        let id: String
        let title: String
        let kind: Kind
    }
    struct Spec: Equatable {
        let id: String
        let actions: [ActionSpec]
    }

    static let specs: [Spec] = [
        Spec(id: HegaiNotif.toolApproval, actions: [
            ActionSpec(id: HegaiNotif.deny, title: "Запретить", kind: .destructive),
            ActionSpec(id: HegaiNotif.allow, title: "Разрешить", kind: .authenticated),
        ]),
        Spec(id: HegaiNotif.ask, actions: [
            ActionSpec(id: HegaiNotif.reply, title: "Ответить…", kind: .text(placeholder: "Ответ")),
        ]),
        Spec(id: HegaiNotif.plan, actions: [
            ActionSpec(id: HegaiNotif.reply, title: "Поправить…", kind: .text(placeholder: "Что поправить")),
            ActionSpec(id: HegaiNotif.planAccept, title: "Принять", kind: .authenticated),
        ]),
        Spec(id: HegaiNotif.done, actions: [
            ActionSpec(id: HegaiNotif.reply, title: "Ответить…", kind: .text(placeholder: "Сообщение")),
        ]),
        Spec(id: HegaiNotif.error, actions: [
            ActionSpec(id: HegaiNotif.reply, title: "Ответить…", kind: .text(placeholder: "Сообщение")),
        ]),
    ]

    /// Every action requires an unlocked device except the destructive Deny.
    static func requiresAuthentication(_ a: ActionSpec) -> Bool {
        if case .destructive = a.kind { return false }
        return true
    }

    static func make() -> Set<UNNotificationCategory> {
        Set(specs.map { spec in
            let actions: [UNNotificationAction] = spec.actions.map { a in
                switch a.kind {
                case .button:
                    return UNNotificationAction(identifier: a.id, title: a.title, options: [.authenticationRequired])
                case .destructive:
                    return UNNotificationAction(identifier: a.id, title: a.title, options: [.destructive])
                case .authenticated:
                    return UNNotificationAction(identifier: a.id, title: a.title, options: [.authenticationRequired])
                case .text(let placeholder):
                    // A free-text reply drives the session: it needs an unlocked device.
                    return UNTextInputNotificationAction(identifier: a.id, title: a.title,
                                                         options: [.authenticationRequired],
                                                         textInputButtonTitle: "Отправить",
                                                         textInputPlaceholder: placeholder)
                }
            }
            return UNNotificationCategory(identifier: spec.id, actions: actions,
                                          intentIdentifiers: [], options: [])
        })
    }
}
