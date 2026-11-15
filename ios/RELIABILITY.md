# iOS reliability refactor — 0.7.5

The September 22 refactor preserves the wire schema, single-writer rules and
current product UI. CentralClient remains the coordinator. New boundaries own
concrete resources rather than fragments of its state machine:

- `URLSessionSocket`: one connection, immutable delegate callbacks, 64 MiB frame
  limit, cancellation of its task and session. CentralClient gates async decode,
  ping and send completions by connection epoch. Every teardown rejects pending
  RPC, memory, enrichment, terminal and mirror operations immediately.
- `PersistentOutbox`: atomic durable mutations and exact in-flight message IDs.
  An input remains on disk until transport completion; an open removes only the
  UUID that started it. Failures preserve the queue/draft. A corrupt file is
  preserved and reported, never silently replaced with an empty queue.
- `ClientStorage`: endpoint/account/workspace namespaces. Unknown credentials
  initially use an isolated SHA256 scope; a hub snapshot verifies their account
  and transfers their queue with UUID deduplication. Late send recovery follows
  that verified owner. Known credentials can load their own offline snapshot;
  a rotated token must be verified before accessing the previous account cache.
- `SessionHistory`: one generation-checked owner for cached history, refresh,
  load-earlier and end-of-turn convergence. Failed refresh retains visible
  history; failed expansion can be retried. Model discovery runs concurrently.
- `SessionHistoryShelf` keeps the `SessionHistory` of the last six sessions
  (per account scope) across leaving a session and coming back; a kept copy
  confirmed at the session's current `lastModified` is not read again.
  `CentralClient` parks the live lines of a session left mid-turn and gives
  them back only to the same run while it still replays its turn — the replay
  then replaces them in one write, as after a reconnect.
- `PushDecisionSender`: separate approval connections, workspace routing,
  ten-second deadline and cancellation on sign-out/account replacement.

Changing account/workspace resets transient client state and remounts the shell;
the initial connection preserves launch routes and share handoffs. Drafts are
scoped to the account. A first verification preserves newly typed text and any
existing verified draft. Empty credentials are deleted from Keychain.

## Upgrade and delivery limits

Old installations used global `PendingMessages.json`, fleet/transcript caches
and `cc-draft::` defaults without an owner. They remain untouched on disk but
are **not automatically adopted** by the first account that signs in: ownership
cannot be proved. The history cache repopulates from the hub. Old unsent messages
and drafts can be recovered in Settings → Account → Offline copy, after explicit
confirmation of the current account/workspace. Recovery merges without replacing
current drafts, deduplicates queue UUIDs and retains backups. Recovered queued
messages send when their machine is available. Do not delete the backups as cleanup.

Atomic outbox writes are synchronous so the composer only clears after durable
acceptance. Large attachment queues can still cause UI pauses; an asynchronous
API or per-message journal is follow-up work, not a claim of this refactor.

The unchanged protocol has no idempotency key or delivery ACK for `input` or
`tool_decision`. Socket completion does not prove agent consumption; an ambiguous
disconnect may cause a retry/duplicate. Exactly-once delivery needs a coordinated
hub/agent protocol change. History remains capped at the server's 2,000-message
tail; there is no cursor-based pagination.

## Verification

The isolated simulator unit suite covers stale decode/pong/send, disconnect
settlement, account/workspace and token-rotation isolation, durable FIFO and
exact-ID deletion, write/corruption failures, cancellation, push timeouts and
history races. The pre-cancel cleanup regression was also run with its fix
removed: it failed on the missing cleanup, then passed with the fix restored.

Safari Share Extension handoff and five shell-gesture UI tests passed on iPhone
16. The narrow 375pt composer is inspected in light and dark themes. A local
echo server exercises the actual URLSession transport with a 2.1 MB frame,
ping and cancellation. All test networking uses fixtures/local peers, not a
production agent. Camera permission text is present in the generated plist.

Physical-device APNs/background execution and camera capture are not covered by
the simulator checks. Release archives use worktree-local DerivedData through
`build.sh`, avoiding collisions with another checkout's module cache.

## Drawer preparation cache — 0.7.6

`DrawerModel` retains sorted sessions, the run index, live/favorite sections and
Flow items for the lifetime of the account-owned shell. It rebuilds when its
inventory/activity/favorites/committed inputs change, not on drawer visibility,
search typing or menu toggles. Flow consumes that same snapshot. List sections
are flattened into uniquely identified rows for the lazy stack. Existing
account-scoped fleet persistence remains the offline source; no network request
is added when opening the drawer.

Validation uses 1,000 synthetic sessions and 25 Flow entries from
`scripts/drawer-fixture.cjs` (requires the repo's npm dependencies). Run the
DrawerTiming UI suite with TEST_RUNNER_CC_LIVE_HUB=ws://127.0.0.1:18767/ui,
TEST_RUNNER_CC_LIVE_TOKEN=fixture and TEST_RUNNER_CC_DRAWER_FIXTURE=1.
Search/reopen/Flow, live status and cache invalidation have regression coverage.

Simulator video comparison: visible opening motion was about 160ms both before
and after, with the largest sampled frame gaps around 22ms. XCTest tap durations
were dominated by automation overhead (even the idle baseline was slower than
opening), so they are not an improvement metric. The cache removes confirmed
repeated preparation work; the reported long delay on a physical phone was not
reproduced by this static-inventory simulator scenario. Do not claim a measured
end-to-end speedup from these results.
