import SwiftUI

/// One session on the wrist (docs/WATCH.md §7): a status card first (ring,
/// timer, current step), then whatever it needs from you — an answer, a plan to
/// accept, or after a finished turn «что дальше» — then its plan as a
/// checklist and the last few messages.
struct DetailView: View {
    @ObservedObject var store: WatchStore
    let item: WatchInboxItem

    @Environment(\.scenePhase) private var scenePhase
    @State private var text = ""
    @State private var sending = false
    /// A reply went out and the run has not changed state yet.
    @State private var sent = false
    @State private var history: WatchHistory?
    #if DEBUG
    /// Screenshot fixture (`-watchFixture`): history without a hub.
    var fixture: WatchHistory?
    #endif
    @State private var historyError: String?
    @State private var historyGeneration = 0

    private var questions: [WatchQuestion] { item.questions ?? [] }
    /// The turn just ended and the hub's digest («что дальше») is still on its
    /// way: it comes seconds after the idle state (WATCH.md §4).
    private var awaitingDigest: Bool { item.digestPending == true && item.summary == nil }
    /// Something is going on that the screen should follow by itself — or a
    /// reply went out and the run has not picked it up yet.
    private var live: Bool { item.isWorking || item.isWaiting || sent || awaitingDigest }
    /// Messages shown inline; the rest is one tap away.
    private let inlineMessages = 4

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                #if DEBUG
                // Screenshot aid: `-watchSkipCard` shows what sits under the card.
                if !ProcessInfo.processInfo.arguments.contains("-watchSkipCard") { StatusCard(item: item) }
                #else
                StatusCard(item: item)
                #endif
                if let error = store.lastActionError {
                    Text("Не отправилось: \(error)").font(.caption2).foregroundStyle(WatchTheme.ember)
                }
                // While it works the plan is the news; otherwise the action is.
                if item.isWorking { checklist }
                content.disabled(sending)
                if !item.isWorking { checklist }
                historySection
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle(item.machine)
        .task { await loadHistory() }
        // While it runs, follow it: the inbox (state, plan, timer base) every
        // 5 s, the conversation every 15 s. Stops with the screen or the run.
        .task(id: [live, scenePhase == .active]) {
            // Keyed on the scene too: a lowered wrist cancels the loop.
            guard live, scenePhase == .active else { return }
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if Task.isCancelled { break }
                await store.refresh()
                tick += 1
                if tick % 3 == 0 { await loadHistory() }
            }
        }
        // A new state OR a new moment in the same state: a turn that started
        // and ended between two polls reads idle → idle with a later time.
        .onChange(of: "\(item.state)|\(item.activityMs ?? 0)") { _, _ in
            sent = false
            Task { await loadHistory() }
        }
    }

    @ViewBuilder private var checklist: some View {
        if let p = item.progress, p.total > 0, !(p.steps ?? []).isEmpty {
            PlanChecklist(progress: p).padding(.vertical, 2)
        }
    }

    @ViewBuilder private var historySection: some View {
        if let history {
            if !history.items.isEmpty {
                Text("Переписка").font(.caption.weight(.semibold)).foregroundStyle(WatchTheme.muted)
                    .padding(.top, 4)
                ForEach(Array(history.items.suffix(inlineMessages).enumerated()), id: \.offset) { _, msg in
                    HistoryRow(item: msg)
                }
                NavigationLink {
                    FullHistoryView(store: store, item: item, initial: history)
                } label: {
                    Label("Вся переписка", systemImage: "text.bubble")
                }
                .buttonStyle(WatchButtonStyle())
            }
        } else if let historyError {
            Text(historyError).font(.caption2).foregroundStyle(WatchTheme.ember)
            Button("Повторить") { Task { await loadHistory() } }.buttonStyle(WatchButtonStyle())
        } else {
            HStack(spacing: 6) {
                ProgressView()
                Text("Загружаю переписку…").font(.caption2).foregroundStyle(WatchTheme.muted)
            }
        }
    }

    private func loadHistory() async {
        #if DEBUG
        if let fixture { history = fixture; return }
        #endif
        guard let creds = store.credentials ?? WatchKeychain.load() else { return }
        // Loads overlap (poll, state change, after a send): the newest wins.
        historyGeneration += 1
        let mine = historyGeneration
        do {
            let h = try await WatchAPI.fetchHistory(creds, machineId: item.machineId,
                                                    sessionId: item.sessionId, source: item.source,
                                                    limit: 24)
            guard mine == historyGeneration else { return }
            historyError = nil
            history = h
        } catch where mine != historyGeneration {
            return
        } catch WatchInboxError.unsigned {
            historyError = "Открой Hegai Code на iPhone"
        } catch WatchInboxError.forbidden {
            historyError = "Нет доступа к переписке"
        } catch WatchInboxError.http(404) {
            if history == nil { history = WatchHistory(items: [], more: false) }
        } catch {
            // Keep what is on screen when only a refresh failed.
            if history == nil { historyError = "Не удалось загрузить переписку" }
        }
    }

    @ViewBuilder private var content: some View {
        if item.isWaiting, item.requestId == nil {
            // The hub offers nothing to act on (a private machine refuses push
            // actions): say where it can be answered.
            Text(item.tool.map { "Ждёт: \($0)" } ?? "Нужен ответ").font(.footnote)
            Text("Ответь на iPhone").font(.caption2).foregroundStyle(WatchTheme.muted)
        } else if item.isWaiting, item.tool == "ExitPlanMode" || item.plan != nil, questions.isEmpty {
            planSection
        } else if item.isWaiting, questions.count == 1 {
            QuestionView(question: questions[0]) { answer in
                send(runId: item.runId, requestId: item.requestId, action: "answer",
                     answers: [questions[0].key: answer])
            }
        } else if item.isWaiting, questions.count > 1 {
            // Several questions at once: one dictated answer goes to the hub as
            // text (WATCH.md §3 turns it into a deny message).
            ForEach(questions.indices, id: \.self) { i in
                Text(questions[i].question).font(.footnote)
            }
            TextField("Ответить", text: $text)
                .submitLabel(.send)
                .onSubmit {
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    send(runId: item.runId, requestId: item.requestId, action: "answer", text: t)
                    text = ""
                }
        } else if item.isWaiting {
            // A tool approval (rare since approvals are off by default): decided
            // here too — the hub's session mode takes allow/deny (WATCH.md §3).
            Text(item.tool.map { "Хочет запустить \($0)" } ?? "Нужен ответ").font(.footnote)
            // allow/deny fit a plain tool only; a question the hub could not
            // read out (a private machine) is answered on the iPhone.
            if item.tool != "AskUserQuestion", item.tool != "ExitPlanMode" {
                Button("Разрешить") {
                    send(runId: item.runId, requestId: item.requestId, action: "allow")
                }.buttonStyle(WatchButtonStyle(prominent: true))
                Button("Запретить", role: .destructive) {
                    send(runId: item.runId, requestId: item.requestId, action: "deny")
                }.buttonStyle(WatchButtonStyle())
            } else {
                Text("Ответь на iPhone").font(.caption2).foregroundStyle(WatchTheme.muted)
            }
        } else {
            replySection
        }
    }

    private var planSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let plan = item.plan { Text(plan).font(.footnote) }
            Button("Принять") {
                send(runId: item.runId, requestId: item.requestId, action: "plan_accept")
            }.buttonStyle(WatchButtonStyle(prominent: true))
            TextField("Поправить", text: $text)
                .submitLabel(.send)
                .onSubmit {
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    send(runId: item.runId, requestId: item.requestId, action: "plan_revise", text: t)
                    text = ""
                }
        }
    }

    private var replySection: some View {
        NextStepsView(item: item, sending: sending, sent: sent) { t in
            send(runId: item.runId, requestId: nil, action: "reply", text: t)
        }
    }

    private func send(runId: String?, requestId: String?, action: String, text: String? = nil,
                      answers: [String: AnswerValue]? = nil) {
        sending = true
        let body: PushActionBody
        if let runId {
            body = PushActionMapper.sessionBody(runId: runId, requestId: requestId, action: action,
                                                text: text, answers: answers)
        } else {
            body = PushActionMapper.sessionReplyBody(machineId: item.machineId, sessionId: item.sessionId,
                                                     source: item.engine, text: text ?? "")
        }
        Task {
            let ok = await store.perform(body)
            sending = false
            if ok && action == "reply" { sent = true }
            await loadHistory()
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await loadHistory()
        }
    }
}

/// One line of the conversation: user right and tinted, assistant left, tools grey and small.
struct HistoryRow: View {
    let item: WatchHistoryItem

    var body: some View {
        switch item.role {
        case "user":
            HStack {
                Spacer(minLength: 20)
                Text(item.text).font(.footnote).foregroundStyle(WatchTheme.ivory)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(WatchTheme.ember.opacity(0.28), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        case "tool":
            Text(item.text).font(.caption2).foregroundStyle(WatchTheme.muted).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        default:
            HStack {
                Text(item.text).font(.footnote).foregroundStyle(WatchTheme.ivory)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(WatchTheme.chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                Spacer(minLength: 12)
            }
        }
    }
}

/// The whole tail of the conversation (WATCH.md §4b), newest at the bottom,
/// with «Ещё раньше» for up to 40 messages.
struct FullHistoryView: View {
    @ObservedObject var store: WatchStore
    let item: WatchInboxItem
    let initial: WatchHistory

    @State private var history: WatchHistory?
    @State private var limit = 24
    @State private var loading = false
    /// Row to keep in view after «Ещё раньше» prepends older items.
    @State private var anchorId: Int?

    private var shown: WatchHistory { history ?? initial }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if shown.more && limit < 40 {
                        Button("Ещё раньше") {
                            anchorId = shown.items.count - 1
                            limit = 40
                            Task { await load() }
                        }
                        .buttonStyle(WatchButtonStyle())
                        .disabled(loading)
                    }
                    // Id = distance from the newest message, stable when older ones are prepended.
                    ForEach(Array(shown.items.enumerated()), id: \.offset) { index, msg in
                        HistoryRow(item: msg).id(shown.items.count - 1 - index)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 4)
            }
            .onAppear {
                DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: history) { _, _ in
                DispatchQueue.main.async {
                    if let anchor = anchorId {
                        proxy.scrollTo(anchor, anchor: .top)
                        anchorId = nil
                    }
                }
            }
        }
        .navigationTitle("Переписка")
    }

    private func load() async {
        guard let creds = store.credentials ?? WatchKeychain.load() else { return }
        loading = true
        defer { loading = false }
        if let h = try? await WatchAPI.fetchHistory(creds, machineId: item.machineId,
                                                    sessionId: item.sessionId, source: item.source,
                                                    limit: limit) {
            history = h
        }
    }
}
