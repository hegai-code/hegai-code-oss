import Foundation

/// Как сессия НАЗЫВАЕТСЯ на экране — одна функция на весь продукт.
///
/// Заголовок сессии — это первая строка транскрипта, а её пишет человек или
/// CLI, и выглядеть она может как угодно. Владелец увидел в шапке и в шторке
/// `https://acme.test/m/36804d5d8c1b4e2f...`: имя настоящее, но читается
/// мусором, потому что тридцать значащих символов в нём — хвост идентификатора,
/// а первые двадцать одинаковы у всех таких строк.
///
/// Функция ОДНА и намеренно: имя показывают четыре места (шапка сессии, строка
/// шторки, карточка Flow, «Сессии проекта»), и чинить их по отдельности значит
/// заводить четыре разных представления о том, как называется сессия. Живёт в
/// пакете рядом с `cleanTitle` по той же причине: Foundation-only, без
/// SwiftUI, поэтому её видно и тестам, и всем клиентам.
///
/// Порядок решений — от самого осмысленного к самому вынужденному:
///
///  1. осмысленный заголовок — показываем его;
///  2. заголовок похож на ссылку — хост и короткий хвост пути;
///  3. заголовок пустой — имя проекта или папки;
///  4. не осталось ничего — короткий идентификатор, чтобы строка не была пустой.
public func sessionDisplayName(title: String?,
                               project: String? = nil,
                               cwd: String? = nil,
                               sessionId: String = "") -> String {
    let raw = cleanTitle(title)

    if !raw.isEmpty {
        if let short = shortenedURL(raw) { return short }
        return clamp(tidyPath(raw))
    }

    // Пусто — берём место, где идёт работа. Имя проекта человеку говорит
    // больше, чем «Без названия» в каждой второй строке списка.
    if let project, !project.isEmpty { return clamp(lastPathComponent(project)) }
    if let cwd, !cwd.isEmpty { return clamp(lastPathComponent(cwd)) }
    if !sessionId.isEmpty { return String(sessionId.prefix(8)) }
    return "Сессия"
}

// MARK: - Части

/// Normalized fallback until a semantic navigation title is available.
/// Views keep this on one line and visibly truncate when necessary.
public func compactSessionName(title: String?, project: String? = nil,
                               cwd: String? = nil, sessionId: String = "") -> String {
    let name = sessionDisplayName(title: title, project: project, cwd: cwd, sessionId: sessionId)
        .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    // A fallback is visibly truncated by the view, never a silent fragment
    // such as «Создать веб-сервис для». Semantic shortening is generated and
    // cached by NavigationTitles; manually chosen names remain intact.
    return name
}

/// Верхняя граница длины. Обрезка в вид — это `lineLimit`, а здесь предел
/// нужен другому потребителю: подпись для VoiceOver читается голосом целиком,
/// и заголовок в три тысячи знаков она читает минуту.
private let maxLength = 60

private func clamp(_ s: String) -> String {
    guard s.count > maxLength else { return s }
    return String(s.prefix(maxLength - 1)).trimmingCharacters(in: .whitespaces) + "…"
}

/// Ссылка → `acme.test/m/36804d…`.
///
/// Протокол снимается целиком: `https://` есть у всех и не различает ничего.
/// Последний кусок пути укорачивается, потому что в таких именах он и есть
/// идентификатор — его начала достаточно, чтобы отличить одну сессию от
/// другой, а целиком он вытесняет с экрана всё остальное.
private func shortenedURL(_ s: String) -> String? {
    let lower = s.lowercased()
    guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return nil }
    guard let url = URL(string: s), let host = url.host else {
        // Строка начинается как ссылка, но не разбирается — хотя бы снимем
        // протокол, иначе вернём её целиком и не сделаем ничего.
        let stripped = s.replacingOccurrences(of: "^https?://", with: "",
                                              options: [.regularExpression, .caseInsensitive])
        return clamp(stripped)
    }
    var parts = url.path.split(separator: "/").map(String.init)
    if parts.isEmpty { return host }
    if let last = parts.last, last.count > 8 {
        parts[parts.count - 1] = String(last.prefix(6)) + "…"
    }
    return clamp(([host] + parts).joined(separator: "/"))
}

/// `/hegai-smm/` → `hegai-smm`.
///
/// Такие имена приходят, когда сессию завели командой в папке. Ведущий и
/// хвостовой слэши не несут ничего, а в списке из одних названий они выстраивают
/// колонку пунктуации слева от текста.
private func tidyPath(_ s: String) -> String {
    guard s.hasPrefix("/"), !s.contains(" ") else { return s }
    let trimmed = s.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    return trimmed.isEmpty ? s : trimmed
}

private func lastPathComponent(_ s: String) -> String {
    let parts = s.split(separator: "/").map(String.init)
    return parts.last ?? s
}
