import { useRef, type Dispatch, type SetStateAction } from 'react';
import { useDictationSwitch } from './composer.js';
import type { DictationPolisher } from './polish.js';
import { useRecorder } from './useRecorder.js';

/**
 * The microphone of a composer: the recorder, the «как сказал» switch, and what
 * happens when the recognised text lands. Chat, the start screen and the light
 * shell's home each carried a copy of this callback.
 *
 * `draftRef` and `submitRef` are the caller's to keep current. The recorder's
 * callback is created once and fires long after — a minute later, from a GPU
 * queue — so anything it captured directly would be a value from before the
 * recording started. The caller owns the refs because only it knows where its
 * draft and its sender settle: `submitRef` is the sender the callback needs,
 * defined further down than the recorder.
 */
export function useDictationComposer({
  draft,
  setDraft,
  transcribe,
  polish,
  notifyError,
}: {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  transcribe: (blob: Blob, durSec?: number) => Promise<string>;
  /** Clean the text up before it lands; read through a ref by the recorder. */
  polish: DictationPolisher;
  notifyError: (message: string) => void;
}) {
  const draftRef = useRef('');
  const submitRef = useRef<(text: string) => void>(() => {});
  const dictSwitch = useDictationSwitch(draft, setDraft);
  const recorder = useRecorder(
    transcribe,
    // `immediate` means send was pressed DURING the recording (recorder.sendNow):
    // «наговорил — отправил», with no stop in the composer to read it first, so
    // the text goes straight out. The microphone still stops into the box, for
    // when you do want to look.
    (t, immediate, raw, polishFailed) => {
      if (immediate) {
        if (polishFailed) console.warn('[recorder] polish failed on send-now; sent as recognised');
        submitRef.current(draftRef.current ? `${draftRef.current} ${t}` : t);
      } else {
        setDraft((d) => (d ? `${d} ${t}` : t));
        if (raw) dictSwitch.remember(raw, t);
        else if (polishFailed) dictSwitch.rememberFailure(t);
        else dictSwitch.forget();
      }
    },
    notifyError,
    polish,
  );
  return { recorder, dictSwitch, draftRef, submitRef };
}
