# cc-remote — iPhone client

The native **SwiftUI** iPhone client for cc-remote: drive Claude Code and Codex
sessions — resume, stream, approve tools, dictate tasks by voice. It talks to the
same hub as the web UI over the mobile WS path (see [Connecting](#connecting)).

**One app, iPhone only, portrait only:** `CCRemote`, ships to TestFlight. The
native macOS target `CCRemoteMac` was **removed on 21.09.2026** — the Mac app is
now the Tauri shell in `windows/` (runbook: `deploy/FLEET.md`). `CCRemoteMac/`
still sits on disk as the last trace of it, but nothing builds it; deleting those
files is a separate, human decision.

The Xcode project is **generated** from [`project.yml`](project.yml) with
[XcodeGen](https://github.com/yonaskolb/XcodeGen) — do **not** hand-edit
`CCRemote.xcodeproj`; edit `project.yml` and regenerate.

[**REBUILD.md**](REBUILD.md) carries the rebuild's settled decisions — what not
to re-open (one page + one drawer, settings-as-tabs, no circles), why Команда has
four tabs and not the web's five, and the harness traps that each cost a session.
Read it before undoing something that looks arbitrary.

## Layout

Connection lifecycle, account isolation, queue guarantees and upgrade limitations
are documented in [RELIABILITY.md](RELIABILITY.md).

- `CCRemoteKit/` — **local SwiftPM package**: the hub client, the wire protocol
  and the on-disk caches. Depends on neither SwiftUI, UIKit nor AppKit; what the
  host differs on arrives by injection (`BackgroundGrace`,
  `NotificationEngine.postBanner`).
- `CCRemote/` — the app target (`App/`, `Core/`, `DesignSystem/`, `Shell/`,
  `Features/`, `Resources/`). Attached to `project.yml` as a WHOLE DIRECTORY, so
  files added or deleted inside it need no YAML edit — only a regenerate.
- `CCRemote/Shell/` — **the navigation model**: one page and one drawer. There is
  no bottom tab bar. `AppShell` draws the app as a CARD that the drawer pushes
  aside; `SessionDrawer` is the only place a session list lives; `ShellSwipe`
  carries the direction-based gesture and the rule that it is never stolen from
  something that scrolls sideways; `LaunchAffordances` parses `CC_SCREEN` /
  `CC_DRAWER` / `CC_LENS` and translates the retired `CC_TAB` / `CC_PUSH`.
- `CCRemote/Features/Start/` — **the root screen**: the composer plus the two
  decisions it needs, WHERE (`ProjectShelfView`, a card per machine) and WHAT
  KIND (one category chip, which IS the microphone). The shelf is built from
  TWO sources — the session inventory and each agent's `projects.list`
  (`OwnedProjects`) — because the inventory alone cannot see an empty, a
  just-created or a shared project. The pure half lives in Kit
  (`ProjectShelf`, a port of `web/src/lib.ts:projectTargets`). `NewRunView` is
  the pushed chat of a run that has not learned its session id yet: `new_session`
  goes out with an EMPTY id, so there is no address to open until
  `session_started` lands.
  There is no «новая сессия» form any more, and «Новый чат» in the drawer is
  «go back to the root» — the form was a second screen asking this screen's
  question, with its own project pick and its own draft.
- `CCRemote/Features/Privacy/` + `CCRemoteKit/.../E2EE/` — **private machines**
  (docs/E2EE.md, «As built, iOS»): pairing by QR or pasted code, the key ring in
  the Keychain, sealing on send and opening on receive in `CentralClient`
  (`+E2ee.swift`), the locked-session state. A private machine's content never
  goes to disk or to a hub-side model from this app; the sealing is fail-closed.
- `CCRemote/Features/Render/` — **the transcript as a document**. `TurnRow` is
  the only way to build a row, and `SpeakerGutter` the only thing that names a
  speaker: 76pt of identity mark, name and mono time, outside the reading
  measure. Both renderers — history (`MessageView`) and the live tail
  (`LiveLineView` in `Features/Session/ChatView.swift`) — go through it, because
  the web once had two and grew the gutter in only one, and its live stream
  called the human `you` for half a year. The human's name comes from the
  profile (`SpeakerName.human`), never «Вы»: a shared workspace has more than
  one reader. Machine rows take exactly three semantic colours (`ToolTone`):
  green reads, ember writes and runs, red failed. There are no hairlines
  between turns.
- `CCRemote/Features/Session/GrowingTextField.swift` — the composer's field. A
  `UITextView` rather than `TextField(axis:)` for one reason: the vertical
  TextField grows but does not clamp its SCROLL, so past its line limit the
  text you are typing slides out from under the caret. Ceiling is a whole
  number of lines; 16pt minimum, below which iOS zooms on focus and never
  zooms back.
- `CCRemote/DesignSystem/GalleryView.swift` + `TranscriptFixtureView.swift` —
  the two DEBUG STANDS the rebuild is accepted on. `CC_GALLERY=<section>` is the
  design system (tokens, primitives, the three voices); `CC_TRANSCRIPT=turns |
  tools | composer | 1` is the transcript and composer. Neither opens a socket,
  and both drop their own readiness beacon. The transcript stand exists because
  production does not produce states on request: photographing «ошибка
  инструмента» requires a tool to actually fail on the other side, and a frame
  taken when it happened to happen cannot be re-taken a month later — which is
  the entire point of a baseline.
- `CCRemote/Resources/Fonts/` — the three bundled typefaces (Onest, IBM Plex
  Mono, Source Serif 4), regenerated by `scripts/fetch-fonts.sh`. They must ALSO
  be listed in `UIAppFonts` in `project.yml`, or CoreText never registers them.
- `CCRemoteMac/` — **dead**: the old macOS shell. No target generates from it.
- `ShareExtension/` — the iOS Share extension target.
- `CCRemoteWidgets/` (Live Activity, iOS 18), `CCRemoteWatch/` (Apple Watch app,
  watchOS 10) and `CCRemoteWatchWidgets/` (complications) — contract in
  `../docs/WATCH.md`. `Shared/Common` is compiled into every one of them,
  `Shared/Activity` into the app and the iPhone widgets, `Shared/Watch` into the
  watch pair. Building the app needs the watchOS platform installed
  (`xcodebuild -downloadPlatform watchOS`), because the scheme embeds the watch app.
  Release signing needs three more profiles (see `ExportOptions.plist`) and the
  keychain-sharing group `net.hegai.ccremote.watch` on the two watch App IDs.
- `CCRemoteTests/` — unit tests (iOS-hosted; import CCRemoteKit).
- `ExportOptions.plist` — App Store export options for the iOS release archive.
- `scripts/fetch-fonts.sh` — re-cut the bundled typefaces (pinned + checksummed).
- `scripts/shoot.sh` — screenshot harness: 375/393/402/430 pt into
  `/tmp/hegai-shots/`. Signs in via launch env, waits for the hub's first
  snapshot instead of sleeping. Where it lands is `CC_SCREEN`; `CC_DRAWER=1`
  and `CC_LENS` ride on top; `CC_EXTRA_WAIT` buys the seconds a transcript needs
  AFTER the socket opens. `CC_TAB`/`CC_PUSH` still work and are translated out
  loud (see `Shell/LaunchAffordances.swift`). `CC_TRANSCRIPT` opens the DEBUG
  transcript stand and `CC_HW_KEYBOARD=false` makes the simulator raise its own
  software keyboard — without that the "composer with the keyboard up" frame is
  a composer with no keyboard, because the simulator routes typing to the
  host's hardware one.
  **This machine's simulators cannot resolve `code.example.com`** — Safari inside
  one says «the server can't be found» while the host resolves and answers 101,
  which is why the phase-0 baselines are all suffixed `.offline`. The host's
  `/etc/hosts` already pins three other `*.example.com` names by hand; adding
  `203.0.113.133 code.example.com` there (needs sudo) is the real fix.
- `scripts/hub-bridge.py` — the workaround for exactly that, for when sudo is
  not available: cleartext on `127.0.0.1:8444` → TLS to the hub, with the `Host`
  header put back. Run it, then shoot with
  `CC_HUB_URL=ws://localhost:8444/mobile/ui`. If the host resolver also fails,
  `CC_HUB_IP=203.0.113.133 python3 ios/scripts/hub-bridge.py` selects the upstream
  address while keeping the original TLS server name and certificate checks.
  `CC_HUB_BRIDGE_PORT` selects a free loopback port when 8444 is already in use.
  Match the client URL to it: `CC_HUB_BRIDGE_PORT=8445` on the bridge and
  `CC_HUB_URL=ws://localhost:8445/mobile/ui` on `shoot.sh`.
  Every phase-2 screenshot was taken
  through it.
- `build/`, `build-device/` — derived-data output for simulator / device builds.

Key facts from `project.yml`: bundle prefix `net.hegai`, app ids
`net.hegai.ccremote` (+ `.share`), team `AZWU5VAA73`, deployment target
iOS **17.0**, SwiftPM dependencies **MarkdownUI** and the local **CCRemoteKit**.

`CCRemoteKit` still avoids SwiftUI/UIKit/AppKit even though only one app
consumes it. That is not vestigial: the package's Foundation-only `Protocol/`
is what `scripts/check-protocol-linux.sh` compiles on a Linux toolchain, which
is the only protocol gate that runs without a Mac.

## Build

Generate the project, then build with `xcodebuild`.

```bash
cd ios
xcodegen generate          # (re)writes CCRemote.xcodeproj from project.yml

# Simulator (Debug) — pick any installed iPhone sim
xcodebuild -project CCRemote.xcodeproj -scheme CCRemote \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  -derivedDataPath build build

# A real device (Debug, automatic signing with Apple Development)
xcodebuild -project CCRemote.xcodeproj -scheme CCRemote \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build-device build

# Tests, iOS-hosted. The two known-red SessionCategoryTests are gone: they
# tested `homeShortcuts`, which belonged to Главная and went with it.
xcodebuild test -project CCRemote.xcodeproj -scheme CCRemote \
  -destination "id=$UDID" -derivedDataPath build
```

Address simulators **by UDID**, not by name. Device-type names repeat across
runtimes, so `-destination 'name=iPhone 16'` picks whichever the tool feels like
and the failure surfaces as a screenshot at the wrong size rather than an error.
`xcrun simctl list devices available` prints the UDIDs.

`CCRemoteUITests/ShareHandoffUITests` needs **a page Safari can actually load**,
and the simulator on this machine has no DNS (the same trap that produced
`scripts/hub-bridge.py`). Serve one on the host loopback first — the simulator
shares the macOS network stack, so its `127.0.0.1` is the host's:

```bash
mkdir -p /tmp/ph4-share-probe && cd /tmp/ph4-share-probe \
  && printf '<!doctype html><title>phase4 share probe</title><h1>phase4 share probe</h1>' > index.html \
  && python3 -m http.server 8765 --bind 127.0.0.1 &
```

The test fails loudly (it does **not** skip) when that server is missing: a
skipped acceptance test is green and proves nothing.

`-derivedDataPath` is likewise not optional: DerivedData is shared per-user, and
on a machine where several sessions build the same module names a poisoned
shared module cache is exactly the bug where a clean build fails but an
incremental one passes.

For screenshots use **`scripts/shoot.sh`** (above); it is what UI changes are
reviewed on.

## Signing

- **Device debug** — automatic signing with an **Apple Development** certificate
  (team `AZWU5VAA73`); `project.yml` sets `CODE_SIGN_STYLE: Automatic`.
- **Release / TestFlight** — **manual** signing with **Apple Distribution** and
  the manual **app-store** provisioning profiles named in `ExportOptions.plist`:
  - `net.hegai.ccremote` → `ccremote AppStore ccremote`
  - `net.hegai.ccremote.share` → `ccremote AppStore share`

## TestFlight release

Every published update gets a new user-visible version: **1.0.1, 1.0.2, …**
(larger feature releases may use 1.1.0). Bump `MARKETING_VERSION` in
`project.yml` and the candidate version in `AppStore/metadata.json` before
the release commit. A retry of the same candidate keeps its marketing version
and gets a fresh build number. Do not keep publishing distinct updates under
`1.0` or override the committed version with an old shell value. App Store
Connect's draft must match the candidate before attaching it; already uploaded
builds retain their original version. This policy starts with the next release,
**1.0.1**; the public build 2609302124 remains **1.0**.

Build numbers are **timestamps** (`yyMMddHHmm`) so every upload is monotonic.
[`build.sh`](build.sh) computes the number once and passes the same
`CURRENT_PROJECT_VERSION` to the app and Share Extension. Override it with
`BUILD_NUMBER`; override the marketing version with `MARKETING_VERSION`.

```bash
cd ios
./build.sh release

# Re-run/export an existing archive, or explicitly choose versions:
./build.sh export
BUILD_NUMBER=2609302300 MARKETING_VERSION=1.0.1 ./build.sh release

# Upload to App Store Connect with the ASC API key
xcrun altool --upload-app -f build/export/CCRemote.ipa -t ios \
  --apiKey <ASC_KEY_ID> --apiIssuer <ASC_ISSUER_ID>
```

The ASC API key (`AuthKey_<ID>.p8` + issuer id) lives outside the repo; `altool`
finds the `.p8` in `~/.appstoreconnect/private_keys` (or via `--api-key-path`).

## Connecting

Sign in with **HegAI SSO**: Settings → *Войти через HegAI* opens
`ASWebAuthenticationSession` on `/api/auth/sso/start?native=1`, the hub redirects
to `ccremote://auth?session=…`, and the app keeps that workspace session in the
Keychain. Every user gets their own machines, projects and roles — there is no
shared device token any more.

```
wss://code.example.com/mobile/ui?token=<workspace session>
```

On a customer's own hub (external edition, from `GET /api/public-config` —
`HubPublicConfig.usesHubSignInPage`) the button is «Войти» and opens
`<hub>/native-signin?native=1` in the same `ASWebAuthenticationSession`; the hub's
page ends in the same `ccremote://auth?session=…` callback. Privacy/support links
in Settings derive from the configured hub (`HegaiAuth.hubPageURL`). Changing the
hub in «Другой хаб / токен» drops the old session instead of sending it to the new
hub.

The hub URL + token are entered in the app's settings and persisted. For local
dev, `NSAllowsLocalNetworking` permits `ws://` to a hub on the LAN. **APNs** push
(entitlement `aps-environment`, `UIBackgroundModes: remote-notification`) lets a
tool-approval prompt briefly wake the app in the background.

## Features

- **Sessions & mirror** — resume/stream Claude sessions; read-only **mirror** of
  live editor sessions; browse centrally replicated Claude and Codex history
  while the source machine is offline.
- **Plan mode** — an interactive **QuestionSheet** renders the model's
  `AskUserQuestion` plan prompts and sends the answer back.
- **Reasoning-effort picker** and model controls in the composer.
- **Two lenses, both in the drawer** — Список (live first, then favourites,
  then everything by time) and **Flow** (`Features/Sessions/FlowLens.swift`),
  the stage board. Moving a card is a VISIBLE stage button with a chevron, not
  a long press: HTML5 drag sends no touch events, so on a phone that menu is
  the only way to move anything. Роадмап, Карта and Таблица were deleted in
  phase 4 — the first two grouped sessions by product (a monthly question) and
  the third was Список retold in columns.
- **Composer** — voice dictation (live on-device preview via SFSpeechRecognizer; the recorded m4a then goes to the hub's `/transcribe` for the final text, falling back to the on-device text, followed by `/polish`), **image attachments**
  (camera / photo picker), and playbooks.
- **Share extension** — send a URL, text, or up to 4 images from another app into
  cc-remote (hands off via the `ccremote://` URL scheme + pasteboard; no App
  Group required). It lands in the START SCREEN's composer, appended AFTER
  whatever is already typed — both are the person's own sentences and neither
  may vanish. Verify it by actually SHARING: opening a `ccremote://` link
  bypasses the extension and proves nothing about it.
- **Push approvals** — approve/deny tool requests from a notification.
- **No personal tape.** The «Личное | Хаб» home mode (the assistant's tape and
  its tasks in the drawer) was removed from the app in 1.0.29: home is always
  the hub, no `api/tape` call is made, stored `homeMode` / `tapeEnabledHint`
  are deleted at launch, and a `tape_update` frame decodes as `.unknown`.
  `Router.pendingMessageAnchor` (open a session scrolled to a message, resolved
  by `ChatView`) stays as a generic deep-link. The usage rings live in the
  drawer header.

## Request lifecycle

`CentralClient` uses `Core/PendingRegistry.swift` for RPC, terminal-open, and
mirror-open continuations. Each entry owns its timeout and optional cleanup;
socket teardown rejects all pending work immediately. When a protocol frame is
added, keep its decode test in `CCRemoteTests/ProtocolDecodingTests.swift`; state
registries, the project shelf and the run mark have focused tests alongside it.
(Roadmap grouping used to be named here; the Roadmap went with Главная in phase 4.)

## Transcript replay checks

`TranscriptReconciler` reconciles saved speech with the live stream in both the
chat and reading/export. It handles an echoed optimistic prompt followed by a
continued answer, including different paragraph boundaries. It never cuts the
saved history to the size of a shorter replay. Matching is confined to an
overlapping suffix/current turn; ambiguous user-only repeats remain visible.
History speech is cached between streaming deltas. Tool/error details are kept;
text equality alone is not a tool-invocation identity.

Regression tests: `TranscriptReconciliationTests`, `ConversationDocumentTests`,
`TranscriptGroupingTests`, `TranscriptRowsTests`. UI race/reconnect fixture:

```bash
CC_FIXTURE_PORT=18788 node ios/scripts/transcript-replay-fixture.cjs
TEST_RUNNER_CC_REPLAY_FIXTURE=1 TEST_RUNNER_CC_FIXTURE_PORT=18788 xcodebuild test \
  -project ios/CCRemote.xcodeproj -scheme CCRemote \
  -destination 'id=<simulator-udid>' -derivedDataPath ios/build \
  -only-testing:CCRemoteUITests/TranscriptReplayUITests
```

`transcript-earlier-fixture.cjs` + `TranscriptEarlierUITests` (env
`TEST_RUNNER_CC_EARLIER_FIXTURE=1`; `CC_FIXTURE_STREAM=3000` on the fixture for a
working turn) press «Показать более ранние» in a long session and check that the
earlier rows mount and reach the screen and that the down arrow appears.

The fixture delays saved history until the optimistic send and answer are on
screen, then disconnects/replays the current turn. The test asserts one copy of
the question, answer opening and continuation, and saves both screenshots.

## Answer completion on iPhone

`TurnCompletionTests` covers confirmed idle versus working, missing state,
disconnect, decisions, errors, new prompts and stale saved completions. A gear
in the transcript counts past actions; it does not prove the agent is running.
The UI distinguishes a finished answer from a finished task and offers explicit
continuation through the existing send path, preserving composer drafts.

```bash
CC_FIXTURE_PORT=18792 node ios/scripts/turn-completion-fixture.cjs
TEST_RUNNER_CC_COMPLETION_FIXTURE=1 TEST_RUNNER_CC_FIXTURE_PORT=18792 xcodebuild test \
  -project ios/CCRemote.xcodeproj -scheme CCRemote \
  -destination 'id=<simulator-udid>' -derivedDataPath ios/build \
  -only-testing:CCRemoteUITests/TurnCompletionUITests
```

Use a fresh fixture process. The native test finishes a partial answer, checks
the completion marker, taps Continue and verifies a single input, restored work
indicator and retained draft. Both states are saved as screenshot attachments.
The second scenario uses an external editor with `livePid` and `liveStatus`
but no app run: its working icon appears, idle reveals the completion marker,
and the read-only mirror never offers a hidden takeover through Continue.

## App Store preparation

The first public-release draft and its remaining submission blockers are tracked
in AppStore/README.md. TestFlight availability alone does not
mean the App Store release is ready. Store metadata, review notes, privacy
inventory and the screenshot harness live alongside that checklist.
