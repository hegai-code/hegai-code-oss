import { Briefcase, FileText, FolderPlus, FolderTree, KanbanIcon, MessageSquare } from '../icons.js';
import { SESSIONS, type Route, type SettingsTab, type TeamTab } from '../router.js';

/**
 * The destinations, once. This file replaces the two disjoint nav arrays that
 * used to sit in App.tsx behind `isOrganization` — a fork that made switching
 * workspace swap the entire application. There is one app now; access control
 * is the hub's job, not the navigation's.
 *
 * Fourteen views collapsed to four destinations, and the collapsing was all one
 * argument: a nav item is a permanent claim on attention, and most of what used
 * to hold one was either another reading of the session list or a screen visited
 * about once a month.
 *
 * So: Доска, Таблица and Flow are gone (the side panel lists the same sessions
 * by project, with live marks and drill-in, on EVERY screen now), and Железо,
 * Память and Профиль became tabs of Настройки, which the account avatar at the
 * panel's foot already leads to. Колонки was never a destination either — it is
 * a LAYOUT of the session already open, built by right-clicking a row rather
 * than by visiting an empty screen with a picker on it.
 *
 * Доска came BACK on 26.09.2026 — as a different thing. The one that left was
 * a lens: the same sessions the panel lists, arranged in columns. This one is
 * a destination with its own data: TASKS the hub assembles out of sessions
 * (`GET /api/board`), one card per thing a person wanted done, whether that
 * took three sessions or a third of one. A session is a chat; a card is what
 * a product manager asks about.
 *
 * One array, many readers (the top bar, the menu bar, the phone drawer): none
 * of them may keep a list of its own, or they could disagree about what exists.
 */
export type DestinationId = 'sessions' | 'board' | 'reports' | 'projects' | 'files' | 'team';

/**
 * What the nav can highlight. Настройки is not a destination either — it hangs
 * off the account avatar at the foot, which is where people look for it.
 */
export type RailTarget = DestinationId | 'settings';

export interface Destination {
  id: DestinationId;
  label: string;
  icon: typeof MessageSquare;
  route: Route;
  /**
   * Whether this destination OWNS the session list.
   *
   * Exactly one does, and it is no longer a layout switch: the list is the BODY
   * of the side panel on every screen, so this marks the destination whose nav
   * row would merely point at the panel you are already looking at. That row is
   * not drawn — the brand mark above it is the way back.
   */
  hasContext: boolean;
}

export const DESTINATIONS: Destination[] = [
  {
    id: 'sessions',
    label: 'Сессии',
    icon: MessageSquare,
    route: SESSIONS,
    hasContext: true,
  },
  {
    id: 'board',
    label: 'Доска',
    icon: KanbanIcon,
    route: { kind: 'board' },
    // Answers «что мы сделали и что висит» — the work itself, read as tasks.
    // Unconditional, like every destination; who sees which cards is the hub's
    // ACL, never a flag here.
    hasContext: false,
  },
  {
    id: 'reports',
    label: 'Отчёты',
    icon: FileText,
    route: { kind: 'reports' },
    // Added 04.10.2026: pages a session published (an audit, a review) so they
    // open by link instead of living in one terminal's scrollback. Who sees
    // which report is the hub's (author + platform admins), never a flag here.
    hasContext: false,
  },
  {
    id: 'projects',
    label: 'Проекты',
    icon: FolderPlus,
    route: { kind: 'projects' },
    // Answers "what is on this box", which is a question about the work, not
    // about the hardware — Железо is cores, memory and processes.
    hasContext: false,
  },
  {
    id: 'files',
    label: 'Файлы',
    icon: FolderTree,
    route: { kind: 'files' },
    // Not a sibling of Железо: Железо is the machine AS a machine — cores,
    // memory, processes. Files is where the work lives: the place material is
    // dropped for an agent to pick up, and what a project still is between
    // sessions.
    hasContext: false,
  },
  {
    id: 'team',
    label: 'Команда',
    icon: Briefcase,
    route: { kind: 'team', tab: 'overview' },
    hasContext: false,
  },
];

/** Which nav item lights up for a route. Session-shaped routes are Sessions,
 *  and every tab of Настройки is the account avatar. */
export function destinationOf(route: Route): RailTarget {
  switch (route.kind) {
    case 'sessions':
    case 'new':
    case 'columns':
    case 'project':
    case 'session':
      return 'sessions';
    case 'team':
      return 'team';
    case 'settings':
    case 'start':
      return 'settings';
    default:
      return route.kind;
  }
}

/**
 * The tabs of Настройки: Машины (the fleet and its devices), Приложения
 * (desktop and phone clients), Аккаунт (`overview`: teams, usage, sign-ins,
 * and the former Память / Профиль as sections) and Вид. «Начало» is not a tab
 * any more — it is the first-run screen at `/w/start`.
 */
export const SETTINGS_TABS: { id: SettingsTab; label: string; browser?: boolean }[] = [
  { id: 'hardware', label: 'Машины' },
  { id: 'apps', label: 'Приложения' },
  { id: 'overview', label: 'Аккаунт' },
  { id: 'look', label: 'Вид' },
  // Only for people the hub has a cloud browser for (`GET /api/browser`).
  { id: 'browser', label: 'Браузер', browser: true },
];

/** `adminOnly` is a check on the PERSON (`viewer.platformAdmin`), never a
 *  branch on `workspace.kind` — the same convention the admin form in Settings
 *  follows. «Доступ» is the whole platform's waiting list, which is why it is
 *  the one tab not everyone in a team may see. */
export const TEAM_TABS: { id: TeamTab; label: string; adminOnly?: boolean; usage?: boolean }[] = [
  { id: 'overview', label: 'Обзор' },
  { id: 'people', label: 'Люди' },
  { id: 'projects', label: 'Проекты' },
  // Owner and managers, and only where the hub has a gateway (`canSeeUsageTab`).
  { id: 'usage', label: 'Расходы', usage: true },
  { id: 'audit', label: 'Аудит' },
  { id: 'access', label: 'Доступ', adminOnly: true },
];
