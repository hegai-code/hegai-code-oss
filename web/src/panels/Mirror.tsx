import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, Eye } from '../icons.js';
import type { Enrichment, HistoryMessage, ImageInput, FileInput, SessionSummary } from '@cc-remote/shared';
import { AttachButton, AttachPreview, useImageAttachment, useAutoGrowTextarea, enterShouldSend, useComposerHeight } from '../composer.js';
import type { useCentral } from '../useCentral.js';
import type { MirrorHandle } from '../useCentral.js';
import { MessageView, ToolRunRow, groupHistory, stripCitations, stripHarnessNoise } from '../render/Blocks.js';
import { buildTurnDigest, heuristicEnrichment, mergeEnrichment, textKey } from '../render/enrich.js';
import { EnrichStrip } from '../render/EnrichStrip.js';
import { agentName, viewerName } from '../lib.js';
import { AttachmentContext, type FetchAttachment, scopedFetch } from '../render/Attachment.js';
import { FilePeekContext, makeFilePeek } from '../render/FilePreviews.js';

type Central = ReturnType<typeof useCentral>;

/**
 * Read-only live VIEW of a session that is currently open in the editor.
 * Streams the transcript by tailing its .jsonl on the agent — NO second
 * writer, so it is always safe to watch even while VSCode is driving.
 *
 * There are no takeover buttons anymore: the composer at the bottom IS the
 * takeover. Sending a message force-takes the session over (the agent kills
 * the editor's writer, confirms the pid is gone, resumes here) and delivers
 * the message — the hint under the input says exactly that.
 */
export function Mirror({
  central,
  session,
  machineId,
  onSend,
  readOnly = false,
}: {
  central: Central;
  session: SessionSummary;
  machineId: string;
  /** Force-take the session over and deliver the first message. */
  /** Reports delivery: false means the frame never left the browser, so the
   *  composer keeps the text instead of latching shut on a message nobody got. */
  onSend: (message: string, images?: ImageInput[], files?: FileInput[]) => boolean;
  readOnly?: boolean;
}) {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [dead, setDead] = useState(false);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  // The Mirror composer is a real composer: the same paste / drag-and-drop /
  // «+» as the chat. It was text-only, so the one place where you are most
  // likely to be handed a screenshot — watching a session someone else is
  // driving — was the one place you could not attach it.
  const picker = useImageAttachment();
  // Grows with its content, like the chat composer. It never did, and until
  // Enter sent unconditionally that cost nothing — there was no way to put a
  // second line in it. Now that Enter inserts a newline on a phone, a box
  // pinned at 40px would scroll the takeover message out of sight as you typed
  // it, showing one line at a time.
  const taRef = useAutoGrowTextarea(draft, 0.4);
  const composerRef = useComposerHeight();
  // Bumped by the auto-retry timer to re-run the open effect after the live
  // view dies (agent blip) — the deps carry no signal for "agent came back".
  const [retry, setRetry] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const seen = useRef(new Set<string>());
  const shownSession = useRef<string | null>(null);

  useEffect(() => {
    if (!dead) return;
    const t = setTimeout(() => setRetry((r) => r + 1), 5000);
    return () => clearTimeout(t);
  }, [dead, retry]);

  useEffect(() => {
    // Re-runs when the hub connection comes back or the retry timer fires — a
    // reconnect/agent drop kills the old subscription (mirror_exit / cleared subs).
    if (!session.cwd || central.status !== 'open') return;
    let handle: MirrorHandle | null = null;
    let cancelled = false;
    // Blank the pane only when SWITCHING sessions; a re-open of the same one
    // keeps the rendered transcript until the fresh replace frame lands (the
    // uuid dedupe absorbs the overlap).
    if (shownSession.current !== session.sessionId) {
      shownSession.current = session.sessionId;
      seen.current = new Set();
      setMessages([]);
      setSent(false);
      // Mirror isn't keyed by session — without this, atBottom=false left by
      // scrolling in the PREVIOUS session stops the new one from jumping to
      // its tail on open.
      setAtBottom(true);
    }
    setConnected(false);
    setDead(false);

    central
      .openMirror(
        machineId,
        session.sessionId,
        session.cwd,
        (replace, msgs) => {
          setConnected(true);
          if (replace) {
            seen.current = new Set(msgs.map((m) => m.uuid));
            setMessages(msgs);
            // A replace frame is a (re)open — land at the tail, like opening
            // a chat lands on the newest message.
            setAtBottom(true);
          } else {
            const fresh = msgs.filter((m) => !seen.current.has(m.uuid));
            fresh.forEach((m) => seen.current.add(m.uuid));
            if (fresh.length) setMessages((prev) => [...prev, ...fresh]);
          }
        },
        () => setDead(true),
      )
      .then((h) => {
        if (cancelled) h.close();
        else handle = h;
      })
      .catch(() => {
        if (!cancelled) setDead(true);
      });

    return () => {
      cancelled = true;
      handle?.close();
    };
    // `resumeEpoch`: a hushed hub DROPS mirror frames rather than queueing them,
    // and this pane appends by uuid — so a gap left by a backgrounded tab would
    // never heal. Re-opening pulls a fresh `replace` frame over the whole tail.
  }, [session.sessionId, session.cwd, machineId, central.openMirror, central.status, central.resumeEpoch, retry]);

  // A live session appends constantly — only follow the tail when the user is
  // already AT the tail, so scrolling up to read is never yanked back down.
  useEffect(() => {
    if (atBottom) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, atBottom]);
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };
  const scrollToBottom = () =>
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });

  // Memoized for the same reason as in Chat: grouping mints new objects, and a
  // mirror appends constantly.
  const items = useMemo(() => groupHistory(messages), [messages]);

  const where = session.entrypoint ?? 'редактор';

  const submit = () => {
    if ((!draft.trim() && !picker.hasAttachments) || sent) return;
    // Clearing and latching BEFORE knowing the frame went out lost the message
    // whenever the socket had just closed: the error toast appeared, the text
    // was gone, and the composer stayed stuck on "Taking over…" for the life of
    // the mount. Keep the draft unless the hub actually got it.
    if (!onSend(draft.trim(), picker.toImages(), picker.toFiles())) return;
    setDraft('');
    picker.clearAll();
    setSent(true);
  };

  // Enrichment strip over the mirrored tail — same two layers as Chat. A tap
  // here is a REAL takeover (`onSend` is the sanctioned force-take path, same
  // as the composer below), so it hides while the editor's writer is mid-turn
  // and once a send is already in flight.
  const working = central.runFor(machineId, session.sessionId)?.state === 'working';
  const tail = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind !== 'msg') continue;
      if (it.msg.type !== 'assistant') return null;
      const text = it.msg.blocks
        .map((b) => (b.kind === 'text' ? stripCitations(stripHarnessNoise(b.text)) : ''))
        .join('\n')
        .trim();
      return text ? { uuid: it.msg.uuid, text } : null;
    }
    return null;
  }, [items]);
  const heuristic = useMemo(() => (tail ? heuristicEnrichment(tail.text) : null), [tail]);
  // Same contract as Chat: keyed by text, silent while the model reads the
  // turn, its answer final (an empty one included), heuristics only when it
  // could not answer. The editor's writer has no `turn_settled` to give, so
  // `working` from the hub's inventory is the gate here.
  const tailKey = tail ? textKey(tail.text) : null;
  const [llmEnrich, setLlmEnrich] = useState<{ key: string; data: Enrichment | null; failed?: boolean } | null>(null);
  const enrichAsked = useRef<string | null>(null);
  useEffect(() => {
    if (!tail || !tailKey || readOnly || sent || working) return;
    if (enrichAsked.current === tailKey) return;
    enrichAsked.current = tailKey;
    const key = tailKey;
    const digest = buildTurnDigest(messages, [], { cwd: session.cwd });
    central
      .enrich(machineId, session.sessionId, session.source, tail.uuid, tail.text.slice(-6000), undefined, digest)
      .then((data) => setLlmEnrich({ key, data }))
      .catch(() => setLlmEnrich({ key, data: null, failed: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the tail turn; the rest is read at fire time
  }, [tailKey, readOnly, sent, working]);
  const enrichment = useMemo(() => {
    if (!tail || llmEnrich?.key !== tailKey) return null;
    return mergeEnrichment(heuristic, llmEnrich.failed ? null : llmEnrich.data);
  }, [tail, tailKey, heuristic, llmEnrich]);
  const showStrip = !!enrichment && connected && !readOnly && !sent && !working;
  const quickReply = (text: string) => {
    if (sent || !onSend(text)) return;
    setSent(true);
  };

  const fetchAttachment = useMemo<FetchAttachment>(
    () =>
      scopedFetch(async (ref) => {
      const got = await central.rpc<{ mediaType: string; dataB64: string }>(
        machineId,
        'session.image',
        { sessionId: session.sessionId, ref, source: session.source },
        true,
      );
      return got?.dataB64 ? got : null;
      }, `${machineId}\u0000${session.sessionId}\u0000${session.source ?? ''}`),
    [central.rpc, machineId, session.sessionId, session.source],
  );

  const filePeek = useMemo(
    () => (session.cwd ? makeFilePeek(central.rpc, machineId, session.cwd) : null),
    [central.rpc, machineId, session.cwd],
  );

  return (
    <AttachmentContext.Provider value={fetchAttachment}>
    <FilePeekContext.Provider value={filePeek}>
    <div className="chat">
      <div className="mirror-banner">
        <span className="live-dot" />
        <Eye size={15} />
        <span>
          Смотрим живую сессию (<b>{where}</b>) — только чтение, второго писателя не будет.
        </span>
      </div>

      <div className={`log ${session.source === 'codex' ? 'codex' : ''}`} ref={logRef} onScroll={onLogScroll}>
        <div className="log-inner">
          {dead && <div className="line error">живой просмотр прервался — агент не в сети (пробуем снова…)</div>}
          {!dead && !connected && <div className="line status">подключаемся к живой сессии…</div>}
          {items.map((it) =>
            it.kind === 'msg' ? (
              <MessageView
                key={it.id}
                msg={it.msg}
                agent={agentName(session.source)}
                you={viewerName(session.owner, 'Автор')}
                cont={it.cont}
                showStamp={it.showStamp}
                runBefore={it.runBefore}
                runAfter={it.runAfter}
              />
            ) : (
              <ToolRunRow key={it.id} blocks={it.blocks} />
            ),
          )}
          {connected && messages.length === 0 && (
            <div className="line status">сообщений пока нет — ждём активности…</div>
          )}
          {showStrip && enrichment && (
            <EnrichStrip
              enrichment={enrichment}
              onReply={quickReply}
              replyTitle={(send) => `${send} — сессия перейдёт сюда`}
            />
          )}
        </div>
      </div>

      {!atBottom && (
        <button className="scroll-bottom" onClick={scrollToBottom} aria-label="Вниз к последнему">
          <ArrowDownIcon size={16} />
        </button>
      )}

      {readOnly ? (
        <div className="mirror-locked">
          <span>Ввод закрыт — общая сессия, только чтение</span>
        </div>
      ) : (
        <div className="composer" ref={composerRef}>
          <div
            className={`composer-box cg ${picker.dragging ? 'dropping' : ''}`}
            onPaste={picker.onPaste}
            onDragOver={picker.onDragOver}
            onDragLeave={picker.onDragLeave}
            onDrop={picker.onDrop}
          >
            <AttachPreview picker={picker} />
            <textarea
              ref={taRef}
              rows={1}
              value={draft}
              placeholder={sent ? 'Забираем сессию…' : 'Сообщение — сессия перейдёт сюда…'}
              disabled={sent}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (!enterShouldSend(e)) return;
                e.preventDefault();
                submit();
              }}
            />
            <div className="composer-actions">
              <AttachButton picker={picker} />
              <span className="composer-hint">
                {sent
                  ? `Забираем сессию (${where})…`
                  : `Отправка заберёт сессию (${where}) сюда`}
              </span>
              <button
                className="send-round"
                disabled={(!draft.trim() && !picker.hasAttachments) || sent}
                onClick={submit}
                title={`Забрать сессию (${where}) и отправить`}
                aria-label="Забрать и отправить"
              >
                <ArrowUpIcon size={17} weight="bold" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </FilePeekContext.Provider>
    </AttachmentContext.Provider>
  );
}
