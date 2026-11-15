/**
 * Live dictation: the recording cut into phrases, each phrase transcribed once,
 * while you are still talking.
 *
 * Why phrases and not "re-send the whole clip every few seconds": recognition
 * runs on ONE GPU (buildbox-pc, whisper large-v3, ×6–8 real time) with one
 * queue shared by the whole fleet and the meeting pipeline. Re-sending a
 * growing clip is quadratic — a minute of speech would cost fifteen ever-longer
 * jobs. A phrase costs its own length, once, and the sum is the same audio the
 * old single post paid for.
 *
 * Why cut on a pause: whisper needs whole words. The microphone's level (the
 * same analyser the waveform draws) says when you stopped for breath; a cut
 * there loses nothing. Someone who never pauses still gets a forced cut, and
 * the next recorder is started BEFORE the old one stops, so the seam overlaps
 * by a few milliseconds instead of dropping them.
 *
 * Every phrase is its own recorder, so every phrase is a complete, decodable
 * file — a slice of one long webm stream is not (only the first slice carries
 * the header).
 */

/** Silence this long after speech ends the phrase. */
export const PHRASE_SILENCE_MS = 600;
/** …but not before the phrase is this long — two-word posts are mostly noise. */
export const PHRASE_MIN_MS = 2500;
/** No pause at all: cut anyway, so the text never lags more than this. */
export const PHRASE_MAX_MS = 10_000;
/** Level (0…1 over −50…0 dB) that counts as speech for finding pauses. */
export const VOICE_LEVEL = 0.35;
/** Below this peak (−40 dB) a phrase is room noise and is not sent at all —
 *  whisper on silence invents «Продолжение следует…». Deliberately far under
 *  VOICE_LEVEL: dropping a quiet phrase would lose words from the final text. */
export const NOISE_PEAK = 0.2;
const RETRY_MS = 1500;
const RETRIES = 6;

/** What whisper writes over silence and breath — subtitle credits from its
 *  training data. A phrase that is ONLY this is dropped. */
const HALLUCINATIONS = [
  /^продолжение следует\.*$/i,
  /^субтитры (сделал|создавал|делал)/i,
  /^редактор субтитров/i,
  /^спасибо за просмотр!?\.*$/i,
  /^корректор/i,
];

export function cleanPhrase(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return HALLUCINATIONS.some((re) => re.test(t)) ? '' : t;
}

/** The subset of MediaRecorder this uses — so a test can hand in a fake. */
export interface PhraseRecorder {
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface PhraseStreamOptions {
  makeRecorder: () => PhraseRecorder;
  /** 0…1, or negative when there is no meter (then no phrase is ever cut). */
  getLevel: () => number;
  /** `durSec`: the phrase's length in seconds (wall clock between its recorder's start and stop). */
  transcribe: (blob: Blob, durSec?: number) => Promise<string>;
  /** The recognised text so far, and whether a phrase is still being read. */
  onChange: (text: string, pending: boolean) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Segment {
  rec: PhraseRecorder;
  chunks: Blob[];
  at: number;
  voiceAt: number;
  voiced: boolean;
  peak: number;
  /** Ticks that looked at this segment. Too few and `peak` says nothing — a
   *  tail shorter than one tick, or a backgrounded window ticking at 1 Hz. */
  samples: number;
  /** When `stopSeg` asked the recorder to stop; the phrase's length is `endAt - at`. */
  endAt?: number;
  /** Flushed already. `onstop` and a throwing `stop()` can both get here. */
  done: boolean;
}

export class PhraseStream {
  private seg: Segment | null = null;
  private queue: { blob: Blob; durSec: number }[] = [];
  private running = false;
  /** Recorders told to stop whose `onstop` has not fired yet. */
  private stopping = 0;
  private closed = false;
  private aborted = false;
  private parts: string[] = [];
  private waiters: (() => void)[] = [];
  /** A phrase the service refused — the caller falls back to the whole clip. */
  failed = false;
  /** A phrase was cut with no pause — possibly mid-word. The phrases are fine
   *  to SHOW, but the final text then comes from the whole clip. */
  lossy = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: PhraseStreamOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get text(): string {
    return this.parts.join(' ');
  }

  start(): void {
    this.open();
  }

  /** Called on a timer (every ~100 ms) by the owner; decides where a phrase ends. */
  tick(): void {
    const seg = this.seg;
    if (!seg || this.closed) return;
    const level = this.o.getLevel();
    if (level < 0) return;
    const now = this.now();
    if (level > seg.peak) seg.peak = level;
    seg.samples++;
    if (level >= VOICE_LEVEL) {
      seg.voiceAt = now;
      seg.voiced = true;
    }
    const age = now - seg.at;
    const paused = seg.voiced && age >= PHRASE_MIN_MS && now - seg.voiceAt >= PHRASE_SILENCE_MS;
    if (paused) this.cut();
    else if (age >= PHRASE_MAX_MS) {
      // Silence cut on the clock splits no word.
      if (seg.voiced) this.lossy = true;
      this.cut();
    }
  }

  /** Recording is over: flush the last phrase. Resolves once every phrase has
   *  been read (or failed). */
  finish(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      const seg = this.seg;
      this.seg = null;
      if (seg) this.stopSeg(seg);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.settle();
    });
  }

  /** Throw everything away — cancel, unmount. No further transcriptions. */
  abort(): void {
    this.aborted = true;
    this.closed = true;
    this.queue = [];
    const seg = this.seg;
    this.seg = null;
    if (seg) {
      seg.rec.ondataavailable = null;
      seg.rec.onstop = null;
      try {
        seg.rec.stop();
      } catch {
        /* already inactive */
      }
    }
    const w = this.waiters.splice(0);
    for (const f of w) f();
  }

  private open(): void {
    const rec = this.o.makeRecorder();
    const seg: Segment = { rec, chunks: [], at: this.now(), voiceAt: 0, voiced: false, peak: 0, samples: 0, done: false };
    rec.ondataavailable = (e) => {
      if (e.data.size) seg.chunks.push(e.data);
    };
    rec.onstop = () => {
      // Stopped by us (cut/finish counted it in `stopping`), or on its own — a
      // track that ended (headset out, a call). The latter is still the
      // current segment: detach it, so nothing cuts or stops it again.
      if (this.seg === seg) {
        this.seg = null;
        this.closed = true;
      } else this.stopping--;
      this.flush(seg);
    };
    rec.start();
    this.seg = seg;
  }

  private cut(): void {
    const old = this.seg;
    // New recorder first: the seam overlaps instead of dropping audio.
    try {
      this.open();
    } catch {
      // The stream is gone (ended track): stop cutting; finish() reads the rest.
      this.seg = old;
      this.closed = true;
      return;
    }
    if (old) this.stopSeg(old);
  }

  private stopSeg(seg: Segment): void {
    seg.endAt = this.now();
    this.stopping++;
    try {
      seg.rec.stop();
    } catch {
      this.stopping--;
      this.flush(seg);
    }
  }

  private flush(seg: Segment): void {
    if (seg.done) return this.settle();
    seg.done = true;
    // Only a segment that was actually LISTENED to can be judged silent.
    const judged = seg.samples >= 5;
    if (!this.aborted && seg.chunks.length && (!judged || seg.peak >= NOISE_PEAK)) {
      const durSec = Math.max(0, ((seg.endAt ?? this.now()) - seg.at) / 1000);
      this.queue.push({ blob: new Blob(seg.chunks, { type: seg.rec.mimeType || 'audio/webm' }), durSec });
      void this.pump();
    }
    this.settle();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit();
    while (this.queue.length && !this.aborted) {
      const { blob, durSec } = this.queue.shift()!;
      const text = await this.read(blob, durSec);
      if (this.aborted) break;
      if (text === null) this.failed = true;
      else if (text) this.parts.push(text);
      this.emit();
    }
    this.running = false;
    this.emit();
    this.settle();
  }

  /** One phrase, sequentially — the hub's transcription semaphore is three
   *  slots for EVERYONE, so one person dictating holds at most one. A 429 is
   *  "someone else is in the queue", worth waiting for; anything else is not. */
  private async read(blob: Blob, durSec: number): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return cleanPhrase(await this.o.transcribe(blob, durSec));
      } catch (err) {
        const busy = /\(429\)/.test(String((err as Error)?.message ?? err));
        if (!busy || attempt >= RETRIES || this.aborted) return null;
        await this.sleep(RETRY_MS);
      }
    }
  }

  private emit(): void {
    if (this.aborted) return;
    this.o.onChange(this.text, this.running || this.queue.length > 0 || this.stopping > 0);
  }

  private settle(): void {
    if (!this.closed) return;
    if (this.stopping > 0 || this.running || this.queue.length > 0) return;
    const w = this.waiters.splice(0);
    for (const f of w) f();
  }
}
