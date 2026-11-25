import type {
  ActiveRunInfo,
  AttentionState,
  CentralToBrowser,
  HistoryMessage,
  MachineSnapshot,
  SessionSummary,
  TeamMachine,
} from '@cc-remote/shared';
import { ImageGenEventDataSchema, type ImageGenEventData } from '@cc-remote/shared';
import { cleanTitle } from './lib.js';
import { generatedRefs } from './render/imageGen.js';

export interface TranscriptLine {
  id: number;
  kind: 'system' | 'assistant' | 'tool_use' | 'result' | 'status' | 'error' | 'user';
  text: string;
  streaming?: boolean;
  /** Wall clock the line arrived at, on SPEECH lines only (`assistant`,
   *  `user`). History turns carry a `ts` from the transcript and every one of
   *  them is stamped in the gutter; a live tail with no stamp would read as the
   *  only part of the conversation that happened at no particular time. Tool
   *  and status rows are machinery and carry none. */
  ts?: number;
  /** Machine-readable meaning (`budget_exhausted`, `api_retry`, `stderr`,
   *  `compact_done` …), when the agent could tell. Lets the renderer pick a
   *  card, a seam or a folded log line instead of matching text. */
  code?: string;
  /** Structured payload for `code` (retry counters, token counts). */
  data?: Record<string, unknown>;
  /**
   * What was ATTACHED to this turn, for the person who just attached it.
   *
   * Client-side only: never crosses the wire, never comes back from history.
   * The agent strips image bytes out of `session.messages` on purpose
   * (`agent/src/history.ts` — a session with several screenshots would bloat
   * every reload), so the transcript could only ever draw a grey «image» chip
   * with nothing behind it. And in the LIVE buffer there was not even that:
   * `addLine` stored `text || placeholder`, so a message with both text and
   * pictures left no sign of the pictures at all — you pressed send and could
   * not tell whether they had gone.
   *
   * These are the same bytes that were just put on the wire, turned back into
   * data URLs. They survive as long as the live buffer does, which is exactly
   * the window in which the question «did they go?» is asked.
   */
  images?: string[];
  /** Names of non-image attachments on this turn. Same lifetime as `images`. */
  files?: string[];
  /** On a `user` line: the hub's id for this turn (`user_turn`). Absent on a
   *  composer's echo until the hub's frame confirms it — see `foldUserTurn`. */
  turnId?: string;
  /** On a `user` line: kept across a reconnect by `keepUnansweredTail`, so it
   *  sits at the head of a buffer the hub is about to refill. When the replay
   *  brings this same turn back, `foldUserTurn` moves the line to where the
   *  replay puts it instead of leaving it above the turn it was sent into. */
  carried?: boolean;
}

/** What a turn with attachments but no text says in the transcript. Pictures
 *  have no names on the wire, so they are counted; files are named. */
export function attachmentLabel(images: number, files: string[]): string {
  const pics = images === 0 ? [] : [images === 1 ? 'картинка' : `${images} картинки`];
  const all = [...pics, ...files];
  return all.length ? `[${all.join(', ')}]` : '';
}

export interface UserTurn {
  turnId: string;
  text: string;
  /** The hub sent only the head of a long message (16 KiB). */
  truncated?: boolean;
  ts?: number;
  images?: number;
  files?: string[];
}

/**
 * A person's turn, as the hub announced it (`user_turn`), into the buffer.
 *
 * Until 28.09.2026 a human turn existed on a screen only as the local echo of
 * the composer that sent it. Owner typed «1-4 гоу» on the phone while the
 * desktop followed the same run: the desktop streamed «Беру 1–4…» straight
 * under the previous answer, with the question nowhere — on disk, on the hub,
 * on the phone, just never on the screen that did not send it.
 *
 * - A turn already shown (same `turnId`) is not shown twice: the hub replays
 *   the turn's frames to every `subscribe`, and a pane re-subscribes after
 *   every reconnect.
 * - The sender already shows its own echo. The hub's frame confirms the OLDEST
 *   unconfirmed echo with the same text instead of adding a second bubble.
 * - Otherwise it is appended where it arrived: the frames come in the order the
 *   hub saw them, so a message sent mid-turn lands mid-turn.
 */
export function foldUserTurn(
  lines: TranscriptLine[],
  turn: UserTurn,
  nextId: () => number,
  now: () => number = Date.now,
  /** False for a replay the hub sent ANOTHER view on this socket (`ref`): its
   *  frames between turns are dropped here, so placing a carried line by it
   *  would put the line above the work that preceded it. Our own replay or a
   *  live frame places it. */
  settle = true,
): TranscriptLine[] {
  const known = lines.findIndex((l) => l.turnId === turn.turnId);
  if (known >= 0) return settle && lines[known]!.carried ? moveToEnd(lines, known, turn.turnId) : lines;
  const files = turn.files ?? [];
  const shown = turn.text.trim() ? turn.text : attachmentLabel(turn.images ?? 0, files);
  if (!shown.trim()) return lines;
  // A long paste arrives as its head only: the sender's full echo is still the
  // same turn when it STARTS with what the hub sent.
  const same = (echoText: string) =>
    turn.truncated ? echoText.trim().startsWith(shown.trim()) : echoText.trim() === shown.trim();
  const echo = lines.findIndex((l) => l.kind === 'user' && !l.turnId && same(l.text));
  if (echo >= 0) {
    if (settle && lines[echo]!.carried) return moveToEnd(lines, echo, turn.turnId);
    const next = [...lines];
    next[echo] = { ...next[echo]!, turnId: turn.turnId };
    return next;
  }
  return [
    ...lines,
    {
      id: nextId(),
      kind: 'user',
      text: turn.truncated ? `${shown.trimEnd()}…` : shown,
      ts: turn.ts ?? now(),
      turnId: turn.turnId,
      ...(turn.truncated ? { data: { truncated: true } } : {}),
      ...(files.length ? { files } : {}),
    },
  ];
}

/**
 * The tail of the buffer that has NOT been answered yet — the turns you just
 * sent.
 *
 * `ws.onopen` and the return-from-background path both used to drop the whole
 * live buffer, on the sound argument that a resumed stream would otherwise
 * glue onto a gapped tail. Sound for the agent's output; wrong for your own:
 * everything completed is re-read from the `.jsonl`, but a message sent two
 * seconds ago is not in that file yet, so it vanished from the screen and came
 * back only after the history round-trip (RPC hub→agent→file, plus up to six
 * 400 ms polls). On a phone, where locking the screen reconnects the socket,
 * that is most sends.
 *
 * Keeping them is safe precisely because they end up at the HEAD of the buffer,
 * which is where `dropEchoedUserLine` looks: once the file catches up, the
 * duplicate is removed by the mechanism that already exists for it.
 */
export function keepUnansweredTail(lines: TranscriptLine[]): TranscriptLine[] {
  let i = lines.length;
  while (i > 0 && lines[i - 1]!.kind === 'user') i -= 1;
  // A line still carried from an EARLIER reconnect may already have replay
  // frames under it (the link dropped again mid-replay): it is no less
  // unanswered for not being at the tail.
  const earlier = lines.slice(0, i).filter((l) => l.carried);
  return [...earlier, ...lines.slice(i).map((l) => (l.carried ? l : { ...l, carried: true }))];
}

/**
 * A carried line comes back with the replay: put it where the replay is now.
 *
 * Kept at the head of the buffer, a message sent MID-TURN sat above the very
 * turn it was sent into once the hub replayed that turn (10.10.2026: the
 * question, then the tools, then the prompt that started the turn). With the
 * head no longer the turn's opening, `dropReplayedFromPersonsTurn` could not
 * line the file up with the stream and kept the file's copy too — the question
 * twice in a row and the whole turn under it again. Same line object (it may
 * carry this composer's pictures), new place, confirmed.
 */
function moveToEnd(lines: TranscriptLine[], at: number, turnId: string): TranscriptLine[] {
  const { carried: _carried, ...line } = lines[at]!;
  return [...lines.slice(0, at), ...lines.slice(at + 1), { ...line, turnId }];
}

export interface ActiveRun {
  runId?: string;
  machineId: string;
  sessionId: string;
}

/**
 * True when `focusSession` is being asked for the session it is ALREADY
 * driving, so it must keep the attachment instead of rebuilding it.
 *
 * A brand-new session hits this on every start. The run is created before the
 * runtime has minted a session id, so the hub carries it with an empty one;
 * `session_started` then names it and the router navigates onto the session
 * route it just created, which re-focuses. At that instant the cached
 * `activity` list still holds the run under the EMPTY id, so a lookup by
 * (machineId, sessionId) finds nothing — and the miss used to unsubscribe our
 * own live run, wipe the turn off the screen and drop back to the dormant
 * "Resume" composer, while the run kept going with its frames addressed to
 * nobody. That is a session that looks hung and is not.
 */
export function alreadyFocused(
  active: ActiveRun | null,
  machineId: string,
  sessionId: string,
): boolean {
  return !!active?.runId && active.machineId === machineId && active.sessionId === sessionId;
}

/**
 * Fold fresh news into the inbox: ONE entry per session, newest first.
 *
 * It used to append every transition. On 24.09.2026 the Claude login on one
 * machine broke for half an hour, every retry of three sessions failed, and
 * the bell held eight «errored» rows for three sessions — the same news,
 * restated per attempt. The latest state of a session replaces its earlier
 * entry and moves it to the top. `added` counts sessions that were not in the
 * inbox yet, which is what the unread badge should grow by: a session that
 * failed again is not a second thing to read.
 */
export function mergeInbox(prev: NotifItem[], fresh: NotifItem[], cap = 60): { items: NotifItem[]; added: number } {
  const key = (n: NotifItem) => `${n.machineId}::${n.sessionId}`;
  const had = new Set(prev.map(key));
  const newest = new Map<string, NotifItem>();
  // `fresh` is oldest-first; the last word about a session wins.
  for (const n of fresh) newest.set(key(n), n);
  const lead = [...newest.values()].reverse();
  const items = [...lead, ...prev.filter((n) => !newest.has(key(n)))].slice(0, cap);
  const added = lead.filter((n) => !had.has(key(n))).length;
  return { items, added };
}

export interface NotifItem {
  id: number;
  runId: string;
  machineId: string;
  sessionId: string;
  title: string;
  machineName?: string;
  state: AttentionState;
  ts: number;
  /** The run's own `since` (hub time) when the entry was raised. Read marks are
   *  hub time too, so they are compared with this, never with browser `ts`. */
  since?: number;
  /** What `needs_attention` is waiting for — carried from the run so the
   *  notification can say «ждёт подтверждения: Write» instead of claiming a
   *  question. See `ActiveRunInfo.pendingKind`. */
  pendingKind?: 'question' | 'permission';
  pendingTool?: string;
  /** Which prompt rang, so the entry can leave the moment THAT prompt is
   *  answered — on any device (`pruneInbox`). */
  pendingRequestId?: string;
}

/**
 * The bell is a list of what still needs you, not a log of what happened.
 *
 * It used to be a log: an entry left only by «Очистить». Owner answered a
 * plan approval in the desktop app and the «ждёт ответа» row stayed in the
 * bell, so every question cost two acts — answering it, then clearing the
 * reminder about it (28.09.2026). Every entry now leaves when its cause is
 * gone, and each rule reads the full run list the hub re-sends on every change
 * (`activity`), so answering from the phone clears the desktop's bell too:
 *
 * - «ждёт ответа / подтверждения» — while the run is still stopped on THAT
 *   prompt. Answered, timed out, or the run is gone: nothing left to do.
 * - «готова» / «ошибка» — until the run moves on (a new turn or a retry means
 *   someone already acted on it) or the session is on screen. A run that
 *   disappears keeps its entry: a finished result or an error is still news.
 * - any entry — once its session is open in a view (`onScreen`): that view
 *   shows it, the same rule that keeps a followed run from ringing at all.
 */
export function pruneInbox(
  items: NotifItem[],
  runs: ActiveRunInfo[],
  onScreen: (n: NotifItem) => boolean,
): NotifItem[] {
  const byRun = new Map(runs.map((r) => [r.runId, r]));
  const kept = items.filter((n) => {
    if (onScreen(n)) return false;
    const run = byRun.get(n.runId);
    if (n.state === 'needs_attention') {
      return (
        !!run &&
        run.state === 'needs_attention' &&
        (!n.pendingRequestId || !run.pendingRequestId || run.pendingRequestId === n.pendingRequestId)
      );
    }
    return !run || run.state === n.state;
  });
  return kept.length === items.length ? items : kept;
}

/**
 * Fold hub `session_reads` into the map we keep (`machine::session` -> latest
 * `at`), and report which entries moved. A mark never goes backwards.
 */
export function mergeReads(
  prev: ReadonlyMap<string, number>,
  reads: ReadonlyArray<{ machineId: string; sessionId: string; at: number }>,
): Map<string, number> {
  const next = new Map(prev);
  for (const r of reads) {
    const key = `${r.machineId}::${r.sessionId}`;
    if ((next.get(key) ?? -Infinity) < r.at) next.set(key, r.at);
  }
  return next;
}

/**
 * A bell entry whose session was read on some device at or after the entry
 * was raised has been seen there — it leaves (`session_reads`).
 */
export function dropReadNotifications(
  items: NotifItem[],
  reads: ReadonlyMap<string, number>,
): NotifItem[] {
  if (!reads.size) return items;
  const kept = items.filter((n) => {
    const at = reads.get(`${n.machineId}::${n.sessionId}`);
    return at === undefined || (n.since ?? n.ts) > at;
  });
  return kept.length === items.length ? items : kept;
}

/**
 * A bell entry as another window of the same app sees it. Two windows (or two
 * tabs) each build their own bell from the same hub frames, and their local
 * `id`s and browser `ts` differ — but the session, the state and the run's hub
 * `since` are the same in both, so that is what is compared.
 *
 * Why the windows talk at all (25.10.2026, Owner): with two Hegai Code windows
 * open on Windows, opening or clearing the bell in one left the other's badge
 * and list untouched — «seen» was a private counter of each page. A
 * `session_read` to the hub would sync it, but that also clears the phone's
 * «finished» dot for an answer nobody has read (the 20.10.2026 bug), so the bell
 * is synced only between windows on this device (`BroadcastChannel`).
 */
export interface BellStamp {
  key: string;
  state: AttentionState;
  since?: number;
}

export function bellStamp(n: NotifItem): BellStamp {
  return { key: `${n.machineId}::${n.sessionId}`, state: n.state, since: n.since };
}

/** Is `n` the entry `s` describes, or an older one for the same session? A
 *  newer turn (larger hub `since`) is news the other window has not seen. */
export function stampCovers(s: BellStamp, n: NotifItem): boolean {
  if (s.key !== `${n.machineId}::${n.sessionId}`) return false;
  if (s.since !== undefined && n.since !== undefined) return n.since <= s.since;
  // No hub time on one side (an older hub or cache): only the same state.
  return s.state === n.state;
}

/** Drop the entries another window cleared. Same array when nothing goes. */
export function dropStamped(items: NotifItem[], stamps: ReadonlyArray<BellStamp>): NotifItem[] {
  if (!stamps.length || !items.length) return items;
  const kept = items.filter((n) => !stamps.some((s) => stampCovers(s, n)));
  return kept.length === items.length ? items : kept;
}

/** Fold marks from another window into the ones kept: one per session, the
 *  later hub time wins (a stale third tab must not bring a newer turn back),
 *  most recent last, at most `cap`. */
export function mergeStamps(
  prev: ReadonlyArray<BellStamp>,
  add: ReadonlyArray<BellStamp>,
  cap = 120,
): BellStamp[] {
  const byKey = new Map(prev.map((s) => [s.key, s]));
  for (const s of add) {
    const had = byKey.get(s.key);
    if (had && had.since !== undefined && (s.since === undefined || s.since < had.since)) continue;
    byKey.delete(s.key);
    byKey.set(s.key, s);
  }
  return [...byKey.values()].slice(-cap);
}

/** Wire shape between windows; anything else on the channel is ignored. */
export type BellSync = { kind: 'seen' | 'clear'; stamps: BellStamp[] };

export function parseBellSync(data: unknown): BellSync | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { kind?: unknown; stamps?: unknown };
  if ((d.kind !== 'seen' && d.kind !== 'clear') || !Array.isArray(d.stamps)) return null;
  const stamps: BellStamp[] = [];
  for (const s of d.stamps.slice(0, 200)) {
    if (!s || typeof s !== 'object') continue;
    const { key, state, since } = s as Record<string, unknown>;
    if (typeof key !== 'string' || typeof state !== 'string') continue;
    stamps.push({
      key,
      state: state as AttentionState,
      since: typeof since === 'number' ? since : undefined,
    });
  }
  return { kind: d.kind, stamps };
}

type StreamEvent = Extract<CentralToBrowser, { type: 'stream' }>['event'];

/** Sanitize titles once at ingest. Sessions arrive three ways — the whole
 *  snapshot, one machine's list, one patch — and all three come through here so
 *  none can forget it. */
export function cleanSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.map((session) =>
    session.title ? { ...session, title: cleanTitle(session.title) } : session,
  );
}

export function cleanSnapshot(machines: MachineSnapshot[]): MachineSnapshot[] {
  return machines.map((machine) => ({
    ...machine,
    sessions: cleanSessions(machine.sessions),
  }));
}

/** The snapshot's `teamMachines` for the central state: read-only hardware of
 *  team members, kept apart from `machines` so nothing that lists machines can
 *  offer one. A machine the viewer also holds in `machines` is dropped (the hub
 *  should not repeat it; the viewer's own card always wins), and a duplicate id
 *  keeps its first entry. */
export function mergeTeamMachines(
  incoming: TeamMachine[] | undefined,
  own: ReadonlyArray<{ machine: { machineId: string }; canControl?: boolean }>,
): TeamMachine[] {
  if (!incoming?.length) return [];
  // Only machines the viewer CONTROLS win: a view-only shared one comes with its
  // hardware stripped from `machines`, so its team entry is the only card with it.
  const seen = new Set(own.filter((m) => m.canControl !== false).map((m) => m.machine.machineId));
  const out: TeamMachine[] = [];
  for (const t of incoming) {
    if (seen.has(t.machine.machineId)) continue;
    seen.add(t.machine.machineId);
    out.push(t);
  }
  return out;
}

/** Index of the last line matching `pred`, or -1. */
function lastIndex(lines: TranscriptLine[], pred: (line: TranscriptLine) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (pred(lines[i]!)) return i;
  return -1;
}

/** Freeze an interrupted streaming tail before a reconnect/convergence read. */
export function freezeStreamingTail(lines: TranscriptLine[]): TranscriptLine[] {
  const last = lines[lines.length - 1];
  return last?.streaming
    ? [...lines.slice(0, -1), { ...last, streaming: false }]
    : lines;
}

/** The assistant line still being streamed, looking back past status lines
 *  only; -1 when the tail is anything else. */
export function streamingTail(lines: TranscriptLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind === 'assistant') return l.streaming ? i : -1;
    if (l.kind !== 'status') return -1;
  }
  return -1;
}

/** Fold one focused-run stream event into the render buffer. */
export function foldStreamEvent(
  lines: TranscriptLine[],
  event: StreamEvent,
  nextId: () => number,
  /** Injected like `nextId` and for the same reason: a reducer that reads the
   *  clock itself cannot be asserted on. */
  now: () => number = Date.now,
): TranscriptLine[] {
  if (event.kind === 'status' && event.code === 'plan_update') {
    const text = event.text ?? '';
    if (!text) return lines;
    const lastHuman = lastIndex(lines, (l) => l.kind === 'user');
    const previous = lastIndex(
      lines,
      (l) => l.code === 'plan_update' && l.kind === 'status',
    );
    if (previous > lastHuman) {
      const next = [...lines];
      next[previous] = { ...next[previous]!, text };
      return next;
    }
    return [...lines, { id: nextId(), kind: 'status', code: 'plan_update', text }];
  }
  if (event.kind === 'partial') {
    const text = event.text ?? '';
    // The sentence being spoken may not be the LAST line: a status can land
    // between two deltas — `background_tasks` changes whenever a background
    // agent moves, stderr, an API retry. Requiring the very last line started
    // a second streaming line mid-word, and the final `assistant` (which
    // finalizes the LAST streaming line) then left the first half on screen
    // as an orphan: «Пока аг» above «Пока агенты работают…» (10.10.2026).
    // Status lines do not end a sentence; anything else (a tool call, a human
    // turn, another answer) does.
    const open = streamingTail(lines);
    if (open >= 0) {
      const next = [...lines];
      next[open] = { ...lines[open]!, text: lines[open]!.text + text };
      return next;
    }
    // The stamp is the moment the turn STARTED speaking, set once here and kept
    // across every delta — a token arriving 40s later must not restamp it.
    return [...lines, { id: nextId(), kind: 'assistant', text, streaming: true, ts: now() }];
  }
  if (event.kind === 'assistant') {
    // A structured `turn/plan/updated` is a live preview of the answer, not a
    // second answer. Once prose lands, retire every preview from this human
    // turn before folding/appending the real assistant block.
    const lastHuman = lastIndex(lines, (l) => l.kind === 'user');
    if (lines.some((l, index) => index > lastHuman && l.code === 'plan_update')) {
      lines = lines.filter((l, index) => index <= lastHuman || l.code !== 'plan_update');
    }
    // Claude streams the reply as `partial` deltas and then repeats the whole
    // block as `assistant` — folding that in again would print the turn twice,
    // so a streaming tail takes the final text and stops streaming.
    //
    // Codex has no delta channel at all: `assistant` is the ONLY carrier of its
    // reply (agent/src/codex-run.ts emits status/tool_use/assistant/result and
    // never `partial`). Dropping it outright meant a Codex session showed its
    // commands and its plan and then went silent — the answer existed, on disk
    // and in the board preview, but the open transcript never got it and the
    // session read as hung until a reload. So with no streaming tail, append.
    // The streaming tail is not always the LAST line. One assistant message
    // carries its blocks in order — text, then every tool_use — and the agent
    // emits each as its own event, so by the time the text block arrives the
    // buffer already ends in machinery. Checking only the last line then took
    // the append branch and printed the answer a second time, stamped at the
    // moment the tools finished rather than when it was spoken: two copies of
    // one sentence, minutes apart, reading as the agent repeating itself.
    const streamingIdx = lastIndex(lines, (l) => l.kind === 'assistant' && !!l.streaming);
    if (streamingIdx >= 0) {
      const line = lines[streamingIdx]!;
      const next = [...lines];
      next[streamingIdx] = { ...line, text: event.text ?? line.text, streaming: false };
      return next;
    }
    const text = event.text ?? '';
    if (!text) return lines;
    // Nothing streaming, but the same block already spoken: a re-emission, not
    // a second sentence. (Codex has no delta channel, so its `assistant` events
    // are the only copy — which is why this is a text check, not a rule.)
    //
    // Bounded by the last human turn, and that bound is the whole correctness
    // of it: a re-emission is the SAME turn saying the same thing twice. Two
    // turns answering «Готово.» are two answers, and the unbounded search read
    // the second as an echo of the first and dropped it — the turn then
    // finished with nothing on screen at all. Short answers repeat constantly.
    const spokenIdx = lastIndex(lines, (l) => l.kind === 'assistant');
    const lastUser = lastIndex(lines, (l) => l.kind === 'user');
    if (spokenIdx >= 0 && spokenIdx > lastUser && lines[spokenIdx]!.text.trim() === text.trim()) {
      return lines;
    }
    return [...lines, { id: nextId(), kind: 'assistant', text, ts: now() }];
  }
  if (event.kind === 'result') return freezeStreamingTail(lines);
  // One compaction, one line, in the interface's language. The start is said
  // up to three times — the agent when it queues the command, again on every
  // `compacting` status the CLI reports, and the hub re-states a pending one
  // on each `subscribe` — and each used to become its own English line
  // («compacting context… (queued behind the current turn)» and two more,
  // 28.09.2026). A later start while one is still open updates that line in
  // place: same id, so Chat's «new verdict» check (`linesAtCompact`) still
  // tells a fresh `compact_done` from an old one.
  if (event.code === 'compact_started' || event.code === 'compact_done' || event.code === 'compact_failed') {
    const text = compactionWords(event.code, event.text ?? '');
    if (event.code === 'compact_started') {
      const last = lastIndex(lines, (l) => !!l.code?.startsWith('compact_'));
      if (last >= 0 && lines[last]!.code === 'compact_started') {
        const next = [...lines];
        next[last] = { ...next[last]!, text };
        return next;
      }
    }
    const line: TranscriptLine = { id: nextId(), kind: event.kind, text, code: event.code };
    if (event.data) line.data = event.data;
    return [...lines, line];
  }
  if (event.kind === 'status' && event.code === 'image_gen') {
    return foldImageGen(lines, event.data, event.text ?? '', nextId, now);
  }
  // Everything left here is machinery (system/tool_use/status/error) and carries
  // no stamp — a human turn never arrives as a stream event, it is echoed
  // locally by `addLine`, which stamps it there.
  const line: TranscriptLine = { id: nextId(), kind: event.kind, text: event.text ?? '' };
  if (event.code) line.code = event.code;
  if (event.data) line.data = event.data;
  return [...lines, line];
}

/**
 * One picture, one line, however many events say so (`image_gen`).
 *
 * The line is keyed by the event's `id` and updated IN PLACE: `started` draws
 * the placeholder, `done` turns that same line (same row id, so React keeps the
 * node) into the picture, `failed` into the error row. The hub replays the
 * turn's frames on every `subscribe`, so the events come again — a replayed
 * `started` must not pull a finished card back to a progress bar, hence a
 * settled line ignores everything. A `done` with no `started` before it (the
 * replay window evicted it) simply opens the line already finished.
 *
 * `startedAt` is the progress clock: the agent's when it sent one, the moment
 * we first saw the id otherwise.
 */
export function foldImageGen(
  lines: TranscriptLine[],
  raw: unknown,
  text: string,
  nextId: () => number,
  now: () => number = Date.now,
): TranscriptLine[] {
  const parsed = ImageGenEventDataSchema.safeParse(raw);
  if (!parsed.success) return lines;
  const d = parsed.data;
  const at = lines.findIndex((l) => l.code === 'image_gen' && l.data?.['id'] === d.id);
  if (at < 0) {
    return [
      ...lines,
      { id: nextId(), kind: 'status', code: 'image_gen', text, data: { ...d, startedAt: d.startedAt ?? now() } },
    ];
  }
  const old = lines[at]!;
  const was = old.data as unknown as ImageGenEventData;
  if (was.state !== 'started') return lines;
  const next = [...lines];
  next[at] = { ...old, text, data: { ...was, ...d, startedAt: d.startedAt ?? was.startedAt } };
  return next;
}

/** A live picture the loaded history already shows is not shown twice: once the
 *  file has the `image` block, the history owns it. Same array back when there
 *  is nothing to drop (`liveItems` is memoised on identity). */
export function dropGeneratedShownInHistory(lines: TranscriptLine[], history: HistoryMessage[]): TranscriptLine[] {
  if (!lines.some((l) => l.code === 'image_gen')) return lines;
  const refs = generatedRefs(history);
  if (!refs.size) return lines;
  const kept = lines.filter((l) => {
    if (l.code !== 'image_gen') return true;
    // Whatever state the card is in — a missed `done` (reconnect, replay gap)
    // must not leave a bar crawling beside the finished picture. The id IS the
    // ref's tail for both runtimes (`gen:<ig_…>`, `gen:<toolu_…>#n`).
    const ref = l.data?.['ref'];
    const id = l.data?.['id'];
    return !((typeof ref === 'string' && refs.has(ref)) || (typeof id === 'string' && refs.has(`gen:${id}`)));
  });
  return kept.length === lines.length ? lines : kept;
}

/** The agent and the hub word compaction in English (agent/src/claude-session.ts,
 *  codex-run.ts, the hub's re-statement); the screen says it in Russian. Keyed
 *  on the code — the reason after a failure is the runtime's own and kept. */
export function compactionWords(code: string, text: string): string {
  if (code === 'compact_started') {
    return /queued/i.test(text) ? 'Сжимаю контекст — после текущего хода…' : 'Сжимаю контекст…';
  }
  if (code === 'compact_done') {
    // «context compacted: 746k → 10k tokens» — the numbers are the news.
    const rest = text.replace(/^context compacted:?\s*/i, '').replace(/\btokens\b/i, 'токенов').trim();
    return rest ? `контекст сжат: ${rest}` : 'контекст сжат';
  }
  const reason = text.replace(/^⚠?\s*compaction failed:?\s*/i, '').trim();
  return reason ? `Не удалось сжать контекст: ${reason}` : 'Не удалось сжать контекст';
}

/** Stream events that are a sign of life, not a line: the CLI's own spinner
 *  states. Dated by the hub (`lastEventAt`), hidden by the transcript. */
export const HEARTBEAT_CODES = new Set(['requesting', 'session_state', 'turn_usage']);

/**
 * How long the hub's word on a run's state must have stood before it may
 * override the composer's optimistic `busy`. A send flips the pane busy at
 * once; the hub only learns the turn started with the first token, and every
 * activity broadcast in between still says `idle`. Without the settle window
 * the composer flickered idle for the second between send and first token.
 */
export const BUSY_SETTLE_MS = 5_000;

const NOTIFY = new Set<AttentionState>(['needs_attention', 'idle', 'error']);
const attachable = (run: ActiveRunInfo) =>
  run.state === 'working' || run.state === 'needs_attention' || run.state === 'idle';

export interface ActivityInput {
  rawRuns: ActiveRunInfo[];
  active: ActiveRun | null;
  attachedRunId: string | null;
  previousStates: ReadonlyMap<string, AttentionState>;
  seeded: boolean;
  notify: boolean;
  /** The viewer's own user id. Notifications are owner-scoped: `activity`
   *  carries every run this viewer may VIEW, which for an admin or anyone with
   *  a team share is most of the fleet. Null (viewer not resolved yet) means
   *  nothing is notified — the snapshot that carries it lands before the first
   *  activity round, and `seeded` already swallows that round anyway. */
  viewerId: string | null;
  now: number;
  nextId: () => number;
}

export interface ActivityResult {
  runs: ActiveRunInfo[];
  nextStates: Map<string, AttentionState>;
  active: ActiveRun | null;
  activeChanged: boolean;
  attachedRunId: string | null;
  subscribeRunId?: string;
  busy?: boolean;
  clearToolRequest: boolean;
  notifications: NotifItem[];
}

/**
 * Pure active-run reconciliation. It describes the required subscription and
 * state transitions; the hook owns the actual WebSocket/Notification effects.
 */
export function reconcileActivity(input: ActivityInput): ActivityResult {
  const runs = input.rawRuns.map((run) =>
    run.title ? { ...run, title: cleanTitle(run.title) } : run,
  );
  let active = input.active;
  let attachedRunId = input.attachedRunId;
  let subscribeRunId: string | undefined;
  let busy: boolean | undefined;
  let clearToolRequest = false;
  let activeChanged = false;

  if (active) {
    const cur = active;
    const forSession = (run: ActiveRunInfo) =>
      run.machineId === cur.machineId && run.sessionId === cur.sessionId && attachable(run);
    // A view that lost its run id but still names a real session takes the
    // session's live run in THIS round. It used to drop to dormant first and
    // re-attach only on the next `activity`, and a run that went idle in between
    // sent none — the pane sat on the question with the answer addressed to
    // nobody, and the next send bounced with `run_active` (20.10.2026).
    const match = cur.runId
      ? (runs.find((run) => run.runId === cur.runId && attachable(run)) ??
        (cur.sessionId ? runs.find(forSession) : undefined))
      : runs.find(forSession);
    if (match && attachedRunId !== match.runId) {
      active = {
        runId: match.runId,
        machineId: match.machineId,
        sessionId: match.sessionId,
      };
      activeChanged = true;
      busy = match.state === 'working';
      subscribeRunId = match.runId;
    } else if (match) {
      // Already attached: the hub's state is the truth about `busy` too. It
      // used to be read only when the attachment CHANGED, so a `result` frame
      // lost in a blip left the pane on «working…» for good — every later
      // activity frame said `idle` and none was listened to. The settle window
      // protects the optimistic flip a send makes (see BUSY_SETTLE_MS).
      if (match.state === 'working' || match.state === 'needs_attention') busy = true;
      else if (input.now - match.since >= BUSY_SETTLE_MS) busy = false;
      // A `session_started` this view never saw (it is sent only to the run's
      // subscribers, and a view attaches a beat later) left it on the empty
      // placeholder id: the composer then had no session to resume and the
      // history no file to read. The hub's list knows the name — take it.
      if (match.sessionId && cur.sessionId !== match.sessionId) {
        active = { runId: match.runId, machineId: match.machineId, sessionId: match.sessionId };
        activeChanged = true;
      }
    } else if (active.runId && !match) {
      active = { machineId: active.machineId, sessionId: active.sessionId };
      activeChanged = true;
      attachedRunId = null;
      busy = false;
      clearToolRequest = true;
    }
  }

  const focusedRunId = active?.runId;
  const nextStates = new Map<string, AttentionState>();
  const notifications: NotifItem[] = [];
  for (const run of runs) {
    nextStates.set(run.runId, run.state);
    const previous = input.previousStates.get(run.runId);
    if (
      input.notify &&
      input.seeded &&
      // An entrance is not a transition: a run that shows up already waiting
      // or finished was re-adopted after a hub restart or an agent reconnect,
      // not just asked. A run that really starts is born `working`. Same rule
      // as the desktop tray (`Watcher::ingest`, windows/src-tauri/src/hub/notify.rs).
      previous !== undefined &&
      previous !== run.state &&
      NOTIFY.has(run.state) &&
      run.runId !== focusedRunId &&
      // Yours only, the way `emit_push` already scopes the phone (hub.rs
      // `emit_push` sends to the owner's device tokens). The web had no such
      // check, so a platform admin — who may view the whole fleet — got a bell
      // for every colleague's session going idle.
      !!input.viewerId &&
      run.ownerUserId === input.viewerId
    ) {
      notifications.push({
        id: input.nextId(),
        runId: run.runId,
        machineId: run.machineId,
        sessionId: run.sessionId,
        title: run.title ?? run.sessionId.slice(0, 8),
        machineName: run.machineName,
        state: run.state,
        ts: input.now,
        since: run.since,
        pendingKind: run.pendingKind,
        pendingTool: run.pendingTool,
        pendingRequestId: run.pendingRequestId,
      });
    }
  }

  return {
    runs,
    nextStates,
    active,
    activeChanged,
    attachedRunId,
    subscribeRunId,
    busy,
    clearToolRequest,
    notifications,
  };
}


/**
 * Drop the optimistic echo of a user turn once the transcript itself carries it.
 *
 * The echo (what the composer shows the instant you press send) and the same
 * turn re-read from the `.jsonl` are one message. Rendering both is a visible
 * duplicate at the history/live seam; dropping the wrong one makes the person's
 * own message VANISH while the data is perfectly intact — the worse failure,
 * because there is nothing on screen to notice and nothing to blame.
 *
 * Two rules keep it honest, and both exist because breaking them is silent:
 *
 * - Compare against the last user turn that actually CARRIES TEXT. A `user` row
 *   in a Claude transcript is also how tool results arrive, and those have no
 *   text blocks — taking the last `user` row blindly compares the echo against
 *   an empty string on any turn that ended with a tool result.
 * - Never drop while history is being re-read. `lines` is cleared on reconnect
 *   and history lands a moment later, so in between the echo is the ONLY copy of
 *   the message on screen.
 */
/** The last user turn that actually carries text. A `user` row is also how tool
 *  results arrive, and those have none — which is why "the last user row" and
 *  "the last thing the person said" are not the same question. */
export function lastUserText(history: HistoryMessage[]): string | undefined {
  // `messageText`, not raw blocks: a sub-agent's `<task-notification>` rides
  // on its call's result and is not something the person said.
  const hit = [...history].reverse().find((m) => m.type === 'user' && messageText(m));
  const text = hit ? messageText(hit) : undefined;
  return text || undefined;
}

/** All the text of one history message, as the live buffer would have shown it.
 *  A sub-agent's ending rides as a `<task-notification>` text block on its
 *  call's result (`attachTaskNotices` in agent/src/history.ts); the live buffer
 *  shows it as a card, never as speech, and reading it as words made a tool
 *  result look like something the person said that the stream lacked — so
 *  `dropReplayedFromPersonsTurn` kept the whole turn twice. */
function messageText(msg: HistoryMessage): string {
  return msg.blocks
    .map((b) => (b.kind === 'text' ? b.text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '') : ''))
    .join('')
    .trim();
}

/**
 * Generalised from the user echo: ANY leading live line the file has caught up
 * with is a duplicate, not just the person's own turn.
 *
 * The one seen in the wild was an ANSWER printed twice, a minute apart. The
 * text existed once on disk; the two copies were the live line (stamped when it
 * streamed) and the same turn re-read from the `.jsonl` (stamped from the
 * file), so they did not even look like the same message — a reader sees the
 * agent repeating itself, not a rendering fault.
 *
 * Matching is a PREFIX against the tail of history, in order, never "this text
 * appears somewhere in the file": a person who says «ок» twice in an hour must
 * not have their second «ок» swallowed because the first one is on disk. And a
 * streaming line is never dropped — it is the only copy of a turn still being
 * written.
 */
const SEAM_DEPTH = 8;

/**
 * The other overlap, and the one the seam logic above CANNOT see: the file's
 * copy of a turn the hub is replaying.
 *
 * Opening a session while the agent is mid-turn gets the same words twice, from
 * two places that are both right. `session.messages` reads the `.jsonl`, and the
 * runtime flushes each finished assistant message to it as the turn goes — so a
 * long turn is already half on disk. Then `subscribe` makes the hub send its
 * replay window (`REPLAY_MAX_FRAMES` in server-rs/src/hub.rs), which holds the
 * stream of the CURRENT TURN from its start precisely so a pane that joins late
 * "opens showing work in progress rather than nothing". The two copies overlap
 * from the turn's beginning to wherever the file had got to.
 *
 * `dropEchoedUserLine` cannot fix this: it anchors the live buffer's head
 * against the TAIL of history, which assumes the stream begins where the file
 * ends. A replayed turn begins in the MIDDLE of the file's tail, and the tool
 * rows between the paragraphs stop its scan at the first line anyway.
 *
 * So this works the other way round — it trims the FILE, not the stream:
 *
 * - The search is confined to the current turn (everything after the last thing
 *   the person said). A turn is all the replay window can hold, and an agent
 *   that repeats a sentence an hour later must not have the earlier one erased.
 * - The anchor is the live buffer's first SETTLED spoken line. A streaming line
 *   is a fragment, and a fragment compares equal to nothing.
 * - Equality, never "contains". If the replay window has evicted its early
 *   frames, no history message matches and NOTHING is dropped: the duplicate
 *   survives to the end of the turn, where the convergence re-read clears the
 *   live buffer. A visible duplicate is a blemish; dropping a paragraph the
 *   stream no longer carries is a disappearance.
 */
export function dropReplayedTurnFromHistory(
  history: HistoryMessage[],
  lines: TranscriptLine[],
): HistoryMessage[] {
  if (!history.length || !lines.length) return history;
  const head = lines.find((l) => l.kind === 'user' || l.kind === 'assistant');
  if (!head || head.streaming) return history;
  if (head.kind === 'user') return dropReplayedFromPersonsTurn(history, lines, head);
  if (head.kind !== 'assistant') return history;
  const text = head.text.trim();
  if (!text) return history;
  // Where the current turn starts: after the last thing the PERSON said. Not
  // "the last `user` row" — a tool result is a `user` row carrying no text, and
  // a working turn is full of them, so that reading puts the turn's start after
  // its own machinery and the search never reaches the paragraph it is looking
  // for. Same trap `lastUserText` exists for, two functions up.
  let turnStart = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.type === 'user' && messageText(m)) {
      turnStart = i + 1;
      break;
    }
  }
  for (let i = turnStart; i < history.length; i++) {
    const m = history[i]!;
    if (m.type === 'assistant' && messageText(m) === text) return history.slice(0, i);
  }
  return history;
}

/**
 * The replay window now OPENS with the person's turn (`user_turn`), so a pane
 * that attaches mid-turn has the whole turn live — question included — while
 * the file holds the part already flushed. Trim the file's copy from that
 * question on, but only when it is provably the same turn:
 *
 * - the head is the hub's turn (`turnId`): a composer's echo not yet
 *   confirmed is `dropEchoedUserLine`'s business;
 * - the file's record is not clearly older than the turn (the sender's page
 *   usually holds a file read before it, and the same words said again are a
 *   new turn);
 * - the file's LAST record of those words is the anchor, and nothing the
 *   person said after it is missing from the live buffer (an older «ок» with
 *   later turns after it is not this turn);
 * - if the file already has the agent speaking after it, the live buffer's
 *   first settled answer says the same thing (an older «ок» that was the
 *   previous turn has a different answer under it).
 *
 * Anything short of that keeps the file whole: a duplicate until the turn
 * lands is a blemish, a missing turn is the bug this replaced.
 */
function dropReplayedFromPersonsTurn(
  history: HistoryMessage[],
  lines: TranscriptLine[],
  head: TranscriptLine,
): HistoryMessage[] {
  if (!head.turnId) return history;
  const cut = head.data?.['truncated'] === true;
  // A truncated head reads «…» at the end; the file has the whole message.
  const text = (cut ? head.text.replace(/…$/, '') : head.text).trim();
  if (!text) return history;
  const said = (m: HistoryMessage) => (cut ? messageText(m).startsWith(text) : messageText(m) === text);
  let at = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.type === 'user' && said(m)) {
      at = i;
      break;
    }
  }
  if (at < 0) return history;
  // The page's copy of the file usually predates this turn — and the SENDER's
  // echo carries a `turnId` too once the hub confirms it. So the newest record
  // of the same words can be a previous turn («проверь CI» said twice): trimming
  // there hid the whole earlier exchange until the turn ended. A record clearly
  // older than this turn is not its flushed copy; 30 s covers agent vs
  // hub/browser clock skew.
  const fileTs = history[at]!.ts;
  if (head.ts !== undefined && fileTs !== undefined && fileTs < head.ts - 30_000) return history;
  // A long paste is live as its head plus «…» (`truncated`), whole in the file.
  // Only what the live buffer holds AFTER the head can vouch for what the file
  // holds after the anchor.
  const liveAfter = lines.slice(lines.indexOf(head) + 1);
  const liveSaid = (t: string) =>
    liveAfter.some(
      (l) =>
        l.kind === 'user' &&
        (l.data?.['truncated'] === true ? t.startsWith(l.text.replace(/…$/, '').trim()) : l.text.trim() === t),
    );
  const after = history.slice(at + 1);
  if (after.some((m) => m.type === 'user' && messageText(m) && !liveSaid(messageText(m)))) return history;
  const fileAnswer = after.find((m) => m.type === 'assistant' && messageText(m));
  if (fileAnswer) {
    const liveAnswer = lines.find((l) => l.kind === 'assistant' && !l.streaming && l.text.trim());
    if (!liveAnswer || liveAnswer.text.trim() !== messageText(fileAnswer)) return history;
  }
  return history.slice(0, at);
}

export function dropEchoedUserLine(
  lines: TranscriptLine[],
  history: HistoryMessage[],
  loadingHistory: boolean,
): TranscriptLine[] {
  if (loadingHistory || !lines.length || !history.length) return lines;
  // Only the turns a live line could be a copy of: the spoken ones. Tool
  // results ride in as `user` rows carrying no text and would otherwise pair
  // with an empty string.
  const spoken = history
    .filter((m) => (m.type === 'user' || m.type === 'assistant') && messageText(m))
    .slice(-SEAM_DEPTH);
  const head: TranscriptLine[] = [];
  for (const line of lines) {
    if (line.kind !== 'user' && line.kind !== 'assistant') break;
    if (line.streaming) break;
    head.push(line);
    if (head.length >= SEAM_DEPTH) break;
  }
  for (let k = Math.min(head.length, spoken.length); k > 0; k--) {
    const tail = spoken.slice(-k);
    const matches = tail.every((msg, i) => {
      const line = head[i]!;
      return msg.type === line.kind && messageText(msg) === line.text.trim();
    });
    if (matches) return lines.slice(k);
  }
  return lines;
}

/**
 * The one owner of "text we sent that may not have arrived".
 *
 * `sendInput` hands text to a live run, and the socket taking the frame is not
 * delivery: the run can have been released moments earlier, and then this copy
 * is all that is left of the message. So it is held — and handed back to the
 * composer if the hub answers `run_gone` / `machine_offline`.
 *
 * It used to be a bare ref set on every send and cleared only by a recovery.
 * There was no «the run got it» branch at all, so the ref kept the last
 * DELIVERED message indefinitely: a machine going offline and coming back
 * answers `machine_offline`, and that stale text was pasted into the composer
 * while its matching turn was pulled back OUT of the transcript — a delivered
 * message reading as unsent, on a session nobody had touched. Being one ref for
 * the whole app, it could also hand you, in the session you arrived at, the
 * text you wrote in the one you left.
 *
 * Hence an object with the whole lifecycle in one place, testable on its own.
 */
export interface UnsentGuard {
  /** Text just handed to a run; joins anything still held. */
  sent(text: string): void;
  /** The run produced output, so it is alive and received what we gave it. */
  delivered(): void;
  /** Our own turn came back from the hub: the run got it. `truncated`: `text` is
   *  the head of a longer message. */
  echoed(text: string, truncated?: boolean): void;
  /** The run took ONE input since: the oldest held, as they are delivered in order. */
  tookOne(): void;
  /** Something is held that nothing has confirmed yet. */
  pending(): boolean;
  /** Focus moved to another session; the net belongs to the one it was typed in. */
  left(): void;
  /** The hub refused with this code — the texts to put back, oldest first. */
  recover(code: string | undefined, message: string): string[];
}

/** Codes that mean «nothing was delivered». The sentence match keeps a hub that
 *  predates the codes working. */
export function nothingWasDelivered(code: string | undefined, message: string): boolean {
  return code === 'connection_lost' || code === 'run_gone' || code === 'machine_offline' || /run not found/i.test(message);
}

export function createUnsentGuard(): UnsentGuard {
  let held: string[] = [];
  return {
    sent(text) {
      held.push(text);
    },
    delivered() {
      held = [];
    },
    echoed(text, truncated) {
      const t = text.trim();
      const at = held.findIndex((h) => (truncated ? h.trim().startsWith(t) : h.trim() === t));
      if (at >= 0) held.splice(at, 1);
    },
    tookOne() {
      held.shift();
    },
    pending: () => held.length > 0,
    left() {
      held = [];
    },
    recover(code, message) {
      if (!nothingWasDelivered(code, message)) return [];
      const texts = held;
      held = [];
      return texts;
    },
  };
}

/** The CLI's note of a pasted picture — `[Image: source: <path>]`, alone in a
 *  text block. Agents since 27.09.2026 drop these while reading (`parseRecord`),
 *  but the hub's replica still holds copies taken before, so the page drops
 *  them too: rendered, they were a column of /tmp paths posing as your turns. */
const IMAGE_SOURCE_MARKER = /^(\[Image: source: [^\]\n]+\]\s*)+$/;

export function dropCliImageNotes(history: HistoryMessage[]): HistoryMessage[] {
  let changed = false;
  const out: HistoryMessage[] = [];
  for (const m of history) {
    if (m.type !== 'user') {
      out.push(m);
      continue;
    }
    const blocks = m.blocks.filter((b) => !(b.kind === 'text' && IMAGE_SOURCE_MARKER.test(b.text.trim())));
    if (blocks.length === m.blocks.length) {
      out.push(m);
      continue;
    }
    changed = true;
    if (blocks.length) out.push({ ...m, blocks });
  }
  return changed ? out : history;
}
