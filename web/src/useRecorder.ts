import { useCallback, useEffect, useRef, useState } from 'react';
import { polishDictationText, type DictationPolisher } from './polish.js';
import { PhraseStream, type PhraseRecorder } from './phrases.js';

export type RecorderState = 'idle' | 'recording' | 'transcribing';

/** No Web Audio, or a context the browser refused to start. The waveform reads
 *  this as "drive yourself from CSS" — a flat line at the floor would read as a
 *  broken meter, and the meter is the optional part; dictation still works. */
export const LEVEL_UNAVAILABLE = -1;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Mic → text: records with MediaRecorder (webm/opus), posts the blob through
 * `transcribe`, and hands the result to `onText`. One toggle: idle→recording→
 * (stop)→transcribing→idle, plus `cancel` to throw the clip away.
 *
 * It also meters the microphone while recording (`getLevel`), because the three
 * states used to be spent on one 40×40 button: you pressed it and could not
 * tell the mic was live, you released it and could not tell anything was
 * happening. See `DictationStrip` in composer.tsx for what reads this.
 */
export function useRecorder(
  transcribe: (blob: Blob, durSec?: number) => Promise<string>,
  /**
   * The recognised text. `immediate` is true when the recording was ended by
   * `sendNow()` rather than by the microphone — the caller is expected to SEND
   * it rather than put it in the composer.
   *
   * It matters that this is one callback and not two: the text arrives long
   * after the button was pressed (a GPU queue, up to 90s), and by then the only
   * record of which button it was is the flag carried alongside it.
   */
  onText: (text: string, immediate: boolean, raw?: string, polishFailed?: boolean) => void,
  /**
   * Say so when it fails. Both failure paths used to end in `console.warn` and
   * a silent return to idle — press the microphone, speak, press again, nothing
   * appears, and nothing on screen says whether the mic, the network or the
   * service was the problem. Dictation has in fact been refused server-side
   * since 2026-09-17 (Azure 403, «Public access is disabled»), and from the
   * phone that was indistinguishable from a dead button.
   */
  onError?: (message: string) => void,
  /**
   * Clean the recognised text up before it lands in the composer (polish.ts,
   * `/polish` on the hub). On the `immediate` path it is called with
   * `safe = true` — see `polishDictationText`. Resolves to a `PolishResult`; it
   * must never throw and never lose the text. When it rewrites, `onText` gets
   * the rewrite and the original as `raw`, for the «как сказал» switch.
   *
   * Read through a ref: the caller builds it from the conversation on screen,
   * which moves on while you talk.
   */
  polish?: DictationPolisher,
) {
  const polishRef = useRef(polish);
  polishRef.current = polish;
  /** Recognition is done and the rewrite is being waited for — still the
   *  `transcribing` state (every «busy» check keeps working), a different word. */
  const [polishing, setPolishing] = useState(false);
  const [state, setState] = useState<RecorderState>('idle');
  /** Live dictation: phrases already recognised while still recording, and
   *  whether one is being read right now. See phrases.ts. */
  const [live, setLive] = useState<{ text: string; pending: boolean }>({ text: '', pending: false });
  const phrasesRef = useRef<PhraseStream | null>(null);
  const phraseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The stream between the stop and its last phrase being read — detached
   *  from `phrasesRef` but still abortable by unmount. */
  const finishingRef = useRef<PhraseStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const aliveRef = useRef(true);
  /** Mirrors `state` so `toggle` can read it without a state updater — see the
   *  note on `toggle` below. */
  const stateRef = useRef<RecorderState>('idle');
  const cancelRef = useRef(false);
  /** A `start()` is between its first line and its last — chiefly while the
   *  permission prompt is up. `stateRef` is still `idle` then, so a second
   *  press passes `toggle`'s check, opens a second stream and orphans the first
   *  recorder. A ref, not state: both presses must read it fresh. */
  const startingRef = useRef(false);
  /** Set by `sendNow()`, read once the transcription lands — see `onText`. */
  const sendRef = useRef(false);
  /** When the current recording began (`Date.now()`), for the clip length sent to /transcribe. */
  const startedAtRef = useRef(0);
  /** A clip the service refused to read, kept so the words are not lost with
   *  the error. `immediate` is the person's send intent and is kept with it. */
  const failedRef = useRef<{ blob: Blob; immediate: boolean; durSec: number } | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const setFailed = useCallback((f: { blob: Blob; immediate: boolean; durSec: number } | null) => {
    failedRef.current = f;
    setCanRetry(!!f);
  }, []);

  // The meter: an analyser tapped off the same MediaStream the recorder uses.
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // `Float32Array<ArrayBuffer>`, not a bare `Float32Array`: the latter is
  // `ArrayBufferLike`, which admits a SharedArrayBuffer, and
  // `getFloatTimeDomainData` will not take one.
  const pcmRef = useRef<Float32Array<ArrayBuffer> | null>(null);

  const set = useCallback((s: RecorderState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /** Release the analyser, keep the context (one per hook instance — Safari
   *  caps how many a page may have, and a new one outside a user gesture would
   *  start suspended). */
  const dropMeter = useCallback(() => {
    try {
      srcRef.current?.disconnect();
    } catch {
      /* context already torn down */
    }
    srcRef.current = null;
    analyserRef.current = null;
    pcmRef.current = null;
  }, []);

  /** Built synchronously inside the click, never after an `await`: Safari
   *  starts a context created outside a user gesture in `suspended` and then
   *  refuses `resume()` off-gesture, which is exactly a dead-looking meter. */
  const audioContext = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    const Ctx = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctx) return null; // no Web Audio → no meter; dictation is unaffected
    try {
      ctxRef.current = new Ctx();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  /** Current loudness, 0…1, sampled on demand; `LEVEL_UNAVAILABLE` when there
   *  is no analyser to ask. Imperative on purpose: this hook lives in the body
   *  of the component that renders the whole transcript, so a level in state
   *  would mean 20 reconciliations of the log per second. The waveform reads
   *  this from its own rAF and writes the bars straight to the DOM. */
  const getLevel = useCallback(() => {
    const an = analyserRef.current;
    const pcm = pcmRef.current;
    if (!an || !pcm) return LEVEL_UNAVAILABLE;
    an.getFloatTimeDomainData(pcm);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    const rms = Math.sqrt(sum / pcm.length);
    // Decibels, not the raw RMS: a linear meter on speech sits near zero and
    // the bars barely move. Same −50 dB floor the iOS meter uses
    // (ios/CCRemote/Core/SpeechDictation.swift).
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    return Math.min(1, Math.max(0, (db + 50) / 50));
  }, []);

  /** Detach the live-phrase stream and its timer; the caller decides whether
   *  to finish it (stop) or abort it (cancel, unmount). */
  const stopPhrases = useCallback((): PhraseStream | null => {
    if (phraseTimerRef.current) clearInterval(phraseTimerRef.current);
    phraseTimerRef.current = null;
    const p = phrasesRef.current;
    phrasesRef.current = null;
    return p;
  }, []);

  // On unmount, stop the mic and cancel any in-flight transcription so a live
  // stream (and its recording indicator) can't outlive the component. Detach
  // `onstop` first so tearing down the recorder doesn't kick off a stray
  // transcription. (Set true on mount too, for StrictMode remount.)
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const rec = recRef.current;
      if (rec) {
        rec.ondataavailable = null;
        rec.onstop = null;
        try {
          if (rec.state !== 'inactive') rec.stop();
        } catch {
          /* already stopped */
        }
      }
      stopPhrases()?.abort();
      finishingRef.current?.abort();
      finishingRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      dropMeter();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      // close() on an already-closed context throws InvalidStateError — guard
      // and catch, because this runs on every navigation away from a composer.
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    };
  }, [dropMeter, stopPhrases]);

  /**
   * Turn a finished recording into text and hand it over: transcribe → polish →
   * `onText`. Shared by the stop button and `retry`. `phrases` (live dictation)
   * only exists on the first pass; a retry reads the whole clip.
   *
   * When the service refuses, the clip is kept (`failedRef`) so «Повторить» can
   * run this again — the recording used to be gone with the error message.
   */
  const processClip = useCallback(
    async (blob: Blob, immediate: boolean, durSec: number, phrases: PhraseStream | null, phrasesDone: Promise<void> | null) => {
      try {
        // The phrases, when every one of them was read — they already cover
        // the clip, and only the last one is left to wait for. Anything short
        // of that (a refused phrase, nothing recognised live) reads the whole
        // clip the old way, so live text can never cost you words.
        let text = '';
        if (phrases && phrasesDone) {
          await phrasesDone;
          // `lossy`: a phrase was cut mid-speech with no pause; the live
          // text was a preview, the words come from the whole clip.
          if (!phrases.failed && !phrases.lossy) text = phrases.text;
        }
        finishingRef.current = null;
        if (!text.trim()) text = await transcribe(blob, durSec);
        text = text.trim();
        let raw: string | undefined;
        let polishFailed = false;
        const clean = polishRef.current;
        if (text && clean && aliveRef.current) {
          setPolishing(true);
          try {
            const r = await polishDictationText(text, clean, immediate);
            text = r.text;
            raw = r.raw;
            polishFailed = r.failed;
          } finally {
            if (aliveRef.current) setPolishing(false);
          }
        }
        if (aliveRef.current && text) onText(text, immediate, raw, polishFailed);
        else if (aliveRef.current && !text.trim()) onError?.('Ничего не распознал — попробуйте ещё раз.');
      } catch (err) {
        console.warn('[recorder] transcribe failed', err);
        // The recording is fine and the microphone is fine; the service that
        // turns one into the other refused. Naming that is the difference
        // between "try again" and "stop trying".
        onError?.('Распознавание речи недоступно — запись не расшифрована.');
        if (aliveRef.current) setFailed({ blob, immediate, durSec });
      }
      if (aliveRef.current) set('idle');
    },
    [transcribe, onText, onError, setFailed, set],
  );

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Unmounted while the permission prompt was up — release and bail.
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      // A track that ends — headset unplugged, the device seized by another
      // app, a phone call — does not reliably fire MediaRecorder.onstop, and
      // the composer would sit on a red button and a frozen waveform forever.
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (recRef.current?.state === 'recording') recRef.current.stop();
      });

      const ctx = ctxRef.current;
      if (ctx && ctx.state !== 'closed') {
        void ctx.resume().catch(() => {});
        try {
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          // Deliberately NOT connected to ctx.destination: that is the
          // microphone fed back into the speakers.
          src.connect(analyser);
          srcRef.current = src;
          analyserRef.current = analyser;
          pcmRef.current = new Float32Array(analyser.fftSize);
        } catch (err) {
          console.warn('[recorder] meter unavailable', err);
          dropMeter();
        }
      }

      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      cancelRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        const phrases = stopPhrases();
        const cancelled = cancelRef.current;
        // The last phrase's recorder is asked to stop BEFORE the tracks end, so
        // its final chunk is still delivered.
        const phrasesDone = cancelled ? (phrases?.abort(), null) : phrases?.finish() ?? null;
        finishingRef.current = cancelled ? null : phrases;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        dropMeter();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        // Thrown away on purpose — the one press that must not cost a
        // transcription is the accidental one.
        const immediate = sendRef.current;
        sendRef.current = false;
        const durSec = Math.max(0, (Date.now() - startedAtRef.current) / 1000);
        if (cancelRef.current || !blob.size) {
          phrases?.abort();
          finishingRef.current = null;
          cancelRef.current = false;
          if (aliveRef.current) set('idle');
          return;
        }
        if (aliveRef.current) set('transcribing');
        await processClip(blob, immediate, durSec, phrases, phrasesDone);
      };
      recRef.current = rec;
      rec.start();
      startedAtRef.current = Date.now();
      setFailed(null);
      setLive({ text: '', pending: false });
      // Live text needs the meter to find pauses; without one, dictation is
      // what it always was — one clip, read after the stop.
      if (analyserRef.current) {
        try {
          const phrases = new PhraseStream({
            // BlobEvent vs the { data } the fake in the test hands over — same shape at runtime.
            makeRecorder: () => new MediaRecorder(stream, mime ? { mimeType: mime } : undefined) as unknown as PhraseRecorder,
            getLevel,
            transcribe,
            onChange: (text, pending) => {
              if (aliveRef.current) setLive({ text, pending });
            },
          });
          phrases.start();
          phrasesRef.current = phrases;
          // An interval, not the waveform's rAF: a backgrounded window keeps
          // recording, and throttled to 1 Hz it still cuts (at worst late).
          phraseTimerRef.current = setInterval(() => phrases.tick(), 100);
        } catch (err) {
          console.warn('[recorder] live phrases unavailable', err);
          stopPhrases()?.abort();
        }
      }
      set('recording');
    } catch (err) {
      console.warn('[recorder] mic denied/unavailable', err);
      onError?.('Нет доступа к микрофону — проверьте разрешение для сайта.');
      if (aliveRef.current) set('idle');
    } finally {
      // Every way out: recording started, unmounted under the prompt, refused.
      startingRef.current = false;
    }
  }, [transcribe, onText, onError, dropMeter, set, getLevel, stopPhrases, processClip, setFailed]);

  /** Reads `stateRef`, not a state updater. React 18 StrictMode invokes an
   *  updater twice, and the old version started the microphone from inside one
   *  — two getUserMedia calls, and now two AudioContexts. */
  const toggle = useCallback(() => {
    if (stateRef.current === 'recording') {
      recRef.current?.stop(); // onstop drives the transition to transcribing/idle
      return;
    }
    if (stateRef.current === 'idle') {
      audioContext(); // inside the gesture — see the note on audioContext
      void start();
    }
  }, [start, audioContext]);

  /** Stop recording and drop the clip: no transcription, no text, no cost. */
  const cancel = useCallback(() => {
    // Idle with a clip the service refused: this is «не нужно, выбросить».
    if (stateRef.current === 'idle' && failedRef.current) {
      setFailed(null);
      return;
    }
    if (stateRef.current !== 'recording') return;
    cancelRef.current = true;
    recRef.current?.stop();
  }, [setFailed]);

  /**
   * Stop recording and SEND what comes back, without it passing through the
   * composer first.
   *
   * Dictating a message and then having to find the text, read it and press a
   * second button is two steps for one intention — and on a phone the second
   * button is the one you were already reaching for. Pressing send during a
   * recording now means what it looks like it means.
   *
   * Note the asymmetry with the microphone, which is the point: the mic still
   * stops into the composer, for when you want to look before sending.
   */
  const sendNow = useCallback(() => {
    if (stateRef.current !== 'recording') return;
    sendRef.current = true;
    recRef.current?.stop();
  }, []);

  /** Read the kept clip again after a refusal — the same path as a normal stop
   *  (transcribe → polish → `onText`), whole clip, with the send intent it had. */
  const retry = useCallback(() => {
    const f = failedRef.current;
    if (!f || stateRef.current !== 'idle') return;
    setFailed(null);
    set('transcribing');
    void processClip(f.blob, f.immediate, f.durSec, null, null);
  }, [processClip, set, setFailed]);

  return { state, polishing, toggle, cancel, sendNow, retry, canRetry, getLevel, liveText: live.text, livePending: live.pending };
}
