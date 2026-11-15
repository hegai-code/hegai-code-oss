import type { SessionSummary } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { newComposerId, type PaneRoute } from '../router.js';

const TEAM_TAB_LABEL: Record<string, string> = {
  overview: 'Обзор',
  people: 'Люди',
  projects: 'Проекты',
  audit: 'Журнал',
  access: 'Доступ',
};
const SETTINGS_TAB_LABEL: Record<string, string> = {
  overview: 'Аккаунт',
  hardware: 'Машины',
  apps: 'Приложения',
  look: 'Вид',
  browser: 'Браузер',
};

/** What a non-session pane or tab says about itself. */
export function paneLabel(p: PaneRoute, machineName: (id: string) => string | undefined): { title: string; sub?: string } {
  switch (p.kind) {
    case 'files':
      return { title: 'Файлы', sub: p.machineId ? machineName(p.machineId) ?? p.machineId : undefined };
    case 'projects':
      return { title: 'Проекты', sub: p.machineId ? machineName(p.machineId) ?? p.machineId : undefined };
    case 'team':
      return { title: 'Команда', sub: TEAM_TAB_LABEL[p.tab] };
    case 'settings':
      return { title: 'Настройки', sub: SETTINGS_TAB_LABEL[p.tab] };
    case 'project':
      return { title: 'Проект', sub: p.project };
    case 'board':
      return { title: 'Доска' };
    case 'reports':
      return { title: 'Отчёты' };
    case 'start':
      return { title: 'Начало' };
    default:
      return { title: 'Новый чат' };
  }
}

export type TabInfo = {
  title: string;
  /** Machine · project, for the tooltip. */
  hint?: string;
  source?: SessionSummary['source'];
  provider?: SessionSummary['provider'];
  working: boolean;
  attention: boolean;
};

/** A tab's face: the session's title and state, or the screen it shows. */
export function makeTabInfo(
  central: Pick<CentralState, 'machines' | 'runFor'>,
  resolveSession: (machineId: string, sessionId: string) => SessionSummary | undefined,
): (p: PaneRoute) => TabInfo {
  const machineName = (id: string) => central.machines.find((m) => m.machine.machineId === id)?.machine.name;
  return (p) => {
    if (p.kind === 'session' && p.sessionId) {
      const s = resolveSession(p.machineId, p.sessionId);
      const state = central.runFor(p.machineId, p.sessionId)?.state;
      return {
        title: s?.title || p.sessionId.slice(0, 8),
        hint: [machineName(p.machineId) ?? p.machineId, s?.project].filter(Boolean).join(' · '),
        source: s?.source,
        provider: s?.provider,
        working: state === 'working',
        attention: state === 'needs_attention' || state === 'error',
      };
    }
    const shown: PaneRoute = p.kind === 'session' ? { kind: 'new' } : p;
    const l = paneLabel(shown, machineName);
    return { title: l.sub ? `${l.title} · ${l.sub}` : l.title, working: false, attention: false };
  };
}

/**
 * What the strip's «+» opens: a new chat aimed at the same project as the tab
 * it stands beside — the machine and folder of that session, of a composer
 * already aimed somewhere, or of the folder a Файлы/Проекты tab is in. Anything
 * else gets the plain composer, which asks.
 */
export function makeNewTabRoute(
  resolveSession: (machineId: string, sessionId: string) => SessionSummary | undefined,
  id: () => string = newComposerId,
): (beside: PaneRoute | undefined) => PaneRoute {
  // Each press is ONE MORE composer (`n`), not the composer moved here.
  return (p) => {
    const n = id();
    if (p?.kind === 'session' && p.sessionId) {
      const cwd = resolveSession(p.machineId, p.sessionId)?.cwd;
      if (cwd) return { kind: 'new', machineId: p.machineId, cwd, n };
    }
    if (p?.kind === 'new' && p.machineId && p.cwd) return { kind: 'new', machineId: p.machineId, cwd: p.cwd, n };
    if (p?.kind === 'projects' && p.machineId && p.cwd) return { kind: 'new', machineId: p.machineId, cwd: p.cwd, n };
    return { kind: 'new', n };
  };
}
