#if DEBUG
import SwiftUI
import CCRemoteKit

// ============================================================================
// Стенд транскрипта — DEBUG-экран, на котором принимают фазу 3 и по которому
// ловят её регрессии. Брат витрины дизайн-системы (`GalleryView`), и по той же
// причине.
//
// Зачем он нужен, если есть живой прод. Затем, что живой прод — плохой
// источник кадров: нужные состояния по заказу не вызываются. Чтобы снять
// «ошибку инструмента», надо, чтобы инструмент на той стороне действительно
// свалился; чтобы снять все три смысловых цвета в одном кадре — чтобы сессия
// именно сейчас читала, писала И падала. Ждать этого — значит снимать то, что
// случилось, а не то, что принимают. Снимок, сделанный «когда повезёт»,
// невозможно повторить через месяц, а именно повторяемость и есть смысл
// базовой картинки.
//
// Поэтому здесь фиксированный транскрипт с фиксированным временем и без сокета:
//
//   * ход человека плашкой справа и ход агента во всю меру;
//   * три смысловых цвета машинных строк рядом друг с другом;
//   * «Показать более ранние» — кнопка, которую иначе снять нечем: она
//     появляется только на сессии длиннее тысячи ходов;
//   * композер под ними — сложенный и с поднятой клавиатурой.
//
// Открывается `CC_TRANSCRIPT=1` (или `CC_SCREEN=transcript`). Время в ходах
// прибито к календарной дате, а не к «сейчас»: иначе разделитель дня менялся
// бы между запусками и диф скриншотов показывал бы это как правку.
// ============================================================================

struct TranscriptFixtureView: View {
    @State private var scrollHistory: [HistoryMessage] = []
    static var isRequested: Bool {
        LaunchAffordances.current.screen == .transcript
    }

    /// Имя человека. На экране его с 22.09 не видно (сторона вместо подписи),
    /// но оно едет в VoiceOver, и стенду оно нужно по той же причине, по
    /// которой было нужно колонке. Настоящий разбор профиля проверяет
    /// `TranscriptVoiceTests`; здесь важно, что это ИМЯ, а не «Вы».
    private static let human = "Владелец"

    /// Что именно снимаем. Посекционно — по той же причине, что и витрина:
    /// скриншот снимает ВИДИМЫЙ кадр, а транскрипт длиннее экрана, и
    /// прокрутить его снаружи нечем. Заодно диф следующих фаз остаётся
    /// читаемым — меняется одна картинка, а не длина всего полотна.
    ///
    ///   `turns`    — ход человека плашкой справа и ход агента во всю меру;
    ///   `earlier`  — «Показать более ранние» над началом ленты;
    ///   `tools`    — три смысловых цвета машинных строк в одном кадре;
    ///   `composer` — поле в фокусе, с многострочным черновиком;
    ///   `suggest`  — полоса подсказок: строка-статус, четыре кнопки, самая
    ///                длинная подпись (60 знаков) — три строки на 375;
    ///   `agents`   — карточки помощников (готов, остановлен, работает) и
    ///                панель «В фоне» над полем ввода; `agents-sheet` — то же
    ///                с открытым транскриптом работающего помощника;
    ///   `preview`  — ответ называет файлы: скриншот (миниатюра), .md (чип),
    ///                недоступный абсолютный путь (приглушённая строка) и
    ///                недоступный относительный (его нет вовсе); байты — из
    ///                `previewSource`, без хаба;
    ///   `1`/`all`  — весь разговор целиком.
    private static var section: String {
        let raw = ProcessInfo.processInfo.environment["CC_TRANSCRIPT"] ?? "1"
        return ["turns", "tools", "composer", "earlier", "scroll", "formatting", "suggest", "agents", "agents-sheet",
                "imagegen-started", "imagegen-done", "imagegen-failed", "preview"].contains(raw) ? raw : "all"
    }

    private var history: [HistoryMessage] {
        switch Self.section {
        case "formatting": return [
            HistoryMessage(role: .user, uuid: "format-u", blocks: [.text("Поправь форматирование и заголовки сессий")]),
            HistoryMessage(role: .assistant, uuid: "format-1", blocks: [.text("Я здесь. Уплотнил строки, уменьшил фон выбранной сессии и поместил молнию внутрь него.")]),
            HistoryMessage(role: .assistant, uuid: "format-tool", blocks: [.toolUse(id: "tool", name: "Build", input: .null)]),
            HistoryMessage(role: .assistant, uuid: "format-2", blocks: [.text("Сборка успешно собрана и подписана, идёт загрузка в Apple.")]),
            HistoryMessage(role: .assistant, uuid: "format-3", blocks: [.text("Apple приняла сборку без ошибок. Осталась обработка на стороне TestFlight.")]),
            HistoryMessage(role: .assistant, uuid: "format-final", blocks: [.text("""
                Готово — **форматирование и названия сессий обновлены**.

                Строки внутри абзаца стали плотнее. Между отдельными сообщениями появился понятный интервал, чтобы они не сливались в стену текста.

                ### Что изменилось

                - Компактные списки с переносами длинных пунктов на следующую строку.
                - Короткие заголовки по смыслу задачи.
                - Ход работы можно раскрыть, итог виден сразу.

                Проверено на **двух размерах iPhone**, в светлой и тёмной темах.
                """)])
        ]
        case "suggest": return [
            HistoryMessage(role: .user, uuid: "suggest-u", blocks: [.text("Тут закончил или ещё что-то предлагаешь?")]),
            HistoryMessage(role: .assistant, uuid: "suggest-a", blocks: [.text("""
                С картинкой закончил, она уже на проде. Ниже два необязательных пункта.

                - **Режим** — советую. После перезапуска хаба сессия показывает «Сначала спрос».
                - **Имя** — не срочно. Сейчас тебя не переименуют, только если агент сам соблюдёт правило.

                Скажи — и возьмусь за режим.
                """)])
        ]
        case "scroll": return scrollHistory
        case "agents", "agents-sheet": return Self.agents
        case "turns": return Self.turns
        case "preview": return Self.previewTurns
        case "tools": return Self.tools
        case "composer", "earlier": return Self.turns
        default: return Self.turns + Self.tools
        }
    }

    var body: some View {
        if Self.section.hasPrefix("imagegen") {
            ImageGenFixtureView(state: String(Self.section.dropFirst("imagegen-".count)))
        } else { chat }
    }

    private var chat: some View {
        // Та же сборка, что у экрана сессии: шапка и композер — inset'ы поверх
        // прокрутки, верхний край гаснет градиентом. Стопкой VStack стенд не
        // показал бы ни текст под островом, ни край под часами.
        ChatView(history: history,
                 loadingHist: false,
                 agent: "Claude",
                 humanOverride: Self.human,
                 // Кнопка догрузки живёт на сессии длиннее тысячи ходов, и
                 // снять её на настоящей — значит сначала такую завести.
                 canLoadEarlier: Self.section == "earlier",
                 onLoadEarlier: {},
                 subagentScope: Self.section.hasPrefix("agents") ? Self.agentScope : nil)
            .chatEdgeFade()
            .environment(\.filePreviewSource, Self.section == "preview" ? Self.previewSource : nil)
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    header
                    if Self.section == "scroll" {
                        Button("Добавить ответ") {
                            scrollHistory.append(HistoryMessage(role: .assistant, uuid: UUID().uuidString,
                                blocks: [.text("НОВЫЙ ОТВЕТ В КОНЦЕ")]))
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // Как на экране сессии: подсказки стоят прямо над композером.
                VStack(spacing: 0) {
                    if Self.section == "suggest", !suggestionDismissed {
                        EnrichStrip(enrichment: Self.suggestion, onReply: { _ in },
                                    onIdea: { _ in }, onDismiss: { suggestionDismissed = true })
                    }
                    ComposerView(isActive: true,
                                 draftKey: Self.draftKey,
                                 onSend: { _, _ in false },
                                 autoFocus: Self.section == "composer")
                }
            }
            .background(Theme.bg)
            .onAppear { HarnessSignals.settled("transcript") }
            .task {
                guard Self.section == "scroll" else { return }
                try? await Task.sleep(for: .milliseconds(400))
                scrollHistory = (0..<100).map { i in
                    HistoryMessage(role: i % 2 == 0 ? .user : .assistant, uuid: "scroll-\(i)",
                        blocks: [.text(i == 99 ? "ПОСЛЕДНЕЕ СООБЩЕНИЕ" : "Сообщение \(i)\n" + String(repeating: "Текст с переменной высотой. ", count: 4 + i % 9))])
                }
            }
    }

    /// Черновик кладётся В ИНИЦИАЛИЗАТОРЕ, а не в `onAppear`: SwiftUI зовёт
    /// `onAppear` ребёнка РАНЬШЕ родительского, так что композер прочитал бы
    /// `DraftStore` до того, как стенд успел туда что-то положить, и кадр
    /// «клавиатура поднята» вышел бы с пустым полем — то есть без роста поля и
    /// с потухшей кнопкой отправки.
    init() {
        // Черновик намеренно ДЛИННЕЕ потолка в шесть строк: кадр обязан
        // показать не «поле выросло», а «поле упёрлось и поехало за кареткой» —
        // начало текста уже за верхним краем, конец виден, курсор на экране.
        DraftStore.save(Self.draftKey, Self.section == "composer" ? """
            Перепроверь композер на 375: поле должно расти до шести строк, а \
            дальше прокручиваться за кареткой, не уезжая из-под курсора. \
            Это и есть та поломка, ради которой поле стало своим UIKit-видом: \
            у штатного вертикального TextField рост есть, а клампа прокрутки \
            нет, и на седьмой строке набранное уходит за нижний край.
            """ : "", scope: "signed-out")
    }

    /// Что хаб отдаёт с 10.10.2026: вердикт + подписи «глагол + предмет».
    /// Четвёртая — почти на потолке в 60 знаков, чтобы кадр показал третью строку.
    /// Не больше трёх; подпись = отправляемому тексту. Самая длинная — почти на
    /// потолке в 60 знаков, чтобы кадр показал вторую строку; идея — отдельным рядом.
    private static let suggestion = Enrichment(quickReplies: [
        .init(label: "Разберись с режимом «Сначала спрос»", send: "Разберись с режимом «Сначала спрос»", kind: "answer"),
        .init(label: "Защити моё имя на хабе", send: "Защити моё имя на хабе", kind: "next"),
        .init(label: "Проверь режим всех живых сессий после деплоя", send: "Проверь режим всех живых сессий после деплоя", kind: "idea"),
    ], handoff: "question")
    @State private var suggestionDismissed = false

    /// Свой ключ черновика — чтобы стенд не подъел черновик настоящей сессии
    /// на том же симуляторе.
    private static let draftKey = "fixture::transcript"

    private var header: some View {
        HStack(spacing: Theme.s2) {
            LeadStatusDot(live: true, working: true)
            Text("Стенд транскрипта")
                .font(.ui(Theme.sizeSmall, weight: .semibold))
                .foregroundStyle(Theme.text)
            Spacer()
            Text(Self.section.uppercased())
                .font(.mono(Theme.sizeMicro, weight: .medium))
                .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
                .foregroundStyle(Theme.textFaint)
        }
        .padding(.horizontal, Theme.s3)
        .padding(.vertical, Theme.s2)
        // Не под часы: там виден гаснущий край переписки, как в чате.
        .background(Theme.surface, ignoresSafeAreaEdges: [])
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.divider).frame(height: 1) }
    }

    // MARK: - Транскрипт

    /// Прибитая дата: 14 августа 2026, Москва. `groupHistory` считает
    /// разделитель дня от НАСТОЯЩЕГО «сейчас», поэтому надпись на нём будет
    /// «14 авг» — и останется ею, в отличие от «сегодня», которое менялось бы
    /// от запуска к запуску.
    private static func at(_ hour: Int, _ minute: Int) -> Double {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Moscow") ?? .current
        let date = cal.date(from: DateComponents(year: 2026, month: 8, day: 14,
                                                 hour: hour, minute: minute))!
        return date.timeIntervalSince1970 * 1000
    }

    private static func user(_ id: String, _ text: String, _ ts: Double) -> HistoryMessage {
        HistoryMessage(role: .user, uuid: id, blocks: [.text(text)], ts: ts)
    }

    private static func agent(_ id: String, _ blocks: [RenderBlock], _ ts: Double) -> HistoryMessage {
        HistoryMessage(role: .assistant, uuid: id, blocks: blocks, ts: ts)
    }

    private static func call(_ id: String, _ name: String, _ input: [String: JSONValue]) -> RenderBlock {
        .toolUse(id: id, name: name, input: .object(input))
    }

    /// Ход человека и ход агента — обе колонки говорящего в одном кадре, с
    /// настоящей иерархией заголовков и кодом внутри ответа (он обязан ехать
    /// вбок и не открывать при этом шторку).
    static let turns: [HistoryMessage] = [
        user("u1", "Почему на 375 пропадает кнопка отправки?", at(9, 5)),

        agent("a1", [.text("""
            ## Причина

            Плейсхолдер вертикального `TextField` **не переносится**, поэтому \
            его полная ширина становится МИНИМУМОМ поля — и на 375pt выдавливает \
            из ряда кнопку отправки.

            ```swift
            GrowingTextField(text: $draft, height: $fieldHeight, maxHeight: fieldCeiling)
                .frame(minHeight: Theme.tapTarget)   // 44, даже когда строка одна
            ```
            """)], at(9, 7)),

        user("u2", "Понял. Правь и собери под SE.", at(9, 8)),
    ]

    /// Ответ с файлами, как его пишет агент: скриншот последней строкой, .md в
    /// обратных кавычках, два пути, которых нет на диске.
    static let previewTurns: [HistoryMessage] = [
        user("pv-u", "Собери письмо и покажи, как оно выглядит.", at(9, 5)),
        agent("pv-a", [.text("""
            Письмо собрано, тема и кнопка на месте. Заметки по вёрстке — в `/srv/fx/NOTES.md`.

            Скриншот: /tmp/agents-0/-srv-fx/296c3cd6/scratchpad/mail.png

            Старый вариант снесён: /tmp/gone/missing.png и docs/hidden.png.
            """)], at(9, 7)),
    ]

    /// Свои байты вместо `fs.peek`: картинка рисуется на месте, markdown — строка,
    /// «missing»/«hidden» не находятся.
    static let previewSource = FilePreviewSource(machineId: "fx", cwd: "/srv/fx", loader: { path, _ in
        if path.contains("missing") || path.contains("hidden") { throw ClientError.rpc("not found") }
        if path.hasSuffix(".md") {
            return Data("# Заметки по вёрстке\n\n- Ширина **600**, как у остальных писем.\n- Кнопка — `Theme.action`.\n".utf8)
        }
        let size = CGSize(width: 1280, height: 800)
        return UIGraphicsImageRenderer(size: size).pngData { context in
            let colors = [UIColor(red: 0.93, green: 0.95, blue: 0.93, alpha: 1).cgColor,
                          UIColor(red: 0.20, green: 0.36, blue: 0.30, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
        }
    })

    /// Помощники: один отработал на переднем плане, второй ушёл в фон и был
    /// остановлен (запоздалое «completed» за «стопом» его не перебивает —
    /// первое окончание побеждает), третий работает прямо сейчас.
    static let agents: [HistoryMessage] = [
        user("ag-u", "Проверь, что сломалось в iOS после деплоя, и почини.", at(10, 2)),
        agent("ag-a1", [
            .text("Запускаю двух помощников: один ищет по коду, второй гоняет тесты."),
            call("ag-t1", "Agent", ["subagent_type": .string("Explore"),
                                    "description": .string("Найти, где iOS разбирает уровень фоновых задач"),
                                    "prompt": .string("…")]),
            call("ag-t2", "Agent", ["subagent_type": .string("general-purpose"),
                                    "description": .string("Прогнать CCRemoteTests на мини"),
                                    "prompt": .string("…"), "run_in_background": .bool(true)]),
        ], at(10, 3)),
        HistoryMessage(role: .user, uuid: "ag-r1", blocks: [
            .toolResult(toolUseId: "ag-t1",
                        text: "Уровень `background_tasks` разбирает `CentralClient`: каждый кадр заменяет прошлый, при переподписке список сбрасывается. Субагентов клиент пока не знает — `data.agents` теряется при декодировании.",
                        isError: false),
            .toolResult(toolUseId: "ag-t2", text: "Async agent launched successfully.", isError: false),
            .text("<task-notification><tool-use-id>ag-t2</tool-use-id><status>stopped</status><result>Остановлен на середине: 212 из 423 тестов зелёные.</result></task-notification>"),
            .text("<task-notification><tool-use-id>ag-t2</tool-use-id><status>completed</status><result>Готово.</result></task-notification>"),
        ], ts: at(10, 9)),
        agent("ag-a2", [
            .text("Нашёл причину. Чиню разбор и проверяю сборку ещё одним помощником."),
            call("ag-t3", "Agent", ["subagent_type": .string("general-purpose"),
                                    "description": .string("Собрать и снять стенд транскрипта"),
                                    "prompt": .string("…")]),
        ], at(10, 11)),
    ]

    /// Живой уровень для стенда: третий помощник работает, плюс фоновая
    /// команда без помощника — обе строки панели над полем ввода.
    private static var agentScope: SubagentScope {
        let now = Date().timeIntervalSince1970 * 1000
        return SubagentScope(
            machineId: "fixture", sessionId: "fixture", cwd: "/fixture", source: "claude", canStop: true,
            fixtureAgents: [
                Subagent(id: "task-3", toolUseId: "ag-t3", kind: "general-purpose",
                         description: "Собрать и снять стенд транскрипта", status: .running,
                         background: true, startedAt: now - 83_000, toolUses: 12, tokens: 41_800,
                         lastAction: "Bash · xcodebuild test -only-testing:CCRemoteTests",
                         recent: ["Read · ios/project.yml", "Bash · xcodegen generate", "Grep · SubagentPanel"],
                         activeAt: now - 65_000),
            ],
            fixtureBackground: [
                RunBackgroundTask(id: "task-3", type: "local_agent",
                                  description: "Собрать и снять стенд транскрипта", since: now - 83_000),
                RunBackgroundTask(id: "bash-1", type: "local_bash", description: "npm run dev", since: now - 312_000),
                RunBackgroundTask(id: "mon-1", type: "local_bash", description: "my shots done", since: now - 1_146_000, owner: "Admin responsive layout, login link", ownerId: "h1"),
                RunBackgroundTask(id: "mon-2", type: "local_bash", description: "my shots done", since: now - 1_136_000, owner: "Admin responsive layout, login link", ownerId: "h1"),
                RunBackgroundTask(id: "mon-3", type: "local_bash", description: "my shots done", since: now - 1_120_000, owner: "Admin responsive layout, login link", ownerId: "h1"),
            ],
            fixtureTranscript: [
                HistoryMessage(role: .user, uuid: "sub-u", blocks: [.text("Собери CCRemote и сними стенд транскрипта на 393.")]),
                HistoryMessage(role: .assistant, uuid: "sub-a", blocks: [
                    .text("Собираю."),
                    .toolUse(id: "sub-t", name: "Bash", input: .object(["command": .string("xcodebuild build")])),
                ]),
                HistoryMessage(role: .user, uuid: "sub-r", blocks: [
                    .toolResult(toolUseId: "sub-t", text: "BUILD SUCCEEDED", isError: false),
                ]),
                HistoryMessage(role: .assistant, uuid: "sub-b", blocks: [.text("Сборка прошла, снимаю экран.")]),
            ],
            fixtureOpen: section == "agents-sheet"
                ? SubagentTarget(toolUseId: "ag-t3", agentId: "task-3", title: "general-purpose · Собрать и снять стенд транскрипта")
                : nil)
    }

    /// Три смысловых цвета рядом. Между прогонами стоит проза не для красоты:
    /// `groupHistory` складывает подряд идущую механику в ОДНУ строку, и без
    /// прозы между ними три цвета слились бы в один прогон.
    static let tools: [HistoryMessage] = [
        // Проза первой: `groupHistory` ставит разделитель дня на первом ходе С
        // ВРЕМЕНЕМ, а прогон времени не несёт — начав с прогона, стенд рисовал
        // бы «14 авг» посреди кадра.
        agent("a1", [.text("Смотрю композер.")], at(9, 9)),

        // ЗЕЛЁНЫЙ — чтение, без последствий.
        agent("a2", [
            call("t1", "Read", ["file_path": .string("Features/Session/ComposerView.swift")]),
            .toolResult(toolUseId: "t1", text: "186 строк", isError: false),
            call("t2", "Grep", ["pattern": .string("layoutPriority")]),
            .toolResult(toolUseId: "t2", text: "1 совпадение", isError: false),
        ], at(9, 9)),

        agent("a3", [.text("Правлю поле и собираю.")], at(9, 10)),

        // EMBER — запись и запуск, с последствиями.
        agent("a4", [
            call("t3", "Edit", ["file_path": .string("Features/Session/ComposerView.swift")]),
            .toolResult(toolUseId: "t3", text: "ok", isError: false),
            call("t4", "Bash", ["description": .string("сборка под SE"),
                                "command": .string("xcodebuild -scheme CCRemote build")]),
            .toolResult(toolUseId: "t4", text: "BUILD SUCCEEDED", isError: false),
        ], at(9, 12)),

        agent("a5", [.text("Собралось. Снимаю экран на 375.")], at(9, 14)),

        // КРАСНЫЙ — ошибка.
        agent("a6", [
            call("t5", "Bash", ["description": .string("скриншот 375"),
                                "command": .string("CC_WIDTHS=375 ./scripts/shoot.sh")]),
            .toolResult(toolUseId: "t5",
                        text: "ERROR: no token. Set CC_TOKEN=… (it is never printed).",
                        isError: true),
        ], at(9, 15)),

        agent("a7", [.text("Нужен UI-токен — тот, которым входит человек.")], at(9, 15)),
    ]
}



/// Карточка нарисованной картинки без хаба: `CC_TRANSCRIPT=imagegen-started|done|failed`.
/// Байты «готовой» картинки кладутся в память хранилища заранее, как будто их
/// отдал `session.image`.
private struct ImageGenFixtureView: View {
    let state: String
    @Environment(CentralClient.self) private var client
    @State private var seeded = false
    private static let source = TranscriptImageSource(machineId: "fx", sessionId: "fx", source: "claude")
    private static let prompt = "Рыжий кот в очках сидит на подоконнике, за окном дождь, акварель, мягкий свет, много воздуха и деталей"

    private var card: ImageGenCard {
        switch state {
        case "done":
            return ImageGenCard(id: "fx", state: .done, firstSeen: 0, prompt: Self.prompt, ref: "gen:fx")
        case "failed":
            return ImageGenCard(id: "fx", state: .failed, firstSeen: 0, error: "лимит подписки исчерпан")
        default:
            return ImageGenCard(id: "fx", state: .started, startedAt: (Date().timeIntervalSince1970 - 34) * 1000,
                                firstSeen: 0, prompt: Self.prompt)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                TurnRow(speaker: TurnSpeaker(name: "Claude", isHuman: false, ts: nil)) {
                    Text("Сейчас нарисую.").font(.chatBody).foregroundStyle(Theme.text)
                }
                if seeded || state != "done" {
                    TurnRow(speaker: TurnSpeaker(name: "Claude", isHuman: false, ts: nil)) { ImageGenCardView(card: card) }
                }
            }
            .padding(.horizontal, Theme.s4).padding(.top, 80)
        }
        .background(Theme.bg)
        .environment(\.transcriptImageSource, Self.source)
        .task {
            if state == "done" {
                let key = TranscriptImageStore.Key(scope: client.storageScope, source: Self.source, ref: "gen:fx")
                _ = await TranscriptImageStore.shared.load(key) { try Self.picture() }
            }
            seeded = true
            HarnessSignals.settled("transcript")
        }
    }

    @MainActor private static func picture() throws -> SessionImageResult {
        let size = CGSize(width: 1024, height: 1280)
        let data = UIGraphicsImageRenderer(size: size).pngData { context in
            let colors = [UIColor(red: 0.96, green: 0.62, blue: 0.36, alpha: 1).cgColor,
                          UIColor(red: 0.25, green: 0.36, blue: 0.62, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
        }
        let json = #"{"mediaType":"image/png","dataB64":"\#(data.base64EncodedString())"}"#
        return try JSONDecoder().decode(SessionImageResult.self, from: Data(json.utf8))
    }
}
#endif
