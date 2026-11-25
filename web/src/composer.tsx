import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ChangeEvent, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import type { FileInput, ImageInput } from '@cc-remote/shared';
import { FS_MAX_UPLOAD_BYTES, MAX_FILES_PER_MESSAGE, MAX_IMAGES_PER_MESSAGE } from '@cc-remote/shared';
import {
  fileToImageInput,
  fileToFileInput,
  attachmentToImage,
  fileSizeLabel,
  imageB64Len,
  imagesB64Len,
  MAX_FILE_BYTES,
  MAX_ATTACH_B64_TOTAL,
  newId,
  type FileAttachment,
  type ImageAttachment,
} from './lib.js';
import { LEVEL_UNAVAILABLE, type useRecorder } from './useRecorder.js';
import { Plus, MicIcon, SquareIcon, X } from './icons.js';
import { dictationVisible, POLISH_FAILED_NOTE, swapDictation, type DictationPair } from './polish.js';
import { storageGet, storageRemove, storageSet } from './storage.js';
import { showNotice } from './dialogs.js';
import { withUploadedFiles, type LargeUploader } from './chatUpload.js';

/** The hub's own `sanitize_files` bound, from the one shared source of these
 *  numbers (`shared/src/limits.ts`) — staging more would only have them
 *  dropped on the way through. */
const MAX_FILES = MAX_FILES_PER_MESSAGE;

/** Same deal for images, against the hub's `sanitize_images`. Both caps are
 *  COUNTS; what actually binds a real message is usually `MAX_ATTACH_B64_TOTAL`
 *  below, since eight screenshots reach 20MB of base64 long before they reach
 *  eight. Change them in `shared/src/limits.ts`; a hub test keeps its copy in
 *  step. */
const MAX_IMAGES = MAX_IMAGES_PER_MESSAGE;

/** A file too big to ride the message: uploaded to the machine as soon as it is
 *  picked, and named in the message by its path on disk. */
export interface LargeAttachment {
  id: string;
  name: string;
  size: number;
  sent: number;
  status: 'sending' | 'done' | 'failed';
  /** Absolute path on the machine, once uploaded. */
  path?: string;
  error?: string;
  /** Kept so «Повторить» does not make the person find the file again. */
  file: File;
  /** The machine + folder it went to; a send aimed elsewhere is refused. */
  target: string;
}

/** Staged attachments shared by the chat + start-screen composers: pick, paste
 *  or drop them, preview them, clear them, and turn them into the wire
 *  `ImageInput[]` / `FileInput[]`. With a `uploader`, a file past the inline
 *  limits is uploaded to the machine instead of refused. */
export function useImageAttachment(getUploader?: () => LargeUploader | undefined) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [large, setLarge] = useState<LargeAttachment[]>([]);
  // Asked when a file arrives or is sent, not on render: the screen that owns
  // the picker may only learn its machine and folder further down.
  const uploaderRef = useRef(getUploader);
  uploaderRef.current = getUploader;
  /** One controller per upload in flight, so ✕ and a send can stop it. */
  const uploadCtl = useRef(new Map<string, AbortController>());
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Mirror of what is staged, readable synchronously inside `accept`. It awaits
   *  between files, so React state is a batch behind while a drop is landing. */
  const stagedRef = useRef<{ images: ImageAttachment[]; files: FileAttachment[]; large: LargeAttachment[] }>({
    images: [],
    files: [],
    large: [],
  });
  useEffect(() => {
    stagedRef.current = { images, files, large };
  }, [images, files, large]);
  /** Bumped every time the composer is emptied by a send. A file read that
   *  started before the bump belongs to the message that already left. */
  const epochRef = useRef(0);

  const runLarge = useCallback((chip: LargeAttachment) => {
    const up = uploaderRef.current?.();
    const patch = (p: Partial<LargeAttachment>) =>
      setLarge((prev) => prev.map((c) => (c.id === chip.id ? { ...c, ...p } : c)));
    if (!up) {
      patch({ status: 'failed', error: 'Загрузка здесь недоступна' });
      return;
    }
    const ctl = new AbortController();
    uploadCtl.current.set(chip.id, ctl);
    patch({ status: 'sending', sent: 0, error: undefined, target: up.target });
    up.upload(chip.file, { signal: ctl.signal, onProgress: (sent) => patch({ sent }) })
      .then((path) => patch({ status: 'done', path, sent: chip.size }))
      .catch((err: unknown) => {
        // Removed or cleared: nobody is waiting for the answer any more.
        if (!ctl.signal.aborted) patch({ status: 'failed', error: (err as Error).message });
      })
      .finally(() => uploadCtl.current.delete(chip.id));
  }, []);
  const startLarge = useCallback(
    (picked: File[]) => {
      const chips: LargeAttachment[] = picked.map((file) => ({
        id: newId('big-'),
        name: file.name || 'файл',
        size: file.size,
        sent: 0,
        status: 'sending',
        file,
        target: uploaderRef.current?.()?.target ?? '',
      }));
      setLarge((prev) => [...prev, ...chips]);
      for (const chip of chips) runLarge(chip);
    },
    [runLarge],
  );
  const stopAllLarge = useCallback(() => {
    for (const ctl of uploadCtl.current.values()) ctl.abort();
    uploadCtl.current.clear();
  }, []);
  // Leaving the screen ends what is still travelling.
  useEffect(() => stopAllLarge, [stopAllLarge]);

  /**
   * Take whatever was picked, pasted or dropped.
   *
   * One funnel for all three, because they hand over the same `File` objects and
   * the only interesting decision is per-file: an image is inlined into the
   * prompt, and anything else joins the file list to be written to the machine.
   * Nothing is rejected for being the wrong KIND — a file the model cannot read
   * is still a file the person meant to send, and the agent writes it to disk
   * either way.
   *
   * Both kinds ACCUMULATE. Images used to have a single slot, so dropping three
   * screenshots at once staged the third and silently ate the other two — the
   * reason this takes a `File[]` at all is that people drop sets, not items.
   */
  const accept = useCallback(async (incoming: File[]): Promise<void> => {
    // Which composer this batch belongs to. Reading a dropped file is async,
    // and a send during that read clears the picker — the batch then landed in
    // the EMPTIED one: the message it was dropped with went out without those
    // files, and they turned up attached to the next one. `clearAll` bumps the
    // epoch; a batch from a previous one is discarded rather than committed.
    const epoch = epochRef.current;
    const tooBig: string[] = [];
    const tooHuge: string[] = [];
    const noRoom: string[] = [];
    const tooMany: string[] = [];
    // What is already staged, plus what this batch has added so far. `staged`
    // cannot be read from state here: `accept` awaits between files, so the
    // updates from earlier items in the same drop have not flushed yet.
    // A pasted screenshot arrives with an empty name, so a complaint listing it
    // verbatim would name nothing at all.
    const label = (f: File) => f.name || 'изображение из буфера';
    const staged = stagedRef.current;
    let used = imagesB64Len(staged.images);
    for (const a of staged.files) used += a.data.length;
    let imageCount = staged.images.length;
    // The upload path shares the per-message file cap with inline files.
    let fileCount = staged.files.length + staged.large.length;
    const addedImages: ImageAttachment[] = [];
    const addedFiles: FileAttachment[] = [];
    const addedLarge: File[] = [];
    // Past the inline limits a file goes up to the machine, when this composer
    // knows which one; otherwise it is refused as before.
    const goLarge = (f: File, fallback: string[]): void => {
      if (!uploaderRef.current?.()) fallback.push(label(f));
      else if (f.size > FS_MAX_UPLOAD_BYTES) tooHuge.push(label(f));
      else if (fileCount >= MAX_FILES) tooMany.push(label(f));
      else {
        fileCount++;
        addedLarge.push(f);
      }
    };
    for (const f of incoming) {
      const img = await fileToImageInput(f);
      if (img) {
        if (imageCount >= MAX_IMAGES) {
          tooMany.push(label(f));
          continue;
        }
        const len = imageB64Len(img);
        if (used + len > MAX_ATTACH_B64_TOTAL) {
          goLarge(f, noRoom);
          continue;
        }
        used += len;
        imageCount++;
        addedImages.push(img);
        continue;
      }
      // Not inlineable — either not an image at all, or an image past
      // MAX_INLINE_IMAGE_BYTES, which rides along as an ordinary file instead of
      // being dropped by the hub in flight.
      const att = await fileToFileInput(f);
      if (!att) {
        goLarge(f, tooBig);
        continue;
      }
      if (fileCount >= MAX_FILES) {
        tooMany.push(label(f));
        continue;
      }
      if (used + att.data.length > MAX_ATTACH_B64_TOTAL) {
        // Counted already as an inline file; it goes up instead.
        goLarge(f, noRoom);
        continue;
      }
      used += att.data.length;
      fileCount++;
      addedFiles.push(att);
    }
    // The message these belong to has already been sent — they are not this
    // composer's attachments any more. Say so rather than staging them for
    // whatever gets typed next.
    if (epoch !== epochRef.current) return;
    // Committed once per batch, and functionally: a chip removed WHILE a big
    // drop was still being read must stay removed, not come back with the batch.
    if (addedImages.length) setImages((prev) => [...prev, ...addedImages].slice(0, MAX_IMAGES));
    if (addedFiles.length) setFiles((prev) => [...prev, ...addedFiles].slice(0, MAX_FILES));
    if (addedLarge.length) startLarge(addedLarge);
    const problems: string[] = [];
    if (tooBig.length) {
      problems.push(`Слишком большой файл (предел ${fileSizeLabel(MAX_FILE_BYTES)}): ${tooBig.join(', ')}`);
    }
    if (tooHuge.length) {
      problems.push(`Слишком большой файл (предел 100 МБ): ${tooHuge.join(', ')}`);
    }
    if (tooMany.length) {
      problems.push(
        `Больше ${MAX_IMAGES} картинок и ${MAX_FILES} файлов в одно сообщение не влезает, эти остались снаружи: ${tooMany.join(', ')}`,
      );
    }
    if (noRoom.length) {
      problems.push(
        `Не помещается в одно сообщение (всего не больше ${fileSizeLabel(MAX_ATTACH_B64_TOTAL)} вложений): ${noRoom.join(', ')}`,
      );
    }
    // One dialog for the whole drop: thirty files must not mean thirty alerts.
    if (problems.length) void showNotice(problems.join('\n\n'));
  }, [startLarge]);

  const onFileInput = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const picked = [...(e.target.files ?? [])];
      e.target.value = '';
      await accept(picked);
    },
    [accept],
  );

  /** Cmd/Ctrl+V. The clipboard's `files` covers a copied file AND a screenshot,
   *  which arrives as an image/* item with an empty name. */
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      const picked = [...(e.clipboardData?.files ?? [])];
      if (!picked.length) return; // plain text paste — let the textarea have it
      e.preventDefault();
      void accept(picked);
    },
    [accept],
  );

  /** Drag-and-drop onto the composer. `dragging` drives the drop affordance;
   *  without preventDefault on dragover the browser navigates away to the file
   *  instead, which loses whatever was typed. */
  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  }, []);
  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    // Fires when crossing into a CHILD element too; ignore those or the hint
    // flickers on every internal boundary.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      const picked = [...(e.dataTransfer?.files ?? [])];
      if (!picked.length) return;
      e.preventDefault();
      setDragging(false);
      void accept(picked);
    },
    [accept],
  );

  const clearAll = useCallback(() => {
    // Everything staged left with the message. Anything still being read is no
    // longer ours — see the epoch note in `accept`.
    epochRef.current += 1;
    stopAllLarge();
    setImages([]);
    setFiles([]);
    setLarge([]);
  }, [stopAllLarge]);
  /** Put back what a send took when the send never left (sealing failed). */
  const restore = useCallback((imgs: ImageAttachment[], fls: FileAttachment[], lrg: LargeAttachment[] = []) => {
    setImages((prev) => (prev.length ? prev : imgs));
    setFiles((prev) => (prev.length ? prev : fls));
    setLarge((prev) => (prev.length ? prev : lrg));
  }, []);
  const removeLarge = useCallback((id: string) => {
    uploadCtl.current.get(id)?.abort();
    uploadCtl.current.delete(id);
    setLarge((prev) => prev.filter((c) => c.id !== id));
  }, []);
  const retryLarge = useCallback(
    (id: string) => {
      const chip = stagedRef.current.large.find((c) => c.id === id);
      if (chip && chip.status === 'failed') runLarge(chip);
    },
    [runLarge],
  );
  /** Why a send must wait or be redone, or null when the big files are ready. */
  const largeBlock = useCallback((): string | null => {
    if (large.some((c) => c.status === 'sending')) return 'Файл ещё загружается';
    if (large.some((c) => c.status === 'failed')) {
      return 'Файл не загрузился: повторите или уберите его из сообщения';
    }
    const here = uploaderRef.current?.()?.target ?? '';
    if (large.some((c) => c.target !== here)) {
      return 'Файл загружен на другую машину, прикрепите заново';
    }
    return null;
  }, [large]);
  /** The text with the uploaded files' paths appended, as it goes on the wire. */
  const withLargeFiles = useCallback(
    (text: string) => withUploadedFiles(text, large.flatMap((c) => (c.path ? [c.path] : []))),
    [large],
  );
  const removeImage = useCallback(
    (index: number) => setImages((prev) => prev.filter((_, i) => i !== index)),
    [],
  );
  const removeFile = useCallback(
    (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index)),
    [],
  );
  /** Put previously-staged attachments back, for a send the hub refused. */
  const restoreImages = useCallback((atts: ImageAttachment[]) => setImages(atts), []);
  const restoreFiles = useCallback((atts: FileAttachment[]) => setFiles(atts), []);
  const open = useCallback(() => fileRef.current?.click(), []);
  const toImages = useCallback(
    (): ImageInput[] | undefined => (images.length ? images.map(attachmentToImage) : undefined),
    [images],
  );
  const toFiles = useCallback(
    (): FileInput[] | undefined =>
      files.length
        ? files.map((f) => ({ name: f.name, data: f.data, ...(f.media_type ? { media_type: f.media_type } : {}) }))
        : undefined,
    [files],
  );

  return {
    images,
    files,
    large,
    /** Anything at all staged — the one question every send path asks. */
    hasAttachments: images.length > 0 || files.length > 0 || large.length > 0,
    dragging,
    fileRef,
    onFileInput,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    clearAll,
    restore,
    removeImage,
    removeFile,
    removeLarge,
    retryLarge,
    largeBlock,
    withLargeFiles,
    restoreImages,
    restoreFiles,
    open,
    toImages,
    toFiles,
  };
}

export type ImagePicker = ReturnType<typeof useImageAttachment>;

/** Grow a textarea to fit its content up to `max` px, then it scrolls. */
/**
 * Half-typed messages survive leaving the session.
 *
 * The draft lived only inside the mounted Chat, so opening another bottom tab,
 * pressing back, or switching sessions destroyed it — and on a phone the tab bar
 * makes that a one-tap accident. Returning gave you an empty composer with no
 * hint anything had been there. The iOS composer has persisted per session all
 * along (`DraftStore`, keyed `machineId::sessionId`); this is the same store
 * with the same key.
 *
 * Text only, as on iOS: a staged image is base64 in memory and would blow the
 * localStorage quota on the first screenshot.
 */
const DRAFT_PREFIX = 'cc-draft:';

export const DraftStore = {
  load(key: string): string {
    return storageGet(DRAFT_PREFIX + key) ?? '';
  },
  save(key: string, text: string) {
    // Private mode, or the quota is full: the helpers swallow it. A dropped
    // draft is not worth throwing out of a keystroke handler.
    if (text) storageSet(DRAFT_PREFIX + key, text);
    else storageRemove(DRAFT_PREFIX + key);
  },
};

/**
 * Publish the composer's real height as `--composer-h` on the pane around it.
 *
 * The «вниз к новому» pill floats above the composer at a FIXED 92px, which was
 * true for a one-line box and wrong for every other size — the composer grows
 * to 40vh, and past about three lines the pill ends up sitting inside it. That
 * became easy to hit the moment Enter started inserting newlines on a phone
 * instead of sending.
 *
 * Measured rather than guessed, because the height depends on the staged
 * attachments and the autogrow textarea, and neither is knowable from CSS. The
 * variable is set on the PARENT (`.chat`), which is the positioned ancestor the
 * pill is absolute within, so the pill can just read it.
 *
 * Returns the ref to put on the composer element. Where there is no composer at
 * all — a read-only pane — the variable is simply never set and the `0px`
 * fallback in the rule leaves the pill at the bottom edge, which is correct.
 */
export function useComposerHeight(): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const pane = el?.parentElement;
    if (!el || !pane) return;
    const apply = () => pane.style.setProperty('--composer-h', `${Math.round(el.offsetHeight)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      pane.style.removeProperty('--composer-h');
    };
  }, []);
  return ref;
}

/**
 * What a bare Enter means in a MULTI-LINE composer.
 *
 * On a phone it means newline, and send is the button. A soft keyboard has no
 * Shift+Enter — the shift key there is a caps latch for the next letter and
 * never arrives as a keydown modifier — so "Enter sends" left no way whatsoever
 * to type a second line: every paragraph break fired off a half-written
 * message. On a desktop keyboard Shift+Enter exists, so Enter keeps sending.
 * This is the same split ChatGPT uses.
 *
 * Returns true when the caller should send. Call it from `onKeyDown` and do
 * nothing when it returns false — the textarea then inserts the newline itself.
 *
 * Only for composers that are allowed to hold more than one line. A single-line
 * input (a URL box, a search field) has no newline to want and should keep
 * submitting on Enter — see `TakeYourCode`.
 *
 * The media query is asked per keystroke rather than cached in state: it costs
 * nothing at typing speed and is automatically right after a rotation, a resize
 * or a desktop browser's device-mode toggle, none of which a mounted-once
 * boolean would notice.
 */
export function enterShouldSend(e: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  nativeEvent: { isComposing: boolean };
}): boolean {
  // IME first: Enter confirming a CJK candidate is not aimed at the composer.
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return false;
  // The one binding that never changes meaning, on any device.
  if (e.metaKey || e.ctrlKey) return true;
  if (e.shiftKey) return false; // newline, everywhere
  const phone =
    typeof matchMedia === 'function' &&
    matchMedia('(max-width: 860px), (pointer: coarse)').matches;
  return !phone;
}

/**
 * Grow a textarea to fit its content, up to `maxRatio` of the viewport.
 *
 * The measuring trick — set `height: auto`, read `scrollHeight`, set the height
 * back — has a bite that only shows past the cap: at `auto` the box fits its
 * content, so there is no overflow and the browser **clamps `scrollTop` to 0**.
 * Restoring the capped height then leaves the view pinned to the top while the
 * caret is somewhere below it: you keep typing and your text is gone. Hence the
 * save/restore, and the nudge to the bottom when the caret IS at the end.
 *
 * The cap is a ratio, not a number of pixels, because the same 200px that was
 * roomy in a pane is nine lines on a 15" screen. `.composer textarea` carries
 * the same ratio as a CSS `max-height`; the CSS one is what actually clips, so
 * the two must agree.
 */
export function useAutoGrowTextarea(value: string, maxRatio: number): RefObject<HTMLTextAreaElement> {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const max = Math.max(120, Math.round(window.innerHeight * maxRatio));
      const keep = el.scrollTop;
      el.style.height = 'auto';
      el.style.height = `${Math.min(max, el.scrollHeight)}px`;
      // Typing at the end is the common case and wants the bottom; anywhere
      // else, put the view back exactly where the browser had just placed it.
      el.scrollTop = el.selectionStart === el.value.length ? el.scrollHeight : keep;
    };
    fit();
    // A window resize changes the cap; without this the box keeps a height the
    // new viewport no longer justifies until the next keystroke.
    window.addEventListener('resize', fit);
    // A pane is resized on its own — dragging the handle between columns,
    // opening a fourth — while the window stays put, so the field kept the
    // height of its old width (27.09.2026). Refit on the field's WIDTH only:
    // its height is what `fit` sets, and reacting to that would loop.
    let width = el.clientWidth;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', fit);
      ro?.disconnect();
    };
  }, [value, maxRatio]);
  return ref;
}

/** The staged-attachment chips (nothing when nothing is staged). */
export function AttachPreview({ picker }: { picker: ImagePicker }) {
  if (!picker.hasAttachments) return null;
  return (
    <div className="attach-row">
      {/* One chip per image, each with its own ✕. A single «clear the slot»
          button was honest when there was one slot; with eight it has to be
          possible to drop the wrong screenshot without losing the right ones. */}
      {picker.images.map((img, i) => (
        <div className="attach-chip" key={`${img.name}-${i}`}>
          <img src={img.dataUrl} alt="" />
          <span className="attach-name">{img.name}</span>
          <button
            className="attach-x"
            onClick={() => picker.removeImage(i)}
            aria-label={`Убрать ${img.name || 'картинку'}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {/* A non-image attachment has nothing to preview, so the chip says what it
          is instead: name plus size, which is what tells you at a glance whether
          you grabbed the right file. */}
      {picker.files.map((f, i) => (
        <div className="attach-chip file" key={`${f.name}-${i}`}>
          <span className="attach-name">{f.name}</span>
          <span className="attach-size">{fileSizeLabel(f.size)}</span>
          <button
            className="attach-x"
            onClick={() => picker.removeFile(i)}
            aria-label={`Убрать ${f.name}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {/* Past the inline limit the file is already travelling to the machine:
          the size slot shows how far, and a failure can be repeated. */}
      {picker.large.map((f) => (
        <div className={`attach-chip file${f.status === 'failed' ? ' failed' : ''}`} key={f.id} title={f.error}>
          <span className="attach-name">{f.name}</span>
          <span className="attach-size">
            {f.status === 'sending'
              ? `${Math.min(99, Math.floor((f.sent / Math.max(1, f.size)) * 100))}%`
              : f.status === 'failed'
                ? 'ошибка'
                : fileSizeLabel(f.size)}
          </span>
          {f.status === 'failed' && (
            <button className="attach-retry" onClick={() => picker.retryLarge(f.id)}>
              Повторить
            </button>
          )}
          <button
            className="attach-x"
            onClick={() => picker.removeLarge(f.id)}
            aria-label={`Убрать ${f.name}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The `+` attach button plus its hidden file input. */
export function AttachButton({ picker }: { picker: ImagePicker }) {
  return (
    <>
      <button
        className="round-btn attach"
        onClick={picker.open}
        title="Прикрепить файл"
        aria-label="Прикрепить файл"
      >
        <Plus size={20} weight="bold" />
      </button>
      {/* No `accept` filter: images are inlined, everything else is written to
          the machine and read from there, so there is nothing to exclude. */}
      <input ref={picker.fileRef} type="file" multiple hidden onChange={picker.onFileInput} />
    </>
  );
}

/** Mic toggle that reflects the recorder state — dictation, via AZURE_TRANSCRIBE_*.
 *  (Realtime voice CALLS were removed: the Azure realtime key had been dead since
 *  2026-07-27 and the feature was carrying a WebRTC client and a hub relay for a
 *  button nobody could use. Dictation is a different credential and stays.) */
export function VoiceButton({ recorder }: { recorder: ReturnType<typeof useRecorder> }) {
  const { state, toggle } = recorder;
  const recording = state === 'recording';
  return (
    <button
      className={`round-btn mic ${recording ? 'rec' : ''}`}
      onClick={toggle}
      disabled={state === 'transcribing'}
      title={recording ? 'Остановить запись' : state === 'transcribing' ? 'Распознаю…' : 'Голосовой ввод'}
      aria-label={recording ? 'Остановить запись' : 'Голосовой ввод'}
    >
      {/* The same square this product already stops a turn with
          (`send-round stop` in Chat.tsx) — one glyph for «stop», and it matches
          the mic→stop swap on iOS. A mic that stays a mic while recording is
          half of why nobody could tell the thing was live. */}
      {recording ? <SquareIcon size={13} weight="fill" /> : <MicIcon size={21} />}
    </button>
  );
}

/** How many bars the meter draws — the iOS waveform's count
 *  (`SpeechDictation.barCount`), so the two clients read as one design. */
const WAVE_BARS = 28;
/** ~20 Hz. Faster is invisible on 3px bars and costs battery; slower reads as
 *  lag between your voice and the picture. Same rate as the iOS meter. */
const WAVE_MS = 50;
/** One bar plus its gap. The meter fills whatever the strip is wide: it was a
 *  fixed 28 bars (140px), which in the desk and Windows composer read as a
 *  stub in the corner of a wide box. Now the count follows the width. */
const WAVE_PITCH = 5;
const WAVE_MAX_BARS = 200;

/**
 * The live microphone, drawn. Bars are scaled straight in the DOM from a rAF
 * loop — never through React — because the recorder hook lives in the body of
 * the component that renders the entire transcript, and a level in state would
 * be 20 reconciliations of the log per second.
 *
 * DOM spans and not canvas: colour, radius and the dark theme stay in the
 * stylesheet. On canvas they would have to be read out of `getComputedStyle`
 * and re-read on every theme flip.
 */
export function VoiceWave({ getLevel, busy }: { getLevel: () => number; busy: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  // `busy` (transcribing) and «no meter available» are both driven by CSS, so
  // the loop only runs while there is a real microphone to draw.
  const [mute, setMute] = useState(false);
  const [count, setCount] = useState(WAVE_BARS);
  const driven = busy || mute;
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.clientWidth;
      if (!w) return;
      setCount(Math.max(WAVE_BARS, Math.min(WAVE_MAX_BARS, Math.floor(w / WAVE_PITCH))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = host.current;
    if (!el || driven) return;
    // The global reduced-motion rule sets iteration-count 1, which would leave
    // the CSS wave frozen flat — so that case hides the bars entirely and the
    // words carry the state. No point sampling for something that is display:none.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const bars = Array.from(el.querySelectorAll<HTMLElement>('i'));
    const hist = new Array<number>(bars.length).fill(0);
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < WAVE_MS) return;
      last = t;
      const level = getLevel();
      if (level === LEVEL_UNAVAILABLE) {
        // No analyser — a flat line at the floor reads as a broken meter, so
        // fall back to the same CSS wave the transcribing state uses.
        setMute(true);
        return;
      }
      hist.shift();
      hist.push(level);
      for (let i = 0; i < bars.length; i++) {
        bars[i]!.style.transform = `scaleY(${Math.max(0.12, hist[i]!).toFixed(3)})`;
      }
    };
    // rAF and not setInterval: a backgrounded tab stops it dead, and the
    // recording quite legitimately continues there.
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const b of bars) b.style.transform = '';
    };
  }, [getLevel, driven, count]);
  return (
    <div className={`vwave ${driven ? 'busy' : ''}`} ref={host} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ ['--i' as string]: i % WAVE_BARS } as CSSProperties} />
      ))}
    </div>
  );
}

/** Seconds since mount, frozen when `running` goes false. Its own component so
 *  the once-a-second tick doesn't re-render the panel around it — same reason,
 *  same format and same class as the old turn clock (now `SessionWorkCard`). */
function RecClock({ running }: { running: boolean }) {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const secs = Math.max(0, Math.round((now - since) / 1000));
  const clock =
    secs < 60 ? `${secs}с` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return <span className="work-clock">{clock}</span>;
}

/**
 * What the composer shows while it is listening, and while the machine reads
 * back what it heard. Nothing at rest.
 *
 * The clock runs during the recording and then STOPS at the clip's length:
 * «Распознаю… 0:14» says honestly «your fourteen seconds are being read». A
 * second counter of how long recognition has been taking would just be a
 * stopwatch on anxiety; the moving bars are what carry liveness there.
 */
export function DictationStrip({ recorder }: { recorder: ReturnType<typeof useRecorder> }) {
  const { state, polishing, cancel, getLevel, liveText, livePending, canRetry, retry } = recorder;
  // The service refused the clip, which is kept: say so here, where it stays,
  // not only in the toast that goes after a few seconds.
  if (state === 'idle' && canRetry) {
    return (
      <div className="dict-strip" role="alert">
        <span className="dict-note">Запись не расшифрована</span>
        <button type="button" className="dict-retry" onClick={retry}>
          Повторить
        </button>
        <button className="dict-x" onClick={cancel} title="Выбросить запись" aria-label="Выбросить запись">
          <X size={12} />
        </button>
      </div>
    );
  }
  if (state === 'idle') return null;
  const busy = state === 'transcribing';
  return (
    <div className="dict-strip" role="status" aria-live="polite">
      <RecClock running={!busy} />
      <span className="dict-label">{polishing ? 'Вычитываю…' : busy ? 'Распознаю…' : 'Запись'}</span>
      <VoiceWave getLevel={getLevel} busy={busy} />
      {/* Until this existed every stop paid for a transcription, including the
          accidental ones — there was no way to abandon a recording at all. */}
      {!busy && (
        <button className="dict-x" onClick={cancel} title="Отменить запись" aria-label="Отменить запись">
          <X size={12} />
        </button>
      )}
      {/* What has been heard so far, phrase by phrase — see phrases.ts. The
          trailing «…» is a phrase still being read. */}
      {(liveText || livePending) && (
        <div className="dict-live">
          {liveText}
          {livePending && <span className="dict-live-pending">{liveText ? ' …' : '…'}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The «как сказал» switch under a dictation that `/polish` rewrote.
 *
 * The rewrite fixes misheard terms and punctuation, but it is a model's reading
 * of what you meant, and the one thing it must not do is leave you unable to
 * see what you actually said. So the composer remembers both spellings of the
 * last dictation and swaps one for the other in place. The switch lives only
 * while that text is still in the box: edit it or send it and it is gone.
 */
export function useDictationSwitch(draft: string, setDraft: (d: string) => void) {
  const [pair, setPair] = useState<DictationPair | null>(null);
  /** The dictation `/polish` was asked about and did not deliver — the text in
   *  the box is exactly what was recognised. Goes when that text does. */
  const [failedText, setFailedText] = useState<string | null>(null);
  const visible = dictationVisible(draft, pair);
  const failedVisible = !!failedText && draft.includes(failedText);
  useEffect(() => {
    if (pair && !visible) setPair(null);
  }, [pair, visible]);
  useEffect(() => {
    if (failedText && !failedVisible) setFailedText(null);
  }, [failedText, failedVisible]);
  const remember = useCallback((raw: string, polished: string) => {
    setFailedText(null);
    setPair({ raw, polished, showing: 'polished' });
  }, []);
  const rememberFailure = useCallback((text: string) => {
    setPair(null);
    setFailedText(text);
  }, []);
  const toggle = useCallback(() => {
    if (!pair) return;
    const next = swapDictation(draft, pair);
    if (!next) {
      setPair(null);
      return;
    }
    setDraft(next.draft);
    setPair(next.pair);
  }, [draft, pair, setDraft]);
  /** A dictation that came back unpolished: the caption must not stay over
   *  the box claiming «вычитано» about an older one. */
  const forget = useCallback(() => {
    setPair(null);
    setFailedText(null);
  }, []);
  return { pair: visible ? pair : null, failed: failedVisible, remember, rememberFailure, forget, toggle };
}

export function DictationSwitch({ sw }: { sw: ReturnType<typeof useDictationSwitch> }) {
  if (!sw.pair && sw.failed) {
    return (
      <div className="dict-switch">
        <span className="eyebrow">{POLISH_FAILED_NOTE}</span>
      </div>
    );
  }
  if (!sw.pair) return null;
  const polished = sw.pair.showing === 'polished';
  return (
    <div className="dict-switch">
      <span className="eyebrow">{polished ? 'вычитано' : 'как сказал'}</span>
      <button
        type="button"
        className="caption-toggle"
        onClick={sw.toggle}
        title={polished ? 'Вернуть текст ровно как его распознали' : 'Вернуть вычитанный текст'}
      >
        {polished ? 'как сказал' : 'вычитать'}
      </button>
    </div>
  );
}
