import Foundation

public enum SignerError: Error, LocalizedError, Equatable {
    case keyExists
    case keyIncomplete
    case keychain(String)
    case noKey
    case noSecureEnclave
    case keyCorrupted(String)
    case badURL(String)
    case network(String)
    case hubStatus(Int, String)
    case tooLarge
    case shaMismatch(expected: String, actual: String)
    case notExternal(String)
    case noVersion
    case versionMismatch(expected: String, actual: String)
    case badPending(String)
    case selfVerifyFailed

    public var errorDescription: String? {
        switch self {
        case .keyExists: return "Ключ уже существует. Для замены используйте «Новый ключ»."
        case .keyIncomplete: return "Файлы ключа неполные — восстановите или сделайте «Новый ключ»."
        case .keychain(let m): return "Связка ключей / Secure Enclave: \(m)"
        case .noKey: return "Ключ ещё не создан."
        case .noSecureEnclave: return "На этом Mac нет Secure Enclave."
        case .keyCorrupted(let m): return "Файлы ключа повреждены: \(m)"
        case .badURL(let u): return "Недопустимый адрес сборки (нужен https://code.acme.test/…): \(u)"
        case .network(let m): return "Сетевая ошибка: \(m)"
        case .hubStatus(let c, let m):
            switch c {
            case 400: return "Хаб отклонил подпись (400): \(m)"
            case 429: return "Слишком много попыток (429): \(m)"
            case 409: return "Этот релиз уже не ожидает подписи (409): \(m)"
            default: return "Хаб ответил \(c): \(m)"
            }
        case .tooLarge: return "Сборка больше 32 МБ — отказ."
        case .shaMismatch(let e, let a): return "sha256 скачанной сборки не совпал.\nОжидали \(e)\nПолучили \(a)"
        case .notExternal(let e): return "Это не внешняя сборка (редакция: \(e)) — отказ."
        case .noVersion: return "В сборке не найдена версия."
        case .versionMismatch(let e, let a): return "Версия в сборке (\(a)) не совпала с заявленной (\(e))."
        case .badPending(let m): return "Некорректный ответ хаба: \(m)"
        case .selfVerifyFailed: return "Самопроверка подписи не прошла — подпись не отправлена."
        }
    }
}
