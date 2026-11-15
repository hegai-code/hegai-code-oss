import { useEffect, useState } from 'react';
import { avatarIdx, initialOf } from '../lib.js';

/** Sizes match the ladder in DESIGN.md: list 40 · header 36 (`sm`) · card 34
 *  (`md`) · table 28 (`xs`) · info column 64 (`lg`). */
export type AvatarSize = '' | 'sm' | 'md' | 'xs' | 'lg';

interface Props {
  /** What the tone is keyed on. Deliberately SEPARATE from `label`: a row that
   *  groups by project keys its colour on the project, so every session in it
   *  shares one tone while each shows its own initial. Passing the label here
   *  would recolour those lists. */
  tone: string;
  /** What the letter is taken from. Empty/missing yields "?" (see initialOf). */
  label: string | undefined;
  /** The pulsing dot — the session is running right now. */
  live?: boolean;
  size?: AvatarSize;
  className?: string;
  /** Whose photo to try (`/api/avatar/:id`, the Telegram profile photo — see
   *  server-rs/src/avatar.rs). The letter stays underneath until it loads and
   *  comes back if there is none. */
  userId?: string;
}

/** The hub's photo for a user, or `null` once it answered «none». */
export function avatarSrc(userId: string): string {
  return `/api/avatar/${encodeURIComponent(userId)}`;
}

/** A photo over a fallback — the fallback shows until the image loads, and
 *  stays when the hub says there is none (404) or anything else goes wrong. */
export function PhotoOr({ userId, children }: { userId?: string; children: React.ReactNode }) {
  const [state, setState] = useState<'try' | 'ok' | 'none'>('try');
  useEffect(() => setState('try'), [userId]);
  if (!userId || state === 'none') return <>{children}</>;
  return (
    <>
      {state !== 'ok' && children}
      <img
        className={`av-photo${state === 'ok' ? '' : ' loading'}`}
        src={avatarSrc(userId)}
        alt=""
        onLoad={() => setState('ok')}
        onError={() => setState('none')}
      />
    </>
  );
}

/**
 * The identity mark: a rounded square whose tone is derived from a name, with
 * an optional live dot. One component for the nine places that had grown their
 * own copy of the same three lines — the copies had already drifted on what
 * counts as live (`working`, or `working || live`, or `live`), which is a
 * decision for the caller and is now the only thing a caller passes.
 *
 * Category and stage are NOT drawn here. Both are already rendered beside the
 * mark — category as a labelled `badge cat`, stage as the board column the card
 * sits in — and encoding them a second time in the avatar would say the same
 * thing twice without adding a way to read it.
 */
export function Avatar({ tone, label, live, size = '', className = '', userId }: Props) {
  const cls = ['avatar', size, `g${avatarIdx(tone)}`, userId ? 'has-photo' : '', className].filter(Boolean).join(' ');
  return (
    <span className={cls} aria-hidden>
      <PhotoOr userId={userId}>{initialOf(label)}</PhotoOr>
      {live && <span className="online" />}
    </span>
  );
}
