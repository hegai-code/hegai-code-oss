import { z } from 'zod';

/**
 * Session categories chosen at creation time. Each category maps to a Claude
 * Code skill (a slash command available on the agent machine at
 * `~/.claude/skills/<skill>/SKILL.md`): when a session is started with a
 * category, the hub prefixes the first user turn with `/<skill> <text>` so the
 * session opens already in that workflow. The category is persisted with the
 * session's owner and shown as a chip in every session list.
 *
 * This is the single source of truth for the id↔skill↔label mapping; the hub
 * mirrors just the id→skill pairs in Rust (`CATEGORY_SKILLS`).
 */
export const SessionCategory = z.enum([
  'rambling',
  'sync',
  'ship',
  'verify',
  'bugs',
  'mobile',
  'feature',
  'codex',
  'backlog',
  'research',
  'webpage',
  'text',
  'tz',
]);
export type SessionCategory = z.infer<typeof SessionCategory>;

export interface SessionCategoryInfo {
  id: SessionCategory;
  /** Human label (Russian — matches the product UI). */
  label: string;
  /** Skill slash-command name on the agent machine. */
  skill: string;
  /** CSS custom-property name for the chip accent (defined in styles.css). */
  token: string;
}

/**
 * The pickable list — what the start screens actually offer.
 *
 * It was eleven chips, ordered by frequency across ~240 real prompts, and the
 * frequency turned out to be zero: the owner of this fleet does not start
 * sessions by naming the kind of work, he starts them by describing the work.
 * A row of eleven labels above the composer was a taxonomy nobody was asking
 * for, sitting between the project and the text. They are in LEGACY_CATEGORIES
 * below, so the sessions that carry them keep their chip and their name.
 *
 * What is left is the one entry that is not a label for something you could
 * have typed: `rambling` changes HOW the session starts, not what it is called.
 *
 * A client still filters this by `machine.skills` — a chip whose skill is
 * absent starts a session with an unhandled `/skill` prefix and looks like it
 * worked. `rambling` rides inside the agent bundle
 * (`agent/src/skills-sync.ts`), so it exists wherever the agent has been
 * restarted since it shipped, and nowhere else.
 */
export const SESSION_CATEGORIES: ReadonlyArray<SessionCategoryInfo> = [
  { id: 'rambling', label: 'Рамблинг', skill: 'rambling', token: 'cat-rambling' },
];

/**
 * Retired from the chip row, still spoken everywhere a session is displayed.
 *
 * Removing these outright would have been cheaper by one list and wrong: the
 * category is persisted per session (`session_owners.category`), so hundreds of
 * existing sessions carry `bugs` or `feature`, and dropping the metadata turns
 * their chip into nothing — history that used to say what a session was for,
 * silently losing the answer. Since 24.09.2026 their SKILLS no longer ride in
 * the fleet bundle: `bugs`, `feature`, `raskatai` and the rest are this repo's
 * own dev-process skills (`.claude/skills/`), not a product feature on every
 * machine. A legacy id therefore resolves to a label and a chip, and to a
 * skill only where that skill happens to be installed.
 */
export const LEGACY_CATEGORIES: ReadonlyArray<SessionCategoryInfo> = [
  { id: 'sync', label: 'Синхронизация', skill: 'sync', token: 'cat-sync' },
  { id: 'ship', label: 'Раскатать', skill: 'raskatai', token: 'cat-ship' },
  { id: 'verify', label: 'Проверить', skill: 'verify', token: 'cat-verify' },
  { id: 'bugs', label: 'Баги', skill: 'bugs', token: 'cat-bugs' },
  { id: 'mobile', label: 'Мобайл', skill: 'mobile', token: 'cat-mobile' },
  { id: 'feature', label: 'Большие фичи', skill: 'feature', token: 'cat-feature' },
  { id: 'codex', label: "Ревью Codex'ом", skill: 'codex-review', token: 'cat-codex' },
  { id: 'backlog', label: 'Бэклог', skill: 'backlog', token: 'cat-backlog' },
  { id: 'research', label: 'Исследования', skill: 'research', token: 'cat-research' },
  { id: 'webpage', label: 'Веб-страница', skill: 'webpage', token: 'cat-webpage' },
  { id: 'text', label: 'Тексты', skill: 'text', token: 'cat-text' },
];

/**
 * How many chips the Home screen offers before "ещё" — the head of the list
 * above. Home is a status board, not a launcher, so it shows the shortlist and
 * leaves the full row to the start screen.
 */
export const HOME_CATEGORY_COUNT = 4;

/**
 * Is this category runnable on that machine?
 *
 * `skills` is `undefined` on an agent older than the skill bundle. That MUST
 * read as "unknown", never as "none" — treating it as none would blank every
 * chip on every machine in the fleet the day the hub is upgraded, before a
 * single agent has restarted.
 */
export function categoryRunnable(
  info: SessionCategoryInfo,
  skills: readonly string[] | undefined,
): boolean {
  return !skills || skills.includes(info.skill);
}

/**
 * Categories a session can carry but nobody picks by hand.
 *
 * `tz` is a backend change specced from a sandbox that may not make it: the
 * intake (`POST /api/backend-requests`) opens the session on the backend machine
 * in plan mode for the owner to approve. Choosing it from the start screen would
 * mean filing a spec with yourself, so it is kept out of `SESSION_CATEGORIES` —
 * the pickable list — while still resolving to a label and chip everywhere a
 * session is displayed.
 */
export const INTAKE_CATEGORIES: ReadonlyArray<SessionCategoryInfo> = [
  { id: 'tz', label: 'ТЗ на бэкенд', skill: 'backend-tz', token: 'cat-tz' },
];

const BY_ID = new Map(
  [...SESSION_CATEGORIES, ...LEGACY_CATEGORIES, ...INTAKE_CATEGORIES].map((c) => [c.id, c]),
);

/** Category metadata by id, or undefined for an unknown/legacy value. */
export function sessionCategory(id: string | undefined | null): SessionCategoryInfo | undefined {
  return id ? BY_ID.get(id as SessionCategory) : undefined;
}
