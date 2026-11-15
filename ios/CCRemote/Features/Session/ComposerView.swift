import SwiftUI
import CCRemoteKit

/// Текст и картинки, которые кладут в композер СНАРУЖИ.
///
/// Ровно один поставщик — передача из «Поделиться»: человек выделил кусок в
/// Safari и отправил его сюда. Новый `id` означает новую передачу, поэтому та
/// же самая не приезжает второй раз на следующем кадре.
struct ComposerSeed: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var images: [ImageAttachment]
    /// Also put the keyboard in the field — for a suggestion the person is about
    /// to edit (an `idea` from the strip), not for a share they will review.
    var focuses = false
}

/// The message composer. Send when a run is active; Resume (open) when dormant;
/// Stop (interrupt) while busy. Carries optional image attachments (screenshots,
/// photos) alongside the text.
struct ComposerView<SettingsControl: View>: View {
    let isActive: Bool
    /// Persists the half-typed draft across leaving the session / app restarts.
    let draftKey: String
    /// Returns whether the turn was accepted; the composer only clears its draft +
    /// attachments when it was, so a failed send (socket down) doesn't lose them.
    let onSend: (String, [ImageAttachment]) -> Bool
    /// Bump to re-read the stored draft into an EMPTY field — the host writes
    /// a refused quick reply into `DraftStore`, and the field only reads it on
    /// appear otherwise.
    var draftReload: Int = 0
    /// Request keyboard focus once when the new-conversation screen becomes active.
    var autoFocus: Bool = false
    /// Переданное снаружи (из «Поделиться»). См. `takeSeed`.
    var seed: ComposerSeed? = nil
    /// Передачу приняли — хост гасит её у себя, иначе она приедет снова.
    var onSeedTaken: (() -> Void)? = nil
    /// Распознаватель, когда им владеет ХОСТ. Нужен ровно одному экрану:
    /// на стартовом чип «Рамблинг» и есть кнопка микрофона, а значит включать
    /// диктовку умеет не только сам композер. Два распознавателя на экран
    /// невозможны — аудио-сессия одна, и второй забрал бы её у первого.
    var hostDictation: SpeechDictation? = nil
    /// A new run gaining its permanent session id is still the same draft.
    var preservesDraftOnKeyChange: Bool = false
    var alwaysExpanded: Bool = false
    var placeholderText: String? = nil
    var showsRunControls = true
    /// Home reserves a separate area; only a transcript needs an opaque fade.
    var overlaysTranscript = true
    /// A draft typed before choosing the first project on this server follows it.
    var migratesDraftFrom: String?
    /// Builds the `/polish` request for a finished dictation — the host knows
    /// the project, the title and the conversation the words come from. Nil:
    /// no clean-up, the recognizer's text stays as it is.
    var polishContext: ((String) -> PolishRequest)? = nil
    /// The machine is private (docs/E2EE.md): dictation is recognised and cleaned
    /// up by the hub, which would read the words it must not read, and a draft is
    /// not parked in UserDefaults - neither is offered here.
    var privateMachine: Bool = false
    private var allowsDictation: Bool { !privateMachine }
    private let settingsControl: () -> SettingsControl

    init(isActive: Bool, draftKey: String,
         onSend: @escaping (String, [ImageAttachment]) -> Bool,
         draftReload: Int = 0, autoFocus: Bool = false,
         seed: ComposerSeed? = nil, onSeedTaken: (() -> Void)? = nil,
         hostDictation: SpeechDictation? = nil,
         preservesDraftOnKeyChange: Bool = false,
         alwaysExpanded: Bool = false, placeholderText: String? = nil,
         showsRunControls: Bool = true, overlaysTranscript: Bool = true, migratesDraftFrom: String? = nil,
         polishContext: ((String) -> PolishRequest)? = nil,
         privateMachine: Bool = false,
         @ViewBuilder settingsControl: @escaping () -> SettingsControl = { EmptyView() }) {
        self.isActive = isActive
        self.draftKey = draftKey
        self.onSend = onSend
        self.draftReload = draftReload
        self.autoFocus = autoFocus
        self.seed = seed
        self.onSeedTaken = onSeedTaken
        self.hostDictation = hostDictation
        self.preservesDraftOnKeyChange = preservesDraftOnKeyChange
        self.alwaysExpanded = alwaysExpanded
        self.placeholderText = placeholderText
        self.showsRunControls = showsRunControls
        self.overlaysTranscript = overlaysTranscript
        self.migratesDraftFrom = migratesDraftFrom
        self.polishContext = polishContext
        self.privateMachine = privateMachine
        self.settingsControl = settingsControl
    }

    @Environment(CentralClient.self) private var client
    @State private var draft = ""
    @State private var draftScope: String?
    @State private var attachments: [ImageAttachment] = []
    // The recognizer outlives the conditional trailing control. Otherwise the first
    // partial word can destroy the object that owns the active audio session.
    @State private var ownDictation = SpeechDictation()
    @State private var dictationBaseText = ""
    @State private var dictationSendRequested = false
    @State private var dictationSendTask: Task<Void, Never>?
    /// The last dictation's two spellings, while the shown one is in the box.
    @State private var dictationPair: DictationPair?
    @State private var polishTask: Task<Void, Never>?
    @State private var polishing = false
    /// Server recognition («Распознаю…») of the recording that just ended.
    @State private var transcribing = false
    /// «Отправить запись»: server recognition + safe rewrite run before the send.
    @State private var preparingSend = false
    /// Set when the rewrite failed; the caption shows while that text is in the box.
    @State private var polishFailedAnchor: DictationPair?
    /// The hub could not be reached for a recording: its audio is kept for
    /// «Повторить» while the phone's text of it is still in the box.
    @State private var unrecognized: UnrecognizedRecording?
    private var dictation: SpeechDictation { hostDictation ?? ownDictation }
    /// Focus is reported by the underlying text view.
    @State private var focused = false
    /// A seed just landed in the field (an idea from the suggestion strip): ask
    /// the text view for the keyboard once. Cleared when focus arrives, so a
    /// later manual dismissal is not undone.
    @State private var seedFocusRequested = false
    @State private var keepExpandedForControl = false
    /// Текущая высота поля — её считает само поле под свой текст.
    @State private var fieldHeight: CGFloat = 0

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }
    // A busy run takes input directly into the conversation now — the
    // placeholder must not promise a queue that no longer exists.
    private var placeholder: String { placeholderText ?? (isActive ? "Сообщение…" : "Продолжить…") }

    /// Потолок роста поля — шесть строк ТЕКУЩЕГО кегля. Считается от
    /// начертания, а не константой: при крупном системном тексте «шесть строк»
    /// в пунктах прошлого кегля — это четыре строки нынешнего.
    private var fieldCeiling: CGFloat { GrowingTextField.height(lines: 6) }

    private var expanded: Bool { alwaysExpanded || focused || canSend || dictation.active || preparingSend || autoFocus || seedFocusRequested || keepExpandedForControl }

    var body: some View {
        VStack(spacing: Theme.s2) {
            if dictation.active {
                DictationPreview(text: dictation.transcript, finalizing: dictation.finalizing)
            } else if polishing || transcribing || dictationPair != nil || polishFailedAnchor != nil || unrecognized != nil {
                polishCaption
            }
            if !attachments.isEmpty { AttachmentStrip(attachments: $attachments) }
            VStack(spacing: 0) {
                if dictation.active {
                    DictationWaveform(levels: dictation.levels)
                        .frame(minHeight: Theme.tapTarget)
                        .padding(.horizontal, Theme.s3)
                } else {
                    // Keep the editor at the same structural position through
                    // expansion: replacing it would drop the first tap/keyboard.
                    HStack(spacing: Theme.s1) {
                        if !expanded {
                            AttachButton(attachments: $attachments, size: Theme.iconButton, filled: false)
                        }
                        field.padding(.horizontal, expanded ? Theme.s2 : 0)
                        if !expanded {
                            if allowsDictation {
                                MicButton(text: $draft, baseText: $dictationBaseText, dictation: dictation, size: Theme.iconButton, filled: false)
                            }
                            trailingButtons
                        }
                    }
                }
                if expanded {
                    HStack(spacing: Theme.s1) {
                        if dictation.active {
                            Button {
                                cancelDictation()
                                draft = dictationBaseText
                                Haptics.light()
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 20, weight: .medium))
                                    .foregroundStyle(Theme.textMuted)
                                    .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Отменить запись")
                            .accessibilityIdentifier("composer.cancelDictation")
                        } else {
                            AttachButton(attachments: $attachments, size: Theme.iconButton, filled: false)
                                .simultaneousGesture(TapGesture().onEnded { keepExpandedForControl = true })
                        }
                        Spacer(minLength: 0)
                        if showsRunControls, isActive, let usage = client.contextUsage {
                            ContextUsageControl(usage: usage)
                                .simultaneousGesture(TapGesture().onEnded { keepExpandedForControl = true })
                        }
                        settingsControl()
                            .simultaneousGesture(TapGesture().onEnded { keepExpandedForControl = true })
                            .padding(.trailing, Theme.s2)
                        // Photos and typed text can be accompanied by dictation.
                        // Only recognition finalization temporarily hides the mic.
                        if allowsDictation, !dictation.finalizing, !preparingSend {
                            MicButton(text: $draft, baseText: $dictationBaseText, dictation: dictation, size: Theme.iconButton, filled: false)
                        }
                        trailingButtons
                    }
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .padding(.vertical, Theme.s1)
            .background(Theme.composerBackground,
                        in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(Theme.rim, lineWidth: 1)
            }
            .shadow(color: Theme.shadow.color, radius: Theme.shadow.radius, y: Theme.shadow.y)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("composer.island")
            // Dragging a screenshot in from Finder is the first thing people try
            // on a Mac; the pill used to refuse it silently.
            .attachmentDrop($attachments)
        }
        // safeAreaInset must reserve the whole island, including its action row.
        // On short screens a compressed proposal otherwise pushes buttons below
        // the keyboard even though the editor itself has the correct height.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, expanded ? Theme.s3 : Theme.s6)
        .padding(.top, overlaysTranscript ? Theme.s2 : 0)
        .padding(.bottom, Theme.s2)
        .frame(maxWidth: Theme.readingWidth)
        .frame(maxWidth: .infinity)
        // Под островом нет подложки на всю ширину (08.10.2026, как в ChatGPT):
        // переписка видна по бокам и гаснет маской прокрутки (`chatEdgeFade`).
        // Leaving the session must not eat a half-typed message: the draft
        // saves as you type and comes back on return. A successful send clears
        // it (the onChange below sees the emptied field).
        .onAppear {
            draftScope = client.storageScope
            if draft.isEmpty { draft = loadDraft(draftKey, scope: draftScope) }
        }
        .onChange(of: client.storageScope) { _, scope in
            cancelDictation()
            if let draftScope { saveDraft(draftKey, draft, scope: draftScope) }
            let firstVerification = draftScope?.hasPrefix("credential-") == true && scope.hasPrefix("account-")
            draftScope = scope
            if firstVerification, !draft.isEmpty || !attachments.isEmpty {
                // Text entered while the first authenticated snapshot was being
                // decoded belongs to this login; do not erase it at verification.
                let saved = loadDraft(draftKey, scope: scope)
                if !saved.isEmpty, saved != draft {
                    draft = draft.isEmpty ? saved : saved + "\n\n" + draft
                }
                saveDraft(draftKey, draft, scope: scope)
            } else {
                draft = loadDraft(draftKey, scope: scope)
                attachments = []
            }
        }
        .onChange(of: privateMachine, initial: true) { was, now in
            // Leaving a private target: what was typed there must not be saved under a normal one.
            if was, !now { draft = ""; attachments = []; return }
            guard now else { return }
            // A machine that is (or became) private: stop a recording that would go
            // to the hub's recogniser, and forget a draft saved before.
            if dictation.active { cancelDictation() }
            // Nothing already under way may still reach the hub's recogniser or polish.
            polishTask?.cancel(); polishTask = nil; polishing = false
            dictationSendTask?.cancel(); dictationSendTask = nil; preparingSend = false
            transcribing = false
            dropUnrecognized()
            DraftStore.save(draftKey, "", scope: draftScope)
        }
        .onChange(of: draftReload) { _, _ in if draft.isEmpty { draft = loadDraft(draftKey, scope: draftScope) } }
        .onChange(of: draft) { _, now in
            saveDraft(draftKey, now, scope: draftScope)
            if let pair = dictationPair, !pair.visible(in: now) { dictationPair = nil }
            if let failed = polishFailedAnchor, !failed.visible(in: now) { polishFailedAnchor = nil }
            if let kept = unrecognized, !kept.anchor.visible(in: now) { dropUnrecognized() }
        }
        .onChange(of: dictation.active) { was, active in
            // Also capture when the host starts recording from «Рамблинг».
            // Run before transcript observers can append the first partial.
            if !was && active {
                dropPolish()
                dropUnrecognized()
                dictationBaseText = draft
                dictationSendRequested = false
            }
        }
        .onChange(of: dictation.transcript) { _, text in
            guard dictation.active, !dictationSendRequested else { return }
            draft = dictatedText(text)
        }
        .onChange(of: dictation.recording) { _, recording in
            // A new recording may yield exactly the same transcript as the
            // previous one (including synchronous fixture recognition).
            if recording { dictationSendRequested = false }
            guard recording, !dictation.transcript.isEmpty else { return }
            draft = dictatedText(dictation.transcript)
        }
        .onChange(of: dictation.active) { was, active in
            if was && !active && !dictationSendRequested && !dictation.transcript.isEmpty {
                draft = dictatedText(dictation.transcript)
                let base = dictationBaseText.trimmingCharacters(in: .whitespacesAndNewlines)
                startPostProcessing(onDevice: dictation.transcript, after: base.isEmpty ? "" : base + " ")
            } else if was && !active && !dictationSendRequested {
                // Nothing recognized on the phone: the recording may still hold speech.
                let base = dictationBaseText.trimmingCharacters(in: .whitespacesAndNewlines)
                startPostProcessing(onDevice: "", after: base.isEmpty ? "" : base + " ")
            }
        }
        .onChange(of: draftKey) { was, now in
            if !preservesDraftOnKeyChange { cancelDictation() }
            moveDraft(from: was, to: now)
        }
        // `initial: true` — передача может приехать РАНЬШЕ, чем смонтируется
        // композер: `onOpenURL` срабатывает на холодном старте до первого кадра,
        // и наблюдатель «только на изменение» тогда не сработал бы никогда.
        .onChange(of: seed?.id, initial: true) { _, _ in takeSeed() }
        .onDisappear { cancelDictation() }
        .alert("Диктовка", isPresented: dictationAlertPresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(dictation.errorText ?? "")
        }
    }

    /// Само поле: растёт под текст, на пределе прокручивается за кареткой.
    /// Плейсхолдер — слой поверх, а не свойство `UITextView`: у него его нет, и
    /// подделка через «серый текст, который стирается на первом нажатии»
    /// ломается о восстановленный черновик.
    private var field: some View {
        GrowingTextField(text: $draft,
                         height: $fieldHeight,
                         maxHeight: fieldCeiling,
                         onFocusChange: { focused = $0; if $0 { keepExpandedForControl = false; seedFocusRequested = false } },
                         autoFocus: autoFocus || seedFocusRequested)
            // Keep one-line text centered in the tap target, and reserve the
            // full editor height. A flexible minHeight outer frame could shrink
            // while UITextView stayed tall, hiding lines beneath the actions.
            .frame(height: max(fieldHeight, GrowingTextField.height(lines: 1)))
            .frame(height: max(Theme.tapTarget, fieldHeight, GrowingTextField.height(lines: 1)))
            .overlay(alignment: .leading) {
                if draft.isEmpty {
                    Text(placeholder)
                        .font(.ui(Theme.sizeBody))
                        .foregroundStyle(Theme.textFaint)
                        .allowsHitTesting(false)
                }
            }
            .padding(.leading, Theme.s1)
            // Лишняя ширина достаётся полю, а не кнопкам.
            .layoutPriority(1)
            .disabled(dictation.finalizing || preparingSend)
    }

    private var dictationAlertPresented: Binding<Bool> {
        Binding(
            get: { dictation.errorText != nil },
            set: { if !$0 { dictation.clearError() } }
        )
    }

    /// Context budget above the composer: a thin bar, the percentage, and a
    /// Compact action. The warning tone keys off the runtime's own auto-compact
    /// threshold rather than a fixed number — that point differs per runtime,
    /// and it is the last moment the user can still choose to act.
    /// The same compact send action in active and resumable sessions leaves
    /// enough room for the model label; the accessibility label names resume.
    @ViewBuilder private var trailingButtons: some View {
        if preparingSend {
            HStack(spacing: Theme.s2) {
                ProgressView().controlSize(.small)
                Text("Дописываю…").font(.ui(Theme.sizeMicro))
            }
            .foregroundStyle(Theme.textMuted)
            .frame(minHeight: Theme.tapTarget)
            .padding(.horizontal, Theme.s2)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("composer.finalizingDictation")
        } else if dictation.active {
            if dictation.finalizing {
                HStack(spacing: Theme.s2) {
                    ProgressView().controlSize(.small)
                    Text("Дописываю…").font(.ui(Theme.sizeMicro))
                }
                .foregroundStyle(Theme.textMuted)
                .frame(minHeight: Theme.tapTarget)
                .padding(.horizontal, Theme.s2)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("composer.finalizingDictation")
            } else if dictation.recording {
                SendCircle(round: true, size: Theme.composerActionSize) { sendDictation() }
                    .disabled(client.isChangingModel)
                    .accessibilityLabel("Отправить запись")
                    .accessibilityIdentifier("composer.sendDictation")
            }
        } else {
            if canSend {
                SendCircle(round: true, size: Theme.composerActionSize) { send() }
                    .disabled(client.isChangingModel)
                    .accessibilityLabel(isActive ? "Отправить" : "Продолжить")
            } else if showsRunControls, client.busy {
                SendCircle(round: true, stop: true, size: Theme.composerActionSize) { client.interrupt(); Haptics.rigid() }
            }
        }
    }

    /// Черновик принадлежит МЕСТУ, а место под ним меняется.
    ///
    /// На стартовом экране это проект, и его переключают прямо под набранным
    /// текстом; у только что начатой сессии место меняется само, когда
    /// `session_started` называет её id. Без этого текст места A сохранялся бы
    /// под ключом B и стирал то, что в B лежало, — молча и для каждого места,
    /// через которое прошли.
    ///
    /// ПУСТОЙ ключ — это «место ещё не известно», а не место с пустым именем.
    /// Так выглядит стартовый экран, пока не приехала опись: всё, что набрано в
    /// это окно, принадлежит тому проекту, на который мы вот-вот встанем, и
    /// выбрасывать это по первому же разрешению нельзя.
    private func moveDraft(from was: String, to now: String) {
        if preservesDraftOnKeyChange || was == migratesDraftFrom {
            let saved = loadDraft(now, scope: draftScope)
            if draft.isEmpty { draft = saved }
            else if !saved.isEmpty, saved != draft { draft = saved + "\n\n" + draft }
            saveDraft(now, draft, scope: draftScope)
            saveDraft(was, "", scope: draftScope)
            return
        }
        if was.isEmpty {
            if !draft.isEmpty { saveDraft(now, draft, scope: draftScope); return }
        } else {
            saveDraft(was, draft, scope: draftScope)
        }
        draft = loadDraft(now, scope: draftScope)
    }

    /// Положить переданное снаружи в поле — один раз и НЕ затирая набранного.
    ///
    /// Раньше передача открывала отдельную форму новой сессии и была там одна.
    /// Теперь она садится в композер, у которого уже может быть черновик, —
    /// значит появилось, что потерять. Поэтому переданное встаёт ПОСЛЕ
    /// набранного, а не вместо: и то и другое — предложения человека, и ни одно
    /// не должно исчезать молча. Картинки просто добавляются, с тем же
    /// потолком в четыре, который обещает само расширение.
    private func takeSeed() {
        guard let seed else { return }
        let incoming = seed.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !incoming.isEmpty {
            if dictation.active {
                // Mid-dictation the draft is rebuilt from `dictationBaseText`
                // on every partial — text put only into `draft` would vanish
                // with the next word. It joins the base instead.
                let base = dictationBaseText.trimmingCharacters(in: .whitespacesAndNewlines)
                dictationBaseText = base.isEmpty ? incoming : base + "\n\n" + incoming
                draft = dictatedText(dictation.transcript)
            } else {
                let have = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                draft = have.isEmpty ? incoming : have + "\n\n" + incoming
            }
            if seed.focuses && !focused { seedFocusRequested = true }
        }
        if !seed.images.isEmpty {
            attachments.append(contentsOf: seed.images.prefix(max(0, 4 - attachments.count)))
        }
        // Гасим у хоста: без этого та же передача приедет на следующем кадре и
        // удвоит текст, а это ровно та тихая поломка, которую ловит только
        // настоящий шаринг.
        onSeedTaken?()
    }

    private func dictatedText(_ text: String) -> String {
        let base = dictationBaseText.trimmingCharacters(in: .whitespacesAndNewlines)
        return base.isEmpty ? text : base + " " + text
    }

    /// A draft key names its machine (`<machine>::<session>`, `new::server::<machine>`): a key
    /// of a private machine is never read from or written to disk, whichever key this
    /// composer happens to be moving from or to.
    private func draftIsPrivate(_ key: String) -> Bool {
        if privateMachine && key == draftKey { return true }
        return client.allMachines.contains { snap in
            let m = snap.machine.machineId
            return (snap.machine.isPrivate || client.hasKey(for: m))
                && (key.hasPrefix("\(m)::") || key.hasSuffix("::\(m)")
                    || key.hasPrefix("new::\(m)::") || key.hasPrefix("new::server::\(m)"))
        }
    }

    private func loadDraft(_ key: String, scope: String?) -> String {
        draftIsPrivate(key) ? "" : DraftStore.load(key, scope: scope)
    }

    private func saveDraft(_ key: String, _ text: String, scope: String?) {
        if !draftIsPrivate(key) { DraftStore.save(key, text, scope: scope) }
    }

    private func cancelDictation() {
        // Suppress delayed observation of active=false: it must not copy the old
        // recording into the next session/account, or restore an already sent draft.
        dropPolish()
        dropUnrecognized()
        dictationSendRequested = true
        dictationSendTask?.cancel()
        preparingSend = false
        dictation.cancel()
    }

    private func sendDictation() {
        guard dictationSendTask == nil, !privateMachine else { return }
        dictationSendRequested = true
        dropPolish()
        let key = draftKey
        let scope = client.storageScope
        dictationSendTask = Task { @MainActor in
            defer { dictationSendTask = nil; preparingSend = false }
            let result = await dictation.finish()
            // Take the file before any guard so that it is always deleted —
            // unless it is kept for «Повторить» below.
            let recording = dictation.takeRecording()
            var keepRecording = false
            defer { if let recording, !keepRecording { try? FileManager.default.removeItem(at: recording) } }
            guard !Task.isCancelled, key == draftKey || preservesDraftOnKeyChange,
                  scope == client.storageScope else { return }
            var text = result ?? dictation.transcript
            // What the phone heard decides «send»: a final-result error still
            // leaves the partial transcript, and that was said and seen.
            let sendable = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if let recording, client.aiAllowed {
                preparingSend = true
                draft = dictatedText(text)
                // Server recognition; the phone's text stays the fallback.
                let project = polishContext?(text).project
                let outcome = await client.api.transcribe(fileURL: recording, contentType: "audio/mp4",
                                                          project: project)
                guard !Task.isCancelled, key == draftKey || preservesDraftOnKeyChange,
                      scope == client.storageScope else { return }
                switch outcome {
                case let .text(server):
                    // Replaces what the phone heard, but never makes an empty
                    // recording sendable on its own: on silence whisper can
                    // invent a sentence, and nobody would see it before it went.
                    text = server
                case .failed:
                    // The hub was out of reach: the phone's text is a preview,
                    // not the message (25.10.2026 it went out missing
                    // everything said before a pause). Leave it in the box with
                    // the recording kept, and let the person decide.
                    keepRecording = true
                    let base = dictationBaseText.trimmingCharacters(in: .whitespacesAndNewlines)
                    keepUnrecognized(recording, phoneText: text, prefix: base.isEmpty ? "" : base + " ")
                    Haptics.light()
                    return
                case .silence, .unavailable:
                    break
                }
                // The rewrite is never seen before it goes out, so it gets the
                // project label only — no title, no conversation text.
                if sendable, let polishContext {
                    let safe = polishContext(text).withoutConversation
                    if case let .polished(better) = await client.api.polish(safe) { text = better }
                    guard !Task.isCancelled, key == draftKey || preservesDraftOnKeyChange,
                          scope == client.storageScope else { return }
                }
            }
            draft = dictatedText(text)
            guard sendable else { return }
            preparingSend = false
            send()
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let imgs = attachments
        guard !text.isEmpty || !imgs.isEmpty else { return }
        // Only clear on a successful send — otherwise keep the draft + images so the
        // "not connected, try again" toast is actually actionable.
        guard !client.isChangingModel, onSend(text, imgs) else { return }
        dropPolish()
        dropUnrecognized()
        draft = ""
        attachments = []
        Haptics.light()
    }

    // MARK: - Dictation clean-up (`/polish`, web f37e688)

    /// The phone's text goes in at once. Then, off the main path: the hub's own
    /// recognition of the recording replaces it (if the person has not edited
    /// that text meanwhile), and the rewrite replaces THAT. Any failure leaves
    /// the text already in the box. «Отправить запись» takes a shorter route
    /// (`sendDictation`).
    private func startPostProcessing(onDevice: String, after prefix: String) {
        dropPolish()
        let recording = dictation.takeRecording()
        let context = polishContext
        let hasText = !onDevice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // What the box holds right now: prefix + the phone's text, or — when the
        // phone heard nothing — the untouched draft from before the recording.
        let before = draft
        guard client.aiAllowed, recording != nil || (context != nil && hasText) else {
            if let recording { try? FileManager.default.removeItem(at: recording) }
            return
        }
        let key = draftKey
        transcribing = recording != nil
        polishTask = Task { @MainActor in
            var keepRecording = false
            defer { if let recording, !keepRecording { try? FileManager.default.removeItem(at: recording) } }
            var current = onDevice
            if let recording {
                let project = context?(onDevice).project
                let outcome = await client.api.transcribe(fileURL: recording, contentType: "audio/mp4", project: project)
                guard !Task.isCancelled else { return }
                transcribing = false
                guard key == draftKey else { return }
                if outcome == .failed {
                    // Keep the audio for «Повторить»; the phone's text stays
                    // in the box, marked as such. No rewrite of a preview.
                    // Typing after it during the (up to 45 s) wait is fine —
                    // only the phone's text has to be where it was put.
                    // Nothing heard on the phone: the place is the end of the
                    // old draft, and the hub's text will go there.
                    let at = onDevice.isEmpty ? before : prefix
                    polishTask = nil
                    guard DictationPair(raw: onDevice, polished: onDevice, showingPolished: false, prefix: at)
                        .visible(in: draft) else { return }
                    keepRecording = true
                    keepUnrecognized(recording, phoneText: onDevice, prefix: at)
                    return
                }
                if case let .text(server) = outcome, server != current {
                    // Anchored: only if the box is still exactly what it was at stop.
                    guard draft == before else { return }
                    draft = prefix + server
                    current = server
                } else if current.isEmpty {
                    return
                }
            }
            guard let context, !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                polishTask = nil
                return
            }
            polishing = true
            let outcome = await client.api.polish(context(current))
            guard !Task.isCancelled else { return }
            polishing = false
            polishTask = nil
            guard key == draftKey else { return }
            let pair = DictationPair(raw: current, polished: current, showingPolished: false, prefix: prefix)
            switch outcome {
            case let .polished(polished):
                guard let swapped = DictationPair(raw: current, polished: polished, showingPolished: false,
                                                  prefix: prefix).swap(in: draft) else { return }
                draft = swapped.draft
                dictationPair = swapped.pair
            case .failed:
                if pair.visible(in: draft) { polishFailedAnchor = pair }
            case .unchanged, .off:
                break
            }
        }
    }

    /// Keep a recording the hub did not get to, anchored to the phone's text
    /// of it in the box: `prefix` is the draft before it, exactly as it stands.
    private func keepUnrecognized(_ url: URL, phoneText: String, prefix: String) {
        dropUnrecognized()
        unrecognized = UnrecognizedRecording(
            url: url,
            anchor: DictationPair(raw: phoneText, polished: phoneText, showingPolished: false, prefix: prefix))
    }

    private func dropUnrecognized() {
        if let kept = unrecognized { try? FileManager.default.removeItem(at: kept.url) }
        unrecognized = nil
    }

    /// «Повторить»: the kept recording to the hub again. The result replaces
    /// the phone's text only where it was put and only if it is still there;
    /// then it is rewritten like any dictation. Nothing is sent on its own —
    /// the person is looking at the box.
    private func retryUnrecognized() {
        guard let kept = unrecognized, !transcribing, polishTask == nil else { return }
        // Another composer's dictation sweeps recordings older than an hour.
        guard FileManager.default.fileExists(atPath: kept.url.path) else { dropUnrecognized(); return }
        let key = draftKey
        let context = polishContext
        transcribing = true
        polishTask = Task { @MainActor in
            let outcome = await client.api.transcribe(fileURL: kept.url, contentType: "audio/mp4",
                                                      project: context?(kept.anchor.raw).project)
            guard !Task.isCancelled else { return }
            transcribing = false
            guard key == draftKey, unrecognized == kept, kept.anchor.visible(in: draft) else {
                polishTask = nil
                return
            }
            guard case let .text(server) = outcome else {
                polishTask = nil
                // Still out of reach: keep it for another try. Anything else
                // is an answer — the phone's text is what there is.
                if outcome == .failed { Haptics.error() } else { dropUnrecognized() }
                return
            }
            // Into the phone text's place. When the phone heard nothing, the
            // place is the end of the old draft, and words need a space there.
            var prefix = kept.anchor.prefix
            if kept.anchor.raw.isEmpty, let last = prefix.last, !last.isWhitespace { prefix += " " }
            var tail = String(draft.dropFirst(kept.anchor.prefix.count + kept.anchor.raw.count))
            if kept.anchor.raw.isEmpty, let first = tail.first, !first.isWhitespace { tail = " " + tail }
            draft = prefix + server + tail
            dropUnrecognized()
            guard let context else { polishTask = nil; return }
            polishing = true
            let polished = await client.api.polish(context(server))
            guard !Task.isCancelled else { return }
            polishing = false
            polishTask = nil
            guard key == draftKey else { return }
            let pair = DictationPair(raw: server, polished: server, showingPolished: false, prefix: prefix)
            switch polished {
            case let .polished(better):
                guard let next = DictationPair(raw: server, polished: better, showingPolished: false,
                                               prefix: prefix).swap(in: draft) else { return }
                draft = next.draft
                dictationPair = next.pair
            case .failed:
                if pair.visible(in: draft) { polishFailedAnchor = pair }
            case .unchanged, .off:
                break
            }
        }
    }

    private func dropPolish() {
        polishTask?.cancel()
        polishTask = nil
        polishing = false
        transcribing = false
        dictationPair = nil
        polishFailedAnchor = nil
    }

    /// «вычитано · как сказал» over the field — the rewrite can be wrong about
    /// a term, and the person must get their own words back in one tap.
    private var polishCaption: some View {
        HStack(spacing: Theme.s2) {
            if transcribing {
                ProgressView().controlSize(.mini)
                Text("Распознаю…")
            } else if polishing {
                ProgressView().controlSize(.mini)
                Text("Вычитываю…")
            } else if unrecognized != nil {
                Text("Сервер не распознал запись — здесь текст с телефона")
                    .lineLimit(2)
                Button {
                    retryUnrecognized()
                } label: {
                    Text("Повторить")
                        .underline()
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("composer.retryTranscribe")
                .accessibilityHint("Ещё раз отправить запись на распознавание")
            } else if polishFailedAnchor != nil {
                Text("Вычитка не удалась — текст как распознан")
            } else if let pair = dictationPair {
                Text(pair.showingPolished ? "ВЫЧИТАНО" : "КАК СКАЗАЛ")
                    .font(.ui(Theme.sizeMicro, weight: .semibold))
                    .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
                    .foregroundStyle(Theme.textFaint)
                Button {
                    guard let swapped = pair.swap(in: draft) else { dictationPair = nil; return }
                    draft = swapped.draft
                    dictationPair = swapped.pair
                    Haptics.light()
                } label: {
                    Text(pair.showingPolished ? "как сказал" : "вычитать")
                        .underline()
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("composer.dictationSwap")
                .accessibilityHint(pair.showingPolished ? "Вернуть текст ровно как его распознали"
                                                        : "Вернуть вычитанный текст")
            }
            Spacer(minLength: 0)
        }
        .font(.ui(Theme.sizeMicro))
        .foregroundStyle(Theme.textMuted)
        .padding(.horizontal, Theme.s3)
    }
}

/// A recording the hub did not get to, and where the phone's text of it sits.
private struct UnrecognizedRecording: Equatable {
    let url: URL
    let anchor: DictationPair
}
