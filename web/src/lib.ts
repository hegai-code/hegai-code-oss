import type { ActiveRunInfo, ImageInput, MachineSnapshot, OsKind, SessionSummary } from '@cc-remote/shared';
import {
  ATTACH_B64_TOTAL_MAX,
  FILE_BYTES_MAX,
  IMAGE_MAX_EDGE,
  INLINE_IMAGE_BYTES_MAX,
} from '@cc-remote/shared';

/** Image media types the Claude SDK / Anthropic API accept. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/** A picked image staged in the composer: a data URL for preview + the fields
 *  needed to build the wire ImageInput. */
export type ImageAttachment = { name: string; dataUrl: string; media_type: ImageInput['media_type'] };

/**
 * Largest image the composer will INLINE into the prompt.
 *
 * The number lives in `shared/src/limits.ts` with the hub's per-image bound
 * (`sanitize_images`), which a `cargo test` keeps in step. Past it the hub
 * drops the image on the way through (and now says so) and the turn arrives
 * describing a picture nobody can see.
 *
 * Returning null here does not mean "rejected": `accept` then reads the same
 * file as an ORDINARY attachment, so a 20MB screenshot is written to the machine
 * and read from disk instead of vanishing. Worse than inline, much better than
 * silent.
 */
export const MAX_INLINE_IMAGE_BYTES = INLINE_IMAGE_BYTES_MAX;

/**
 * Longest side an inlined image is allowed to keep.
 *
 * This is an API bound, not a bandwidth opinion. Once a request carries several
 * images, Anthropic refuses the whole request if ANY of them is over 2000px on
 * a side: «At least one of the image dimensions exceed max allowed size for
 * many-image requests: 2000 pixels». A modern phone screenshot is 1179×2556 —
 * over it on the long edge — so a session where someone pastes a few of those
 * eventually answers every turn with an API error instead of a turn, and
 * nothing on screen connects that to the pictures.
 *
 * 1568 rather than 2000: it is the size the API downscales to anyway for its
 * own accounting, so anything above it costs bytes and tokens and buys no
 * detail. Below the cap nothing is touched — a small image is passed through
 * byte-for-byte. Shared with the hub via `shared/src/limits.ts`.
 */
const MAX_IMAGE_EDGE = IMAGE_MAX_EDGE;

/**
 * JPEG quality for a photo that had to be shrunk. The CLI writes every inlined
 * image into the session transcript as base64 — measured at 43% of a 57 MB
 * transcript — so bytes here are bytes in the file for the life of the
 * session. 0.8 is where a photo stops changing visibly and the file halves;
 * the iOS client has shipped at 0.6 without complaint. Screenshots stay PNG
 * regardless (see `downscale`).
 */
const JPEG_QUALITY = 0.8;

/** Types a canvas can re-encode without losing what the format is for. GIF is
 *  excluded on purpose: re-encoding kills the animation, and an animated GIF
 *  over 1568px is not a case worth breaking to save bytes. */
const RESIZABLE = ['image/jpeg', 'image/png', 'image/webp'];

/** Shrink to fit `MAX_IMAGE_EDGE`, or return null if it already fits / cannot be
 *  decoded here (in which case the original bytes are used unchanged). */
async function downscale(file: File): Promise<{ dataUrl: string; type: string } | null> {
  if (!RESIZABLE.includes(file.type) || typeof createImageBitmap !== 'function') return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return null; // corrupt, or a codec this browser will not decode
  }
  const longest = Math.max(bmp.width, bmp.height);
  if (longest <= MAX_IMAGE_EDGE) {
    bmp.close?.();
    return null;
  }
  const scale = MAX_IMAGE_EDGE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bmp.close?.();
    return null;
  }
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  // Keep PNG as PNG: screenshots of text re-encoded to JPEG pick up ringing
  // exactly where the text is, which is the part being asked about.
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return { dataUrl: canvas.toDataURL(type, JPEG_QUALITY), type };
}

/** Read a File into an ImageAttachment (data URL), shrunk to the API's
 *  many-image ceiling if it is over it. Returns null for unsupported types, and
 *  for an image still too big to inline (it goes the file route instead). */
export async function fileToImageInput(file: File): Promise<ImageAttachment | null> {
  if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) return null;
  // Shrink BEFORE the size gate, not after: a 12MB phone photo is inlineable
  // once it is 1568px wide, and inlining is what the person meant by attaching
  // a picture to a question about it.
  const shrunk = await downscale(file);
  if (shrunk) {
    return { name: file.name, dataUrl: shrunk.dataUrl, media_type: shrunk.type as ImageInput['media_type'] };
  }
  if (file.size > MAX_INLINE_IMAGE_BYTES) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  return { name: file.name, dataUrl, media_type: file.type as ImageInput['media_type'] };
}

/** Strip the data: URL prefix to the base64 payload the wire ImageInput needs. */
export function attachmentToImage(a: ImageAttachment): ImageInput {
  return { media_type: a.media_type, data: a.dataUrl.split(',')[1] ?? '' };
}

/**
 * Largest non-image attachment the composer will stage.
 *
 * base64 inflates by a third and the whole turn rides one WebSocket frame, so
 * this is really a frame budget, not a file-size opinion. The hub refuses
 * anything past its own bound anyway (`sanitize_files`); refusing here as well
 * means the person is told BEFORE they hit send, instead of watching a message
 * disappear.
 */
export const MAX_FILE_BYTES = FILE_BYTES_MAX;

/** A staged non-image attachment: the bytes, plus what to call it on screen. */
export interface FileAttachment {
  name: string;
  size: number;
  media_type?: string;
  /** base64, no data: prefix. */
  data: string;
}

/**
 * Read any file into the wire shape.
 *
 * Unlike `fileToImageInput` there is no type allow-list: a file does not have to
 * be understood here, only carried. The agent writes it to a scratch dir and the
 * session's own Read tool opens it, which is exactly how a person would have
 * used it if the file had been on that machine already.
 */
export async function fileToFileInput(file: File): Promise<FileAttachment | null> {
  if (file.size > MAX_FILE_BYTES) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const data = dataUrl.split(',')[1] ?? '';
  if (!data) return null;
  return {
    name: file.name || 'attachment',
    size: file.size,
    ...(file.type ? { media_type: file.type } : {}),
    data,
  };
}

/**
 * Total base64 the composer will stage across every image AND every file.
 *
 * `MAX_FILE_BYTES` bounds one attachment; this bounds the turn. The two are not
 * the same limit and the per-file one cannot stand in for it: four files of 8MB
 * is ~43MB of base64 in a single WebSocket frame, and a frame over the hub's
 * ceiling does not fail the request — it closes the socket, so the message
 * disappears and the app reconnects saying nothing. Mirrors the hub's
 * `MAX_ATTACH_B64_TOTAL`; refusing here means the person is told which file did
 * not fit, while they can still do something about it.
 */
export const MAX_ATTACH_B64_TOTAL = ATTACH_B64_TOTAL_MAX;

/** Base64 length of a staged image, excluding the `data:` prefix. */
export function imageB64Len(a: ImageAttachment | null | undefined): number {
  return a ? (a.dataUrl.split(',')[1] ?? '').length : 0;
}

/** What a whole set of staged images weighs on the wire. */
export function imagesB64Len(list: readonly ImageAttachment[]): number {
  return list.reduce((n, a) => n + imageB64Len(a), 0);
}

/** Human file size for the attachment chip. */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Which desktop client a person can install. There is no Linux build: the
 *  agent runs there (deploy/cc-remote-agent.service) but the client does not,
 *  and saying so is better than an OS switcher that quietly omits it. */
export type DesktopOs = 'mac' | 'win';

/**
 * The two desktop install commands, in one place.
 *
 * They are shown twice — on the public `/install/app` page and inside Settings
 * for someone already signed in — and a command that drifts between the two is
 * one people paste from whichever screen they happened to find. Each is install
 * AND update: the scripts are baked into the hub binary from `deploy/`.
 *
 * Mac points at `app-mac-shell.sh`, NOT `app-mac.sh`. The latter still answers
 * 200 and still installs — which is exactly what made this worth a comment: it
 * fetches `/dl/HegaiCode.zip`, the native SwiftUI app retired on 21.09.2026 and
 * no longer buildable from this repo. The current Mac client is the Tauri shell
 * in `windows/`, shipped as `/dl/HegaiCode-mac.zip`. Anyone moving across pays
 * one login: the native app kept its token in the Keychain, the shell lives on
 * the WebKit cookie jar, and neither can read the other.
 */
export const APP_INSTALL_COMMAND: Record<DesktopOs, (origin: string) => string> = {
  mac: (origin) => `curl -fsSL ${origin}/install/app-mac-shell.sh | bash`,
  // Single line on purpose: it has to survive being pasted into a chat, and a
  // multi-line PowerShell block does not.
  win: (origin) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${origin}/install/app-win.ps1 | iex"`,
};

/** The App Store listing (the app is public since 11.2026). */
export const APP_STORE_URL = 'https://apps.apple.com/ru/app/hegai-code/id6789674573';

/** The Google Play listing. */
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=net.hegai.code';

/** A hub that is not ours: the phone apps default to code.acme.test, so the
 *  person has to be told to pick «Другой хаб» and type this host. */
export function isCustomHub(hostname: string = location.hostname): boolean {
  return !/(^|\.)acme\.test$/i.test(hostname);
}

/** `/go` is the one way to put the agent on a server, a Linux box or a second
 *  computer: the agent prints a code and the person confirms it on `/link`.
 *  `unix` is macOS and Linux (one shell command), `win` is PowerShell. */
export type GoOs = 'unix' | 'win';
export const GO_COMMAND: Record<GoOs, (origin: string) => string> = {
  unix: (origin) => `curl -fsSL ${origin}/go | bash`,
  win: (origin) => `irm ${origin}/go.ps1 | iex`,
};

/** Which `/go` tab to show first. A hint: the switch sits beside it. */
export function guessGoOs(ua = navigator.userAgent): GoOs {
  return /Windows|Win64|Win32|WOW64/i.test(ua) ? 'win' : 'unix';
}

/** Which machine OS to show first in the install switch. Linux is its own tab:
 *  there is no app for it, only the agent. */
export type HostOs = 'mac' | 'win' | 'linux';
export function guessHostOs(ua = navigator.userAgent): HostOs {
  if (/Windows|Win64|Win32|WOW64/i.test(ua)) return 'win';
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  return 'mac';
}

export const isIosUa = (ua = navigator.userAgent): boolean => /iPhone|iPad|iPod/i.test(ua);
export const isAndroidUa = (ua = navigator.userAgent): boolean => /Android/i.test(ua);

/** Which OS the AGENT can be enrolled on with a one-time code. Not the same
 *  list as `DesktopOs`: Linux runs the agent but has no hub-served installer,
 *  so it is a render-site note rather than a tab. */
export type AgentOs = 'win' | 'mac';

const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const psQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The enrollment command for a machine, in one place.
 *
 * Three screens hand this out — the public `/install` page, Settings, and the
 * «Подключить железо» block on Железо — and each had, or was about to grow, its
 * own hand-typed copy. Settings' copy had already drifted: it pasted BOTH
 * operating systems into one blob with a literal `My PC` nobody edited, so
 * machines arrived named "My PC". A code is one-time, so a command that is
 * subtly wrong costs a whole round trip to mint another.
 *
 * The name and the code are quoted per shell because both are user input and a
 * machine called `Марат — офис` otherwise loses everything after the space.
 */
export const AGENT_INSTALL_COMMAND: Record<AgentOs, (a: { origin: string; code: string; name: string }) => string> = {
  win: ({ origin, code, name }) => [
    `$installer = Join-Path $env:TEMP 'cc-remote-install.ps1'`,
    `Invoke-WebRequest ${origin}/install/install-win.ps1 -OutFile $installer`,
    `powershell -ExecutionPolicy Bypass -File $installer -Name ${psQuote(name)} -EnrollmentCode ${psQuote(code)}`,
  ].join('\n'),
  mac: ({ origin, code, name }) => [
    `curl -fsSL ${origin}/install/install-mac.sh -o /tmp/cc-remote-install.sh`,
    `chmod +x /tmp/cc-remote-install.sh`,
    `/tmp/cc-remote-install.sh --name ${shQuote(name)} --enrollment-code ${shQuote(code)}`,
  ].join('\n'),
};

/**
 * Where this hub is, as the instructions on screen must say it: read from the
 * page, never typed in. A customer's hub is not code.acme.test, and the
 * one-liners are only worth pasting if they name the server the person is on.
 * `spareDoor` is HegAI's relay (`:8443` on *.acme.test); no other host has one.
 */
export function hubAddress(loc: { origin: string; host: string; hostname: string } = location): {
  origin: string;
  host: string;
  spareDoor: string | null;
} {
  return {
    origin: loc.origin,
    host: loc.host,
    spareDoor: /(^|\.)acme\.test$/i.test(loc.hostname) ? `https://${loc.hostname}:8443` : null,
  };
}

/**
 * Which install command to show first.
 *
 * A hint, not a gate: the switcher sits right next to it, because people
 * install on a machine other than the one they are browsing from more often
 * than any detector can guess. Everything that is not Windows falls to Mac,
 * including Linux — the honest wording for that case lives at the render site,
 * which is also the only place that knows whether it has room to say it.
 */
export function guessDesktopOs(ua = navigator.userAgent): DesktopOs {
  return /Windows|Win64|Win32|WOW64/i.test(ua) ? 'win' : 'mac';
}

/** «1 карточка», «2 карточки», «5 карточек» — Russian counts take three forms,
 *  and getting it wrong is the tell of a machine-translated interface: 1 действие,
 *  2–4 действия, 5–20 действий, then the last digit decides again (21 действие). */
export function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/** A hub timestamp in ms, whether it arrived in seconds or milliseconds. The
 *  hub writes ms; the odd row (and the SDK's rate-limit reset) sends seconds. */
export function toMillis(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** A short random id for a UI-local key — a composer in the URL, a socket
 *  viewer, an upload row. Not a secret and not a hub correlation id (that is
 *  `uuidish`, which has to look like a UUID). */
export function newId(prefix = '', length = 6): string {
  return prefix + Math.random().toString(36).slice(2, 2 + length);
}

/** Compact relative time for tight chrome: 'now', '5m', '3h', '2d'. */
export function relTime(ms: number, now = Date.now()): string {
  // Russian since 27.09.2026 (by request): «now / 23m / 3d» beside Russian
  // titles was the one English word in every row of the side panel.
  const d = Math.max(0, now - ms);
  const m = Math.floor(d / 60000);
  if (m < 1) return 'сейчас';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

const MONTHS_RU_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Long-form Russian relative time for a READING surface — cards, table rows,
 * the task board: «5 мин назад», «вчера». It is read by people who never see a
 * terminal, and «5m ago» is not a sentence to them. `relTime` is the compact
 * form for tight chrome. `now` is a parameter so tests do not depend on the
 * clock.
 */
export function relTimeRu(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} дн назад`;
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS_RU_SHORT[date.getMonth()]}`;
}

/**
 * Calendar-day identity in the READER's timezone, for deciding where a day
 * boundary falls in the transcript. It has to be calendar-based: two turns 90
 * minutes apart are on different days when one is at 23:30, and two turns 20
 * hours apart can share one. Comparing elapsed milliseconds gets both wrong.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The stamp EVERY turn carries — the messenger reading, not a journal's.
 *
 * The transcript used to date itself with rules across the measure ("13 SEP",
 * "CONTINUED") and print the clock on the first turn of a run only. Two weeks
 * of real use said the opposite of what that design assumed: the question a
 * reader actually asks is "when was THIS message", turn by turn, and answering
 * it with a horizontal rule three screens up is answering a different question.
 * So the rules are gone and the answer moved onto the turn itself.
 *
 * Today's turns show the clock alone — the date would be noise on every line of
 * the session you are in right now. Anything older carries its date, and a
 * previous year carries the year.
 */
export function stamp(ms: number): string {
  const now = new Date();
  const then = new Date(ms);
  if (dayKey(ms) === dayKey(now.getTime())) return hhmm(ms);
  // Numeric, not '13 сент.': this sits in a 76px mono gutter next to the time,
  // and a spelled month is the difference between one line and two.
  //
  // Locale PINNED, unlike everything else about a numeric date: left to the
  // browser, a Mac in en-US renders 13.09 as '09/13' — and a bare numeric date
  // whose field order you have to guess is worse than no date. The interface is
  // Russian throughout and already pins 'ru' for dates elsewhere (FileList,
  // AccessGate, TeamAccess).
  const date = then.toLocaleDateString('ru', {
    day: '2-digit',
    month: '2-digit',
    // The year only earns its space once it stops being the obvious one.
    ...(now.getFullYear() === then.getFullYear() ? {} : { year: '2-digit' }),
  });
  return `${date} ${hhmm(ms)}`;
}

/** Wall-clock time for a turn's dateline. 24h regardless of locale: the gutter
 *  is mono and column-aligned, and 'AM'/'PM' costs three characters there. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function machineNameOf(machines: MachineSnapshot[], id: string): string {
  return machines.find((m) => m.machine.machineId === id)?.machine.name ?? '';
}

/** Identity tone for an avatar — a 4-way cycle keyed to the name (see
 *  .avatar.g0…g3 in styles.css), stable across list reorders. Four, not seven:
 *  the design system has four sanctioned surface tones, and the three extra
 *  gradients were decorative rather than meaningful. */
export function avatarIdx(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 4;
}

/** Session titles come straight from the first transcript line, which is often
 *  CLI-injected context ("# Files mentioned by the user: ## …", `<image …>`
 *  pseudo-tags). Flatten to a plain one-line label for chrome: tags out,
 *  markdown markers out, whitespace collapsed. */
export function cleanTitle(t: string | undefined): string {
  if (!t) return '';
  return t
    .replace(/<[^<>\n]{0,200}>/g, ' ') // <image name=… path=…> pseudo-tags
    .replace(/(^|\s)#{1,6}(?=\s|$)/g, ' ') // markdown heading markers
    .replace(/[*`~]+|_{2,}/g, ' ') // emphasis fences (single _ kept: snake_case)
    .replace(/\s+/g, ' ')
    .trim();
}

/** First visible letter for an avatar circle (uppercased; '?' for empty). */
export function initialOf(name: string | undefined): string {
  const c = (name ?? '').trim().charAt(0);
  return c ? c.toUpperCase() : '?';
}

/** Canonical `machine::session` key used for run lookups, favorites, and list keys. */
export function sessionKey(machineId: string, sessionId: string): string {
  return `${machineId}::${sessionId}`;
}

/** Runs keyed by `machine::session`. */
export type RunIndex = Map<string, ActiveRunInfo>;

/** Index runs by `machine::session` for fast attention lookups. */
export function indexRuns(runs: ActiveRunInfo[]): RunIndex {
  const m = new Map<string, ActiveRunInfo>();
  for (const r of runs) m.set(sessionKey(r.machineId, r.sessionId), r);
  return m;
}

/**
 * One definition of "this is my work", for the whole UI.
 *
 * The fallback to the MACHINE's owner is the load-bearing half. `owner` is
 * injected by the hub from its session-owner map, which only ever gets a row
 * for a session cc-remote itself started; a session the agent found on disk —
 * every terminal and every VS Code window — arrives with no owner and can
 * never acquire one. So `s.owner?.userId === viewerId` would not filter out
 * other people, it would filter out almost all of YOUR OWN work.
 *
 * …on a PERSONAL machine. The fallback assumes one person at that keyboard,
 * and a shared box breaks the assumption: the employee sandbox is a single
 * machine owned by one person that several people work on (the same trap
 * `sessionAuthor` in TeamViews and the `people` tally in Home already name),
 * so attributing every ownerless terminal there to its owner filed the whole
 * team's work under «моё». On such a machine an unattributed session is
 * exactly what the hub says it is: unattributed — and that is not yours.
 *
 * The machine is passed whole rather than as an owner + a kind, because these
 * fields only ever answer this question together. Which box counts as shared is
 * `shared`, NOT `kind`: `kind` records how a machine enrolled, and the employee
 * sandbox enrolled as a personal device of its owner — the fleet's one box that
 * a whole team works on says `personal`, so reading the label would have left
 * the symptom exactly where it was. `shared` is the hub answering the question
 * that matters — does anybody else have a share here — and it is absent, never
 * false, when nobody does.
 */
export function sessionIsMine(
  session: Pick<SessionSummary, 'owner'>,
  machine: Pick<MachineSnapshot, 'owner' | 'kind' | 'shared'> | undefined,
  viewerId: string | undefined,
): boolean {
  if (session.owner) return session.owner.userId === viewerId;
  if (machine?.shared || machine?.kind === 'sandbox') return false;
  return !machine?.owner || machine.owner.userId === viewerId;
}

/**
 * Whose sessions the lists show: «Мои» · «Команда» · «Все» (29.09.2026).
 *
 * `team` is other people's work WITHOUT yours — the point of the mode is to
 * look at the team without your own sessions mixed in. `all` is both, with
 * the author named on every row that is not yours.
 */
export type SessionScope = 'mine' | 'team' | 'all';

/** One rule for every list that honours the scope: does a session whose
 *  «моё» answer is `mine` stay on screen? */
export function scopeKeeps(scope: SessionScope, mine: boolean): boolean {
  return scope === 'all' || (scope === 'mine') === mine;
}

/** A run knows its owner before the debounced inventory does. Keep the
 *  recorded session owner when present, as `runIsMine` does. */
export function sessionOwner(
  session: Pick<SessionSummary, 'owner'>,
  run: Pick<ActiveRunInfo, 'ownerUserId' | 'ownerName'> | undefined,
): SessionSummary['owner'] {
  return session.owner ?? (run?.ownerUserId ? { userId: run.ownerUserId, fullName: run.ownerName ?? undefined } : undefined);
}

/** Is there at least one session in the snapshot that is not the viewer's?
 *  Who may switch at all is `canSwitchScope` (shell/workspace.ts, the one
 *  place allowed to read a workspace's kind). A switch whose other positions would show what the first one does is
 *  noise, so the top bar draws it only when this holds (or when it is already
 *  off «Мои», so the way back never disappears). */
export function hasOthersWork(
  machines: Pick<MachineSnapshot, 'machine' | 'owner' | 'kind' | 'shared' | 'sessions'>[],
  viewerId: string | undefined,
  runs: ActiveRunInfo[] = [],
): boolean {
  const runIndex = indexRuns(runs);
  const byId = new Map(machines.map((m) => [m.machine.machineId, m]));
  if (machines.some((m) => m.sessions.some((s) => !sessionIsMine(
    { owner: sessionOwner(s, runIndex.get(sessionKey(m.machine.machineId, s.sessionId))) }, m, viewerId,
  )))) return true;
  // New sessions can be present only in activeRuns for several seconds.
  return runs.some((r) => {
    const m = byId.get(r.machineId);
    if (!m) return false;
    const s = m.sessions.find((s) => s.sessionId === r.sessionId);
    return !sessionIsMine({ owner: sessionOwner(s ?? {}, r) }, m, viewerId);
  });
}

/** The author key of a session nobody can vouch for — see `authorOf`. */
export const NO_AUTHOR = '—';

/**
 * Who a session in someone else's work belongs to, for the «Команда» cards and
 * the author on «Все» rows.
 *
 * The recorded owner when there is one. Without it, the machine's owner — a
 * terminal on a colleague's own laptop is that colleague's — but NOT on a
 * shared box (several people type there, so the owner is a guess; the same
 * rule `sessionIsMine` applies) and NOT when the machine is the viewer's
 * (naming you as the author of «someone else's work» contradicts the list).
 * Those go under one «Без автора» card: a terminal or editor window the hub
 * never saw start.
 */
export function authorOf(
  session: Pick<SessionSummary, 'owner'>,
  machine: Pick<MachineSnapshot, 'owner' | 'shared' | 'kind'> | undefined,
  viewerId: string | undefined,
): { key: string; name: string; userId?: string } {
  // Same rule as `sessionIsMine`: on a shared box an absent owner means
  // «nobody in particular», not the box's owner — whoever is looking.
  const byBox =
    machine?.owner && !machine.shared && machine.kind !== 'sandbox' && machine.owner.userId !== viewerId
      ? machine.owner
      : undefined;
  const o = session.owner ?? byBox;
  if (!o) return { key: NO_AUTHOR, name: 'Без автора' };
  return { key: o.userId, name: displayName(o), userId: o.userId };
}

/** A person's name as a row's small print: the first name, or the local part
 *  of an address. Names the product made up itself («Без автора», «Участник
 *  3f9a01») stay whole — their first word alone says nothing. */
export function shortName(name: string): string {
  if (name === 'Без автора') return 'без автора';
  if (name.startsWith('Участник ')) return name;
  return name.split(/[\s@]/)[0] || name;
}

/** What to call the author on a row: the recorded owner, else the machine's
 *  owner (sessions that predate ownership being recorded), else the machine. */
export function sessionAuthor(
  session: { owner?: { fullName?: string; email?: string } },
  machine: { owner?: { fullName?: string; email?: string }; machine: { name: string } } | undefined,
): string {
  return (
    session.owner?.fullName ??
    session.owner?.email ??
    machine?.owner?.fullName ??
    machine?.owner?.email ??
    machine?.machine.name ??
    'Без автора'
  );
}

/**
 * Group rows by author, then by project inside each author — the «Команда»
 * layout. Both levels are ordered by `order` applied to their head row, so
 * whoever has something live comes first, then by recency, the same rule the
 * project cards already follow.
 */
export function groupByPerson<R extends { session: Pick<SessionSummary, 'project' | 'cwd'> }>(
  rows: R[],
  order: (a: R, b: R) => number,
  keyOf: (r: R) => string,
): { key: string; rows: R[]; projects: [string, R[]][] }[] {
  const people = new Map<string, R[]>();
  for (const r of rows) {
    const k = keyOf(r);
    (people.get(k) ?? people.set(k, []).get(k)!).push(r);
  }
  const out = [...people.entries()].map(([key, rs]) => {
    rs.sort(order);
    const projects = new Map<string, R[]>();
    for (const r of rs) {
      const p = panelProjectKey(r.session);
      (projects.get(p) ?? projects.set(p, []).get(p)!).push(r);
    }
    // `rs` is sorted, so each project's rows arrive sorted and the map keeps
    // first-seen order — which is the order of each project's head row.
    return { key, rows: rs, projects: [...projects.entries()] };
  });
  // «Без автора» last whatever its recency: it is not a person, and leading
  // with it would make the first card on the screen the least informative one.
  out.sort((a, b) => Number(a.key === NO_AUTHOR) - Number(b.key === NO_AUTHOR) || order(a.rows[0], b.rows[0]));
  return out;
}

/**
 * Is this session live RIGHT NOW — by either of the two independent signals.
 *
 * A run in any state counts, `idle` included: an open run still holds the
 * single-writer lock, so the session is held whether or not the agent happens
 * to be mid-turn. `livePid` is the other half and the one the old «Сейчас в
 * работе» never saw — a pid file under `~/.claude/sessions`, i.e. a person's
 * own editor or terminal.
 */
export function sessionIsActive(
  session: Pick<SessionSummary, 'livePid'>,
  run: ActiveRunInfo | undefined,
): boolean {
  return !!session.livePid || !!run;
}

/**
 * Is anything WORKING on this session right now — the «идёт работа» bolt.
 *
 * Narrower than `sessionIsActive` on purpose. Held is not busy: a run in
 * `idle` holds the writer and is waiting for you, and a `livePid` is just as
 * often an editor window or a Claude Desktop session left open for days. The
 * bolt used to take `!!livePid` for work, so two sessions idle since the day
 * before yesterday on clientco sat under «Сейчас в работе» with the bolt lit.
 *
 * Working is either a run mid-turn, or an external process whose own pid file
 * says `busy`. No `liveStatus` (an older CLI or agent) reads as not known to be
 * working — the row still lists the session as held, just without the bolt.
 */
export function sessionIsWorking(
  session: Pick<SessionSummary, 'livePid' | 'liveStatus'>,
  run: ActiveRunInfo | undefined,
): boolean {
  return run?.state === 'working' || (!!session.livePid && session.liveStatus === 'busy');
}

// ---------------------------------------------------------------------------
// Projects you can start work in
// ---------------------------------------------------------------------------

/** A place a new session can be started: one (machine, cwd) pair. */
export interface ProjectTarget {
  machineId: string;
  machineName: string;
  cwd: string;
  label: string;
  lastModified: number;
  /** Yours: you started something here, or it is unowned work on your machine. */
  mine: boolean;
  /** Sessions here that are running right now / waiting for an answer. */
  live: number;
  attention: number;
  /** Where the agent found it: derived from sessions, or by scanning the
   *  projects root — a git repo nobody has started a session in yet. Absent
   *  when the target came from the fleet snapshot rather than `projects.list`. */
  origin?: 'sessions' | 'root' | 'adopted';
  /** Created from the start screen a moment ago and untouched since: the
   *  composer then suggests a first prompt shaped by how it was made. Set by
   *  the create flow, dropped once the target has a session of its own. */
  fresh?: 'empty' | 'clone';
  /** A managed worktree (`managedWorktree`): the full path of the repository it was cut from. The
   *  shelf lists it right under that repository, labelled with its branch. */
  worktreeOf?: string;
}

/** A startable place that is not (yet) backed by a discovered session: a
 *  control-share root, or a project the agent found by scanning its root. */
export interface ExtraTarget {
  machineId: string;
  cwd: string;
  label: string;
  origin?: 'sessions' | 'root' | 'adopted';
  /** ms epoch, when the agent knows one; absent/0 = never touched. */
  lastModified?: number;
}

/** Startable roots that carry no project: `/`, `/root`, and bare home dirs. */
export function isRootish(cwd: string): boolean {
  const norm = cwd.replace(/\\/g, '/');
  // The drive letter is not a level for the home-dir test (`C:\Users\x` is
  // `/home/x`), but `D:\hegai` IS a project: a first-level folder counts as a
  // root only on POSIX, where it is `/root`, `/srv` and the like.
  const drive = /^[a-z]:/i.test(norm);
  const seg = norm.replace(/^[a-z]:/i, '').split('/').filter(Boolean);
  if (seg.length === 0 || (!drive && seg.length === 1)) return true; // "/", "/root", "C:"
  return seg.length === 2 && /^(users|home)$/i.test(seg[0]!);
}

/**
 * How loudly a session asks to be looked at, for ordering the side panel:
 * 2 = it waits for you (a decision or an error), 1 = the agent is working,
 * 0 = everything else — INCLUDING an idle run and a bare `livePid`.
 *
 * That last part is the point (30.09.2026). The panel used to float any
 * «live» session (`sessionIsActive`) above everything, and «live» is true of a
 * VS Code window left open for a week. Projects then sorted by which editors
 * happened to be open, not by where work had happened, and read as random.
 */
export function sessionUrgency(run: Pick<ActiveRunInfo, 'state'> | undefined): 0 | 1 | 2 {
  if (run?.state === 'needs_attention' || run?.state === 'error') return 2;
  if (run?.state === 'working') return 1;
  return 0;
}

/** Side-panel project key for a session: its label, or «—» when the session
 *  has no project to speak of — no cwd, or a root / home dir (`isRootish`),
 *  which otherwise showed up as projects called «root» or «owner». */
export function panelProjectKey(s: Pick<SessionSummary, 'cwd' | 'project'>): string {
  if (s.cwd && isRootish(s.cwd)) return NO_PROJECT;
  return s.project ?? NO_PROJECT;
}
export const NO_PROJECT = '—';

/** A project counts as recent when touched within this window… */
export const RECENT_PROJECT_MS = 7 * 24 * 60 * 60 * 1000;
/** …and no more than this many are shown as full cards; the rest fold into
 *  «Раньше» as one line each. Urgent projects are cards regardless. */
export const RECENT_PROJECT_MAX = 8;

/** When a session was created: `createdAt`, else its last change (provisional
 *  rows built from active runs have only that). */
export function sessionCreated(s: Pick<SessionSummary, 'createdAt' | 'lastModified'>): number {
  return s.createdAt ?? s.lastModified;
}

/** Panel order of sessions (11.11.2026): waits-for-you / error first, then
 *  working, then newest CREATED, then session id. A fresh message no longer
 *  moves a row; only its state does (Owner: active ones belong on top). */
export function compareByAttention(
  a: { urgency: number; created: number; id: string },
  b: { urgency: number; created: number; id: string },
): number {
  return b.urgency - a.urgency || b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Panel order of projects: one waiting for you, then one with work running,
 *  then the quiet ones — each group by the newest CREATED row, then key. */
export function compareProjects(
  a: { key: string; urgency: number; created: number },
  b: { key: string; urgency: number; created: number },
): number {
  return b.urgency - a.urgency || b.created - a.created || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Order the side panel's projects and cut them into cards and the folded tail.
 *
 * Order (11.11.2026 — the list used to jump on every message): a project
 * waiting for you or failed (urgency 2), then one with work running (1), then
 * the quiet ones; inside each group the newest CREATED row (`created`), then
 * key. A message alone no longer moves a project. Shelf membership is unchanged: the tail
 * («Раньше») takes whatever has no change (`lastModified`) within
 * `RECENT_PROJECT_MS`, anything past `RECENT_PROJECT_MAX` calm cards, and the
 * «no project» bucket — unless it is urgent (> 0), because a card is the only
 * place the panel shows a question waiting for an answer or live work.
 */
export function arrangeProjects<T extends { key: string; urgency: number; lastModified: number; created: number }>(
  projects: T[],
  now = Date.now(),
): { recent: T[]; older: T[] } {
  const sorted = [...projects].sort(compareProjects);
  const recent: T[] = [];
  const older: T[] = [];
  let calm = 0;
  for (const p of sorted) {
    if (p.urgency > 0) {
      recent.push(p);
      continue;
    }
    const fresh = now - p.lastModified < RECENT_PROJECT_MS;
    if (p.key !== NO_PROJECT && fresh && calm < RECENT_PROJECT_MAX) {
      recent.push(p);
      calm += 1;
    } else older.push(p);
  }
  return { recent, older };
}

/** Recency window for "работа идёт сейчас". Older projects stay reachable
 *  through the picker's search — they are just not offered up front. */
export const PROJECT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Where this viewer can start a session, most-recent first.
 *
 * Three rules, and each one exists because the flat "every cwd in the fleet"
 * list broke a promise:
 *
 * - **Startable only.** A machine the hub will refuse to start on has no
 *   business in a picker whose only job is starting something.
 * - **Yours.** `session.owner` is set only for sessions started through
 *   cc-remote, so a terminal or IDE session has none. Attributing those by the
 *   MACHINE's owner is what keeps an owner's own work visible; without it the
 *   strict reading hides nearly everything the owner does. On a SHARED box that
 *   fallback is off (`sessionIsMine`), so a sandbox's projects can all come
 *   back `mine: false` — `recentProjects` shows the whole list rather than an
 *   empty shelf when that happens, which is the case it was written for.
 * - **Not a root.** `/` and `/root` are cwds, not projects.
 * - **Not a cron loop.** A scripted session (`isAutomatedSession`) never makes
 *   a project "yours": the CRM lead loop wakes every 20 minutes on a machine
 *   its owner rarely opens, and the shelf that is supposed to say "where you
 *   work" ended up led by a directory nobody had typed in for weeks. This is
 *   deliberately NOT the global `showAutomated` toggle — that one governs
 *   whether the runs are listed at all; a shelf you pick a project FROM is a
 *   different question from a history you read.
 *
 * `mine` is carried rather than filtered so a caller can offer the rest as a
 * long tail instead of pretending it does not exist.
 */
/**
 * The key a project is counted under, per machine.
 *
 * Windows paths are case-insensitive, and the transcripts prove the fleet uses
 * that: `buildbox-pc` carries `d:\\Hegai_VScode\\claudehegai` and
 * `D:\\Hegai_VScode\\claudehegai` — the same folder, opened from two places
 * that spelled the drive letter differently. Keyed verbatim, one directory
 * became two projects: two rows with the same name, the same contents and
 * nothing to choose between them. (It was the path qualifier added for
 * same-named projects that finally made it visible — it printed `d:/…` against
 * `D:/…`.)
 *
 * Case is folded ONLY where the filesystem folds it. On mac and Linux
 * `Foo` and `foo` are genuinely different directories, and merging them there
 * would aim the composer at whichever one happened to be seen first.
 */
function projectKey(machineId: string, cwd: string, os: OsKind | undefined): string {
  return sessionKey(machineId, os === 'windows' ? cwd.toLowerCase() : cwd);
}

export function projectTargets(
  machines: MachineSnapshot[],
  viewerId: string | undefined,
  runs: RunIndex,
  extraTargets: ExtraTarget[] = [],
): ProjectTarget[] {
  const map = new Map<string, ProjectTarget>();
  for (const m of machines) {
    // The SAME test that gates the "Новая сессия" button (App.tsx's
    // `canStartAnywhere`). Both fields are optional, so `=== true` and
    // `!== false` disagree on an older agent — and a picker that offers what
    // the button says is impossible is worse than either answer.
    if (m.canControl !== true && m.canStart !== true) continue;
    for (const s of m.sessions) {
      if (!s.cwd || isRootish(s.cwd)) continue;
      if (isAutomatedSession(s)) continue;
      const key = projectKey(m.machine.machineId, s.cwd, m.machine.os);
      const mine = sessionIsMine(s, m, viewerId);
      const run = runs.get(sessionKey(m.machine.machineId, s.sessionId));
      const ex = map.get(key);
      const wt = managedWorktree(s.cwd);
      const t: ProjectTarget = ex ?? {
        machineId: m.machine.machineId,
        machineName: m.machine.name,
        cwd: s.cwd,
        label: wt ? `${wt.repo} · ${wt.name}` : s.project || s.cwd.split('/').filter(Boolean).pop() || s.cwd,
        ...(wt ? { worktreeOf: wt.source } : {}),
        lastModified: 0,
        mine: false,
        live: 0,
        attention: 0,
      };
      t.lastModified = Math.max(t.lastModified, s.lastModified);
      t.mine = t.mine || mine;
      // WORKING means the agent is doing something, not that the session is
      // open. `|| s.livePid` counted the second: a resumed session sits with a
      // live process for as long as you have it open, so every session you had
      // ever touched reported itself as running and the count stopped meaning
      // anything. `run.state === 'working'` is the agent mid-turn.
      if (run?.state === 'working') t.live += 1;
      if (run?.state === 'needs_attention' || run?.state === 'error') t.attention += 1;
      map.set(key, t);
    }
  }
  // Control-share roots with no discovered session yet (cold start) are still
  // places this viewer was explicitly given — they are hers by definition. The
  // same goes for a project the agent found by scanning its root: it exists
  // only because the viewer pressed «Новый». The rootish / scratch filters
  // apply here too, so an agent's list can never smuggle `/tmp/…` back onto a
  // shelf that hides it for sessions.
  for (const e of extraTargets) {
    if (isRootish(e.cwd) || isScratchCwd(e.cwd)) continue;
    // Same fold as above: a root scan on Windows can spell the drive either
    // way, and a scanned copy of a directory the snapshot already has is the
    // same project, not a second one.
    const key = projectKey(
      e.machineId,
      e.cwd,
      machines.find((m) => m.machine.machineId === e.machineId)?.machine.os,
    );
    // A target the snapshot already knows has sessions — whatever the agent's
    // root scan said a moment ago, it is not "fresh" any more.
    if (map.has(key)) continue;
    const ewt = managedWorktree(e.cwd);
    map.set(key, {
      machineId: e.machineId,
      machineName: machines.find((m) => m.machine.machineId === e.machineId)?.machine.name ?? '',
      cwd: e.cwd,
      label: ewt ? `${ewt.repo} · ${ewt.name}` : e.label,
      ...(ewt ? { worktreeOf: ewt.source } : {}),
      lastModified: e.lastModified ?? 0,
      mine: true,
      live: 0,
      attention: 0,
      ...(e.origin ? { origin: e.origin } : {}),
    });
  }
  return groupWorktrees([...map.values()].sort((a, b) => b.lastModified - a.lastModified));
}

/**
 * Put every managed worktree right after the repository it was cut from (same
 * machine, same source repository path), newest first among themselves. A worktree
 * whose repository is not on the shelf keeps its recency slot.
 */
export function groupWorktrees(sorted: ProjectTarget[]): ProjectTarget[] {
  if (!sorted.some((t) => t.worktreeOf)) return sorted;
  const kids = new Map<string, ProjectTarget[]>();
  const repos = new Set(sorted.filter((t) => !t.worktreeOf).map((t) => `${t.machineId}::${cwdKey(t.cwd)}`));
  const out: ProjectTarget[] = [];
  for (const t of sorted) {
    const k = `${t.machineId}::${t.worktreeOf}`;
    if (t.worktreeOf && repos.has(k)) kids.set(k, [...(kids.get(k) ?? []), t]);
  }
  for (const t of sorted) {
    if (t.worktreeOf) {
      if (!repos.has(`${t.machineId}::${t.worktreeOf}`)) out.push(t);
      continue;
    }
    out.push(t, ...(kids.get(`${t.machineId}::${cwdKey(t.cwd)}`) ?? []));
  }
  return out;
}

/**
 * The few projects to offer up front: yours, touched recently, most-recent
 * first. Falls back to the plain startable list rather than showing an empty
 * shelf to someone whose work the hub has no owner record for yet.
 */
export function recentProjects(all: ProjectTarget[], limit = 12, now = Date.now()): ProjectTarget[] {
  const mine = all.filter((p) => p.mine && (p.lastModified === 0 || now - p.lastModified < PROJECT_WINDOW_MS));
  return (mine.length ? mine : all).slice(0, limit);
}

/**
 * A cwd the OS hands out as scratch — `mkdtemp` and friends.
 *
 * Windows `%LOCALAPPDATA%\Temp`, Linux `/tmp` and `/var/tmp`, macOS
 * `/var/folders/…/T` (which also answers to the `/private` prefix). Matched on
 * the ROOT rather than anywhere in the path, so someone's real `~/work/tmp/app`
 * is not swept up with the throwaways.
 *
 * Two additions from 30.09.2026, both seen in the side panel as fake projects:
 *
 * - **`/tmp` itself.** A scoring job run through cc-remote left 179 sessions
 *   with cwd exactly `/tmp` on dev-box-1 (entrypoint `cc-remote`, so the
 *   scripted rule missed them too), and the panel grew a project called «tmp».
 * - **Agent working dirs at any depth**: a Claude Code `scratchpad/` (lives
 *   under `/tmp/claude-*` here, but under a home dir elsewhere) and
 *   `~/.cc-remote/` — the agent's own state, where Тео's journal runs
 *   (`agent/src/journal.ts`). The board collector already cuts scratchpads
 *   (`deploy/board-assemble.py`, `TMP_CWD`).
 */
export function isScratchCwd(cwd?: string): boolean {
  if (!cwd) return false;
  let p = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (/^[a-z]:\//.test(p)) p = p.slice(2); // C:/Users/… → /users/…
  if (p.startsWith('/private/')) p = p.slice(8); // macOS /private/var → /var
  // Narrow on purpose: this hides a session from EVERY list, so a real
  // `~/code/scratchpad` must survive. Only the harness's shape (under a
  // `claude-*` or `.claude` dir) and the agent's own dir right under a home.
  if (/\/(claude-[^/]+|\.claude)\/.*\/scratchpad(\/|$)/.test(p)) return true;
  if (/^\/(root|home\/[^/]+|users\/[^/]+)\/\.cc-remote(\/|$)/.test(p)) return true;
  return (
    p === '/tmp' ||
    p === '/var/tmp' ||
    p.startsWith('/tmp/') ||
    p.startsWith('/var/tmp/') ||
    p.startsWith('/var/folders/') ||
    p.startsWith('/windows/temp/') ||
    p.includes('/appdata/local/temp/')
  );
}

/**
 * A cwd inside a git worktree an agent cut for itself.
 *
 * Claude Code's worktree isolation parks a run in
 * `<repo>/.claude/worktrees/<name>`, and from that moment the session reports
 * that path as its cwd. `projectLabel()` reads the last meaningful segment, so
 * the session stops being «remotehegai» and becomes a project called
 * «shell-chrome» — a repository nobody cloned, sitting in the list beside real
 * ones. Matched anywhere in the path rather than at the root, because the repo
 * it belongs to can live at any depth.
 */
export function isWorktreeCwd(cwd?: string): boolean {
  if (!cwd) return false;
  return cwd.replace(/\\/g, '/').toLowerCase().includes('/.claude/worktrees/');
}

/**
 * A worktree this app cut itself (`git.worktree.add`):
 * `<repoParent>/.hegai-worktrees/<repo>/<branch-with-dashes>`. Unlike
 * `.claude/worktrees` (the coder's own scaffolding, hidden above) this is a place
 * a person deliberately started an agent in and comes back to, so it stays on the
 * shelf — labelled `repo · branch` and listed under its repository.
 */
export function managedWorktree(cwd?: string): { repo: string; name: string; source: string } | null {
  if (!cwd) return null;
  // `<repoParent>/.hegai-worktrees/<repoName>/<branch>` was cut from `<repoParent>/<repoName>`.
  const m = cwd.replace(/\\/g, '/').match(/^(.*)\/\.hegai-worktrees\/([^/]+)\/([^/]+)(?:\/|$)/);
  return m?.[2] && m[3] ? { repo: m[2], name: m[3], source: `${m[1]}/${m[2]}` } : null;
}

/** A cwd as a comparison key: forward slashes, no trailing slash. */
function cwdKey(cwd: string): string {
  const k = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return k || '/';
}

/**
 * Not work anyone comes back to — hidden from every list unless the
 * "показывать автоматические" toggle is on.
 *
 * Three rules, and each covers a different way the fleet fills with noise:
 *
 * - **Scripted.** `sdk-cli` is the headless `claude -p` path cron jobs and
 *   shell scripts take. Deliberately NOT `sdk-*`, even though that would be
 *   the tidier pattern — older cc-remote builds recorded their own resumes as
 *   `sdk-ts` (agent/src/client.ts says so where it asks for programmatic
 *   sessions), so the wide mask would hide exactly the work a person did from
 *   their phone. It no longer spares a session that has an `owner`: a cron loop
 *   started THROUGH cc-remote carries one, which made the belt hide the
 *   scripted sessions nobody owned and show the scripted sessions somebody did.
 *   `sdk-cli` is the headless flag itself — a person never drives one.
 * - **Scratch cwd.** A session in a `mkdtemp` directory has no future: the OS
 *   deletes the folder, and nobody resumes work in a path they cannot name.
 *   Unlike the scripted rule this one ignores `owner`, because the smoke
 *   harnesses (`server/src/cli/*`) start their throwaways THROUGH cc-remote —
 *   entrypoint `cc-remote`, owner set — and are indistinguishable from real
 *   work by anything except where they run.
 * - **Agent worktree.** A run that isolated itself into
 *   `.claude/worktrees/<name>` (see `isWorktreeCwd`). The branch is the agent's
 *   scaffolding, not a destination: the work lands back on the parent repo when
 *   the worktree merges, and until then the session advertises a project that
 *   does not exist. Also ignores `owner` — the worktree is cut by the agent
 *   mid-run, so the session it renames is usually one a person did start.
 *
 * Why hide at all: the CRM lead-research loop on stage runs every 20 minutes,
 * each run a fresh transcript — ~72 sessions a day, and a project's history
 * becomes ninety identical rows with the human work buried underneath. The
 * smoke runs do the same to the project shelf, one temp directory at a time,
 * and the worktrees do it to the project shelf itself.
 *
 * - **Probe title** (30.09.2026). A liveness probe or a scripted prompt sent
 *   through cc-remote carries entrypoint `cc-remote` and a real cwd, so neither
 *   rule above sees it; its first line does. The list is the board collector's
 *   (`PROBE_TITLE` in `deploy/board-assemble.py`) cut to machine markers:
 *   no one-word entries («ок», «test») and no role prompts («Ты —
 *   интернет-маркетолог…») — a person opens real chats that way, and this rule
 *   hides a session from every list, not just the panel (the role-prompt
 *   crons are `sdk-cli` anyway). Plus the session-scoring prompt that filled
 *   dev-box-1 with «tmp».
 *
 * - **Fleet spawn** (31.10.2026). The hub stamps `automated` on sessions
 *   started via `hegai-fleet spawn` (agent-to-agent jobs), like cron runs.
 */
const PROBE_TITLE =
  /^\s*(echo probe|Ответь одним словом|reply with the single word|Run exactly this bash command|Оцени каждую сессию ниже по рубрике)/i;

export function isProbeTitle(title?: string): boolean {
  return !!title && PROBE_TITLE.test(title);
}

export function isAutomatedSession(s: {
  entrypoint?: string;
  owner?: unknown;
  cwd?: string;
  title?: string;
  automated?: boolean;
}): boolean {
  if (s.automated) return true;
  if (isScratchCwd(s.cwd)) return true;
  if (isWorktreeCwd(s.cwd)) return true;
  if (isProbeTitle(s.title)) return true;
  return s.entrypoint === 'sdk-cli';
}

/** Which runtime answers in a session — the name shown on its turns. One
 *  definition so Chat and Mirror cannot disagree (the mirror used to omit it
 *  and label Codex turns "Claude"). */
export function agentName(source?: string): string {
  return source === 'codex' ? 'Codex' : 'Claude';
}

/**
 * How to show a person in a list, a toast or a confirm: the full name, else
 * the address, else a short id. Accounts without an address exist (a
 * Telegram-only sign-in), so nothing should build a label from `.email`
 * directly — that is how `undefined` got into prompts and `.slice` crashed the
 * members list. `viewerName` below is the FIRST-name variant for turns.
 */
export function displayName(
  who?: { fullName?: string; email?: string; userId?: string } | null,
  fallback = 'Без имени',
): string {
  const name = who?.fullName?.trim();
  if (name) return name;
  const email = who?.email?.trim();
  if (email) return email;
  return who?.userId ? `Участник ${who.userId.slice(0, 6)}` : fallback;
}

/**
 * What to call the person reading, on their own turns.
 *
 * A first name, not the full one: the speaker gutter is 76px and has to hold a
 * mark plus a name without pushing the body column, so "Владелец" fits where
 * "Владелец Тимошин" would ellipsis into nothing useful. Falls back to the local
 * part of the email, then to "Вы" — a turn must never be left unlabelled, which
 * is the state this replaces.
 *
 * One definition, for the same reason `agentName` is one: two surfaces render
 * turns (the live stream and loaded history) and they had already drifted apart
 * once.
 */
export function viewerName(
  who?: { fullName?: string; email?: string } | null,
  /** Used when nothing identifies them. The Mirror passes its own: those turns
   *  belong to whoever is driving the session, and calling them "Вы" in a
   *  read-only view of someone else's work names the wrong person. */
  fallback = 'Вы',
): string {
  const first = who?.fullName?.trim().split(/\s+/)[0];
  if (first) return first;
  const local = who?.email?.split('@')[0]?.trim();
  return local || fallback;
}

/**
 * Is this running as an INSTALLED app rather than in a browser tab?
 *
 * Two signals because the platforms disagree: `display-mode: standalone` is the
 * standard one, and `navigator.standalone` is the non-standard property iOS has
 * carried since long before it supported the media query. Either is enough.
 *
 * Used to ask the hub for a session as long as the native client's — an icon on
 * a home screen that signs you out every week is not an app, it is a bookmark.
 */
export function isStandalone(): boolean {
  try {
    // A desktop shell (Windows/macOS) is the same claim by a different route:
    // it launched from an installed app with a cookie jar of its own, not from
    // a browser tab. It cannot match `display-mode: standalone` — it is not a
    // PWA — but every reason the long session exists applies to it, and it was
    // the client most likely to be asked for a password at breakfast.
    if ((window as { __HEGAI_SHELL__?: string }).__HEGAI_SHELL__) return true;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    return (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/**
 * Where «Войти через Google» points. The hop is a top-level navigation on
 * purpose: opened in a new tab or a popup, the session cookie lands in the
 * BROWSER's jar and the installed app comes back still signed out — which reads
 * as a login that loops rather than one that failed. (HegAI login: removed from
 * the product on 6 Oct 2026.)
 */
export function googleStartHref(): string {
  return isStandalone() ? '/api/auth/google/start?pwa=1' : '/api/auth/google/start';
}

/** «3 г. 2 мес.» — how old the GitHub account is; a fresh one is a signal. */
export function accountAge(createdAt: string | undefined, now = Date.now()): string | undefined {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(created)) return undefined;
  const months = Math.max(0, Math.floor((now - created) / (30.44 * 24 * 3600 * 1000)));
  if (months < 1) return 'меньше месяца';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years ? `${years} г.` : '', rest ? `${rest} мес.` : ''].filter(Boolean).join(' ');
}

/** Where «Войти через GitHub» points (`/api/auth/github/start`,
 *  server-rs/src/github_login.rs): same top-level hop rules as Google. A newcomer
 *  arrives here from the landing, fills in a short form, and once an admin
 *  activates them the hub invites their GitHub account to the private repository. */
export function githubStartHref(): string {
  return isStandalone() ? '/api/auth/github/start?pwa=1' : '/api/auth/github/start';
}

/** Where «Войти через <провайдер>» points on a hub with its own OIDC provider
 *  (`/api/auth/oidc/start`, server-rs/src/oidc_login.rs); same hop rules as Google. */
export function oidcStartHref(): string {
  return isStandalone() ? '/api/auth/oidc/start?pwa=1' : '/api/auth/oidc/start';
}

/** What a run in `needs_attention` is actually waiting for.
 *
 * The hub raises that one state for any pending tool request, so the word the
 * UI picks is the only thing telling a question apart from a permission
 * prompt. Printing «ждёт ответа» for a `Write` prompt sent the owner hunting
 * for a question nobody had asked — the label has to say which it is.
 *
 * `pendingKind` is absent on a hub too old to send it; «ждёт решения» is the
 * honest fallback there, since we genuinely do not know which case it is.
 */
export function attentionLabel(run?: Pick<ActiveRunInfo, 'pendingKind'>): string {
  if (run?.pendingKind === 'question') return 'ждёт ответа';
  if (run?.pendingKind === 'permission') return 'ждёт подтверждения';
  return 'ждёт решения';
}

/** Same distinction, capitalised for a chip or a column header. */
export function attentionTitle(run?: Pick<ActiveRunInfo, 'pendingKind'>): string {
  if (run?.pendingKind === 'question') return 'Нужен ответ';
  if (run?.pendingKind === 'permission') return 'Нужно подтверждение';
  return 'Нужно решение';
}

/** Is the open run THIS session on THIS machine? A session id alone can repeat across machines. */
export function runAttachedTo(
  active: { machineId: string; sessionId: string; runId?: string } | null | undefined,
  machineId: string,
  sessionId: string,
): boolean {
  return !!active?.runId && active.sessionId === sessionId && active.machineId === machineId;
}
