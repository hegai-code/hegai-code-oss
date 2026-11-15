# Apple Watch and smart pushes

Contract between the hub (`server-rs/`), the iPhone app (`ios/CCRemote`), its
Live Activity widget extension and the watch app (`ios/CCRemoteWatch`). Shipped
together; change the three sides in one commit series.

Why: since 24.09.2026 tool approvals are off by default, so "a human is needed"
means **AskUserQuestion** (answer a question) and **ExitPlanMode** (accept a plan),
plus "the turn ended" and "it failed". Pushes used to say "wants to run
AskUserQuestion". Now they say the question, carry an action token so any surface
(iPhone lock screen, mirrored watch notification, the watch app) answers with one
HTTPS call, and the owner gets a Live Activity and a watch app.

Rollout gate: everything marked **[admin]** is served only to
`CC_REMOTE_PLATFORM_ADMIN_IDS` (`AppState.platform_admins`): the words of a run
inside an APNs push and the action tokens. Since 04.11.2026 the watch app, its
endpoints and the Live Activity are open to every active user, each under their
own access (`watch_access`, `is_callers`). The Russian push texts and categories
are for everyone.

## 1. APNs alert payload (hub → device)

```jsonc
{
  "aps": {
    "alert": { "title": "<session title>", "subtitle": "<machine name>", "body": "<see below>" },
    "sound": "default",
    "thread-id": "<sessionId>",
    "interruption-level": "time-sensitive",   // needs_attention; "active" otherwise
    "category": "HEGAI_ASK",                   // see table
    "mutable-content": 0
  },
  "machineId": "...", "sessionId": "...", "runId": "...", "state": "needs_attention|idle|error",
  "requestId": "...",                          // needs_attention only
  "tool": "AskUserQuestion",                   // needs_attention only
  "act": "<action token>",                     // [admin], when CC_REMOTE_ACTION_TOKEN_SECRET is set
  "ask": { "questions": [ { "key": "...", "question": "...", "options": ["label", ...], "multiSelect": false } ] },
  "plan": "<plan excerpt ≤ 300 chars>",
  "replies": [ { "label": "≤ 24 chars", "send": "≤ 200 chars" } ]   // [admin], idle only, ≤ 3
}
```

Optional keys are absent, never `null`. The whole payload must stay under
4096 bytes: the hub trims `plan`, then `replies`, then option labels, then the
body until it fits.

| state | tool | category | body |
|---|---|---|---|
| needs_attention | AskUserQuestion | `HEGAI_ASK` | first question text |
| needs_attention | ExitPlanMode | `HEGAI_PLAN` | `План: <first meaningful plan line>` |
| needs_attention | other | `TOOL_APPROVAL` | `Хочет запустить <tool title or name>` |
| idle | — | `HEGAI_DONE` | [admin] LLM summary; else [admin] last assistant text, markdown stripped, ≤ 180; else `Готово` |
| error, run continues | — | `HEGAI_ERROR` | `Ошибка` + [admin] short reason |
| error, run released | — | none (no actions, no `act`) | `Ошибка` + [admin] short reason |

Content for non-admins stays generic (`Нужен ваш ответ`, `План готов`,
`Хочет запустить <tool name>`, `Готово`, `Ошибка`): no question text, plan,
command title, error text or assistant text leaves the hub for them, and
`ask`/`plan`/`replies`/`act` are absent. `TOOL_APPROVAL` never shows the tool's
title (for Bash that is the command line), only its name.

An [admin] idle push that waits for the LLM summary goes back through the hub
and is sent only if the run is still in that same idle transition.

`ask.questions[].key` is the key the answer goes under: `id` if the question
has one, else the question text (same rule as `web/src/components/QuestionModal.tsx`).

## 2. Action token

JWT HS256 signed with `CC_REMOTE_ACTION_TOKEN_SECRET` (≥ 32 bytes, distinct from
the other link secrets; unset = no `act` in pushes, clients fall back to the
WebSocket path). Claims:

`iss:"cc-remote"`, `aud:"push-action"`, `sub:<user_id>`, `ws:<workspace_id>`,
`run:<run_id>`, `req:<request_id>` (needs_attention only), `k:"ask"|"plan"|"tool"|"reply"`,
`exp` (needs_attention: +2 h, reply: +6 h), `jti` (random). Single use: the
hub keeps spent `jti`s in SQLite until their `exp` (survives restarts). Token
mode is [admin] too: the hub re-checks admin and `require_active` on every use.
Signing out on the iPhone removes delivered notifications, so stale tokens leave
the lock screen with the session.

## 3. `POST /api/push-action`

Two ways to authenticate, one handler:

* **Token**: body `{ "token": "<act>", "action": ..., "text"?, "answers"? }`. No
  cookie needed — this is what a notification action sends.
* **Session** (the watch app): `Authorization: Bearer <watch session>` (§7), body
  `{ "runId", "requestId"?, "action", "text"?, "answers"? }`.

Either way the hub resolves the user's `UiAccess` for the token's workspace,
applies `require_active`, the same `can drive run` check as the WebSocket
(`ui_can_drive_run`), and for decisions requires `pending_request_id ==
requestId` (else `409 {"error":"stale"}`).

| action | needs | does |
|---|---|---|
| `allow` / `deny` | k=tool | `tool_decision {allow}` |
| `answer` | k=ask | `answers` map, or `text`: one question → `answers[key]=text`; several → `deny` with `message=text` |
| `plan_accept` | k=plan | allow, `updatedInput`=pending input, `permissionMode:"default"` |
| `plan_accept_edits` | k=plan | same, `permissionMode:"acceptEdits"` |
| `plan_revise` | k=plan | `allow:false`, `message=text` |
| `reply` | any | `input {runId, text}` |

Answers: `200 {"ok":true}`; `400` bad body; `401` bad/expired token; `403`
access; `404 run_gone`; `409 stale|used`; `503 machine_offline`.

## 4. `GET /api/watch/inbox`

Bearer session. Runs owned by the caller that they may drive:

```jsonc
{ "waiting": 1, "working": 2,
  "items": [ { "runId", "machineId", "sessionId", "title", "machine",
               "state": "needs_attention|working|idle|error", "sinceMs": <epoch ms entered state>,
               "tool"?, "requestId"?,
               "questions"?: [ { "key", "question", "options": ["..."], "multiSelect": false } ],
               "plan"?: "≤ 1500 chars", "lastText"?: "≤ 400 chars" } ] }
```

Order: needs_attention, error, working, idle; newest first inside a group.
A private machine's waiting item has no `requestId` (since 09.11.2026): every
push action on it is refused (`private_machine`), so nothing offers one.

Since 09.11.2026 a live item also carries, all optional and all absent for a
private machine (the hub cannot read them there):

```jsonc
"progress": { "done": 3, "total": 7, "active"?: "≤ 160 chars",
              "steps"?: [ { "text": "≤ 80 chars", "status": "completed|in_progress|pending" } ] },  // ≤ 12 steps
"startedMs"?: 0,        // epoch ms the current task began (the human turn)
"contextPct"?: 62,      // 0–100, the run's last context_usage percentage
"background"?: 2,       // background tasks/agents still running (> 0 only)
"summary"?: "≤ 140",    // [admin] idle only: what the finished turn did
"replies"?: [ { "label": "≤ 24", "send": "≤ 200" } ],  // [admin] idle only, ≤ 3
"digestPending"?: true  // [admin] live idle run of an admin owner, no digest yet, < 30 s since idle, gateway and APNs configured
```

* `progress` is the session's own checklist (`mcp__hegai__plan`, the same source
  as the Live Activity's `planDone/planTotal`). The agent sends
  `plan_progress {done, total, active?, steps?}`; agents before 09.11.2026 send
  only the counts, and the item then has no `active`/`steps`. A new human turn
  clears it (`0/0`).
* `summary`/`replies` are the idle push's own LLM digest (§1, `push_summary_ready`),
  remembered per session (in memory, ≤ 200 sessions, lost on a hub restart). A
  live idle run shows it while the run is idle since the same moment; a recent
  session without a run (§4a, which carries them too) shows it while the session
  has not changed after the digest was made. Never for a private machine or an
  erased session; the entries go with the session's other derived text
  (`forget_enrichment`: retention, the private switch; `clear_enrichment_cache`:
  account deletion and erasure; `sync_forget`), and a run of the session that
  starts working drops it at once — on the hub's clock, so the
  `lastModified ≤ made_ms` rule (agent clock vs hub clock) only covers turns
  that did not go through the hub.

### 4a. Recent sessions in the inbox

Besides live runs, `items` also lists the caller's own sessions with activity in
the last 48 h that have no live run (`state: "idle"`, no `runId`; `lastModifiedMs`
instead of `sinceMs`), newest first, so the list is the person's recent work and
not only what is running right now. Up to 40 items total; live runs first.
Every item carries `machineId`, `sessionId`, `source` (`claude`|`codex`),
`title`, `machine`.

### 4b. `GET /api/watch/history?machineId=&sessionId=&limit=`

Watch session Bearer (same scope as the inbox). The tail of the transcript from
the hub's replica, simplified for a 45 mm screen, oldest first, `limit` ≤ 40
(default 24):

```jsonc
{ "items": [ { "role": "user|assistant|tool", "text": "…", "ts"?: 0 } ], "more": true }
```

* `user` / `assistant`: plain text, markdown stripped, ≤ 600 chars each (cut
  with «…»); system/meta lines, tool results, thinking and images are skipped.
* `tool`: one line per tool call, `name` + a short label ≤ 60 chars (file name,
  first words of a command); consecutive tool calls collapse into one item
  «🔧 Bash ×3, Edit».
* Access: the same view check the WebSocket uses for `session.messages`
  (`ui_can_view_session`); private machines and erased sessions are refused.
* `404 not_found` when the replica has no such session; `403` for a refused viewer (`forbidden`) or a private machine (`private_machine`). Optional `source=claude|codex` (absent: both are tried).

### 4c. Reply to a session without a live run

`POST /api/push-action` session mode accepts `{ "action": "reply", "machineId",
"sessionId", "source", "text" }` without `runId`: the hub resumes the session
with that message through the same path `/api/fleet/send` uses to drive an
existing session (single-writer lock, owner checks), and answers like a
`reply`. `409 busy` if another writer holds it (an editor's live process, a run that is still closing); `404 not_found` if the session is not on the machine; `503 machine_offline`. A live run of the session takes the text as a plain `input`.

## 5. Live Activity

One activity per user for the whole fleet, not one per run.

* Attributes type `HegaiFleetAttributes` (no static fields, `"attributes": {}`).
* `ContentState` JSON (camelCase, Swift `Codable`):
  `{ "working": Int, "waiting": Int, "items": [ { "title": String, "state": String, "sinceMs": Int64, "planDone"?: Int, "planTotal"?: Int } ] (≤ 5), "updatedMs": Int64 }`
  — `sinceMs` and `updatedMs` are absolute epoch milliseconds (`sinceMs` = when the item entered its state).
  `planDone`/`planTotal` (since 07.11.2026) are the session's own checklist
  («3/7»), present only while it keeps one: the agent sends a `plan_progress`
  status on every `mcp__hegai__plan` call and `0/0` on the next human turn; the
  hub keeps it on the run, never forwards it, and counts a changed plan as a
  change of the card. A private machine seals the numbers, so its rows carry
  none. The lock screen lists all five rows, the Dynamic Island the first three;
  apps before 1.0.58 decode the keys away and show three.
* iPhone registers tokens: `POST /api/push/live-activity`, Bearer session,
  body `{ "kind": "start", "token": "<hex>" }` (push-to-start token, iOS 17.2+),
  `{ "kind": "activity", "activityId", "token" }`, `{ "kind": "ended", "activityId" }`
  (`activityId: "no-cards"`: the app is in the foreground and has no card),
  `{ "kind": "signout", "tokens": ["<hex>", ...] }` (sent before the app clears its session;
  drops these tokens for every user). A token registered by one user is removed from
  any other user. Rows go with account erasure.
* Activity tokens are kept per `activityId` (several devices); update/end go to all of them.
* Fail closed: a user who is not active gets no Live Activity
  pushes, even with persisted tokens.
* After a hub restart the first evaluation waits 60 s, so runs re-registering after a
  deploy don't end and restart the activity.
  An account the hub refuses gets `403` and the app stops trying until next launch.
* Hub: on any run-state change of the user, debounce 3 s, then
  * nothing running/waiting and an activity known → `event:"end"`, `dismissal-date` = now + 10 min;
  * activity token known → `event:"update"`, `stale-date` = now + 20 min, priority 10 when
    `waiting` grew, else 5, at most one update per 15 s while the counts are unchanged;
    while anything is running an update also goes out every 10 min, so `stale-date`
    passes only when the hub really lost the activity;
  * no activity token and something running/waiting → `event:"start"` to the user's
    start tokens (with an `alert` and `input-push-token: 1`, without which iOS 18+
    issues no update token). At most once per 10 min; and while an earlier start has
    had no activity token or `ended` back, not again for 8 h (`live_activity_pending_start`,
    survives a restart): that card cannot be updated or ended, a new one only stacks
    beside it. A start held back goes as soon as the hold lifts.
* The app observes tokens from `didFinishLaunching`, not from the first view: a
  push-to-start launches it in the background with no UI.
* The hub journal has `[live] app reported: <kind>` for each registration and
  `[notify] live activity delivered: <event>` for each push. Only `delivered: start`
  with no `reported: activity` after it means the app never got a token.
* Past its `stale-date` the widget says «нет обновлений», in grey, without timers: the hub
  cannot end a card whose token it never got (the app was not woken), and a frozen
  «работает» with a running timer reads as live work. iOS removes it within 12 h.
* Headers: `apns-push-type: liveactivity`, `apns-topic: <bundle>.push-type.liveactivity`.
* The watch shows it in the Smart Stack by itself (`supplementalActivityFamilies([.small])`).

## 6. Notification categories (iPhone and watch register the same ids)

| id | actions (in order) |
|---|---|
| `TOOL_APPROVAL` | `APPROVE_DENY` «Запретить» (destructive), `APPROVE_ALLOW` «Разрешить» (auth required) |
| `HEGAI_ASK` | `REPLY` text «Ответить…» |
| `HEGAI_PLAN` | `REPLY` text «Поправить…», `PLAN_ACCEPT` «Принять» (auth required) |
| `HEGAI_DONE` | `REPLY` text «Ответить…» |
| `HEGAI_ERROR` | `REPLY` text «Ответить…» |

Every action except the destructive Deny requires an unlocked device
(`.authenticationRequired`): a free-text reply drives the session at least as
much as Allow does.

The first action is what the watch's double tap fires, so it is never an
acceptance. On the watch, the app's notification interface shows the question
options / reply chips as buttons and offers them as text suggestions.

Action → `POST /api/push-action` with `act`: `REPLY` → `answer` (ASK), `plan_revise`
(PLAN), `reply` (DONE/ERROR); `PLAN_ACCEPT` → `plan_accept`; allow/deny as named.
Without `act` the iPhone falls back to the one-shot WebSocket (`PushDecisionSender`):
allow/deny as before; ASK/PLAN text → `tool_decision {allow:false, message:text}` for
the `requestId`; DONE/ERROR text → `input`. The watch, without `act`, uses its own
session (Bearer mode) if it has one, else posts «Ответьте с iPhone».

## 7. Watch app

`ios/CCRemoteWatch` (bundle `net.hegai.ccremote.watchkitapp`, watchOS 10+), embedded
in the iPhone app; complication extension `net.hegai.ccremote.watchkitapp.widgets`.

* Support accounts and service-minted sessions get `403` on the watch endpoints:
  support reads through the audited UI, and a service session's conditions would
  not bind a watch session minted from it. History read without control of the
  machine writes the same `session.viewed` audit row as `session.messages`.
* The watch gets its **own** session: the iPhone calls `POST /api/watch/session`
  (Bearer) → `{token}` — a separate `auth_sessions` row labelled «Apple Watch»,
  listed and revocable in «Где я вошёл», narrowed to the watch endpoints where the
  existing `ui_scope` mechanism allows — and hands `{hub, token}` over WatchConnectivity
  (`updateApplicationContext`). The watch keeps it in a keychain
  access group shared with its widget extension, `…AfterFirstUnlockThisDeviceOnly`.
  Sign-out on the iPhone sends `{token:""}`.
* Screens: inbox (waiting first; a working row has a thin plan bar and the
  current step) → session: a status card (ring of plan progress or a spinner,
  state, elapsed timer, current step, context and background chips), the action
  (question with option buttons; plan excerpt with «Принять» / «Поправить»;
  after a finished turn the digest and «Что дальше» — the `replies` as one-tap
  buttons — and «Свой ответ» by dictation), the plan as a checklist, then the
  conversation. The session screen re-reads the inbox every 5 s while it is on
  screen (wrist raised) and something runs, a sent reply has not started a turn
  yet, or the hub says the digest is on its way (`digestPending`). Allow/deny show
  for a plain tool approval only; a question the hub cannot read out (a private
  machine) still says «Ответь на iPhone».
* Tapping the iPhone's Live Activity on the watch (Smart Stack, the icon at the
  top of the face) opens this app, not «Открыть на iPhone»:
  `WKSupportsLiveActivityLaunchAttributeTypes` = `[]` (all activities) in the
  watch app's Info.plist (watchOS 11+; on 10 the system keeps its default).
* Complication: «ждут N» / «работают M», refreshed every 15 min and whenever the
  app fetches the inbox or a notification arrives.
* Session detail shows the simplified transcript tail of §4b (chat bubbles, tool
  calls as one grey line), with the pending question anchored at the top on open.
  Navigation keys on `machineId/sessionId`, so a reply that starts a run keeps the
  open screen.
* No terminal, no diffs, no raw transcript — by design.

## 8. Known gaps (deliberately deferred, 03.11.2026)

Raised by the gateway review, judged rare enough to ship without; each is a
retry/ordering edge, none crosses an account boundary.

* **Partial APNs success** (`server-rs/src/live_activity.rs`, `sent`): when one of
  several devices succeeds, the action commits for all; a device that failed
  transiently waits for the next fleet change. Fix: retry state per token.
* **Agent channel full** (`server-rs/src/hub/watch.rs`, push action → `send_to_agent`):
  the decision is reported OK and the request settled even if the bounded agent
  channel dropped the frame. The WebSocket path has the same behaviour today.
  Fix: make the enqueue return a result; settle and spend the `jti` only after it.
* **Sign-out vs. next account's registration** (`ios/CCRemote/Core/LiveActivityRegistrar.swift`):
  the old account's signout runs asynchronously; if it lands after the new
  account registered the same push-to-start token, the hub drops the new row
  until ActivityKit reports the token again. Fix: await the cleanup before
  starting the observers.
* **Pending signout across a hub switch**: pending tokens are retried against the
  current hub, not the one that holds them. Fix: store the hub with each record.
* **A start to several devices**: the hold is per user, so the first device's token
  lifts it while another device's card may still be tokenless; the next start can
  stack beside that card. Fix: track pending starts per start token.
* **Force-quit app**: iOS starts the card but does not wake the app, so no token and
  no `end`; the card goes grey at its `stale-date`. Fix: APNs broadcast channels
  (`input-push-channel`), which need no app; the App ID lacks the capability today
  (`BroadcastFeatureNotEnabled`).
* **Error items in the Live Activity**: the hub releases a failed run at once, so
  `error` items never reach the snapshot; the state value is reserved.
