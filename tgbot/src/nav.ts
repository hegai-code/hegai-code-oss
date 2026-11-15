/**
 * Screens: pure functions from hub state to (text, keyboard).
 *
 * Two constraints shape everything here. Telegram measures `callback_data` in
 * bytes and silently drops a button over 64, so nothing addresses a machine,
 * project or session by its real id — every list is index-based against the
 * last list rendered into that chat (persisted in `ChatState`, because old
 * buttons stay tappable after a restart). And a phone screen is not a board:
 * lists are paged at `PAGE`, newest first, never scrolled forever.
 */
import {
  HOME_CATEGORY_COUNT,
  SESSION_CATEGORIES,
  categoryRunnable,
  sessionCategory,
  type ActiveRunInfo,
  type MachineSnapshot,
  type SessionSummary,
} from '@cc-remote/shared';
import type { ProjectInfo } from '@cc-remote/shared';

import type { ChatState } from './state.js';
import { ago, escapeHtml, oneLine, projectLabel } from './render.js';
import type { InlineKeyboard } from './telegram.js';

export const PAGE = 8;

export interface Screen {
  text: string;
  keyboard: InlineKeyboard;
}

/** The four states a session can be in, as one glyph. Mirrors the web's marks. */
function stateMark(session: SessionSummary, run: ActiveRunInfo | undefined): string {
  if (run?.state === 'needs_attention') return '🟧';
  if (run?.state === 'error') return '🟥';
  if (run?.state === 'working') return '🟩';
  if (session.livePid) return '🔒';
  return '▫️';
}

export function mainMenu(chat: ChatState, machineName: string | undefined, attention: number): Screen {
  const lines = ['<b>Hegai Code</b>'];
  if (machineName) lines.push(`Машина: <b>${escapeHtml(machineName)}</b>`);
  if (chat.cwd) lines.push(`Проект: <b>${escapeHtml(projectLabel(chat.cwd))}</b>`);
  lines.push('');
  lines.push(
    attention
      ? `Ждут ответа: <b>${attention}</b>`
      : 'Всё спокойно — ничего не ждёт ответа.',
  );
  const keyboard: InlineKeyboard = [
    [{ text: '📁 Проекты', callback_data: 'proj:0' }, { text: '💬 Сессии', callback_data: 'sess:0' }],
    [{ text: '➕ Новая сессия', callback_data: 'new' }],
  ];
  if (attention) keyboard.push([{ text: `⚡️ Ждут ответа (${attention})`, callback_data: 'att' }]);
  keyboard.push([
    { text: '🖥 Машина', callback_data: 'mach' },
    { text: '⚙️ Настройки', callback_data: 'set' },
  ]);
  return { text: lines.join('\n'), keyboard };
}

export function machinesScreen(machines: MachineSnapshot[], current: string | undefined): Screen {
  if (!machines.length) {
    return {
      text: 'Ни одной машины онлайн. Агент не подключён к хабу.',
      keyboard: [[{ text: '‹ Меню', callback_data: 'menu' }]],
    };
  }
  const keyboard: InlineKeyboard = machines.map((m, i) => [
    {
      text: `${m.machine.machineId === current ? '● ' : ''}${m.machine.name} · ${m.sessions.length}`,
      callback_data: `m:${i}`,
    },
  ]);
  keyboard.push([{ text: '‹ Меню', callback_data: 'menu' }]);
  return { text: '<b>Машина</b>\nГде запускать работу.', keyboard };
}

export function projectsScreen(projects: ProjectInfo[], page: number, current: string | undefined): Screen {
  if (!projects.length) {
    return {
      text: 'На этой машине пока нет проектов.',
      keyboard: [
        [{ text: '➕ Создать проект', callback_data: 'pnew' }],
        [{ text: '‹ Меню', callback_data: 'menu' }],
      ],
    };
  }
  const slice = projects.slice(page * PAGE, page * PAGE + PAGE);
  const keyboard: InlineKeyboard = slice.map((p, i) => [
    {
      text: `${p.cwd === current ? '● ' : ''}${p.label} · ${p.count || '—'}`,
      callback_data: `p:${page * PAGE + i}`,
    },
  ]);
  keyboard.push(pager('proj', page, projects.length));
  keyboard.push([
    { text: '➕ Создать проект', callback_data: 'pnew' },
    { text: '‹ Меню', callback_data: 'menu' },
  ]);
  return { text: '<b>Проекты</b>\nВыбери, где работаем.', keyboard };
}

export function sessionsScreen(
  sessions: SessionSummary[],
  runs: Map<string, ActiveRunInfo>,
  page: number,
  cwd: string | undefined,
): Screen {
  const title = cwd ? `<b>${escapeHtml(projectLabel(cwd))}</b>` : '<b>Сессии</b>';
  if (!sessions.length) {
    return {
      text: `${title}\nЗдесь ещё нет сессий.`,
      keyboard: [
        [{ text: '➕ Новая сессия', callback_data: 'new' }],
        [{ text: '‹ Меню', callback_data: 'menu' }],
      ],
    };
  }
  const bySession = new Map<string, ActiveRunInfo>();
  for (const run of runs.values()) bySession.set(run.sessionId, run);

  const slice = sessions.slice(page * PAGE, page * PAGE + PAGE);
  const keyboard: InlineKeyboard = slice.map((s, i) => {
    const cat = sessionCategory(s.category);
    const label = oneLine(s.title || 'без названия', 34);
    return [
      {
        text: `${stateMark(s, bySession.get(s.sessionId))} ${label}${cat ? ` · ${cat.label}` : ''} · ${ago(s.lastModified)}`,
        callback_data: `s:${page * PAGE + i}`,
      },
    ];
  });
  keyboard.push(pager('sess', page, sessions.length));
  keyboard.push([
    { text: '➕ Новая', callback_data: 'new' },
    { text: '‹ Меню', callback_data: 'menu' },
  ]);
  return { text: `${title}\nВыбери сессию — продолжим её.`, keyboard };
}

/**
 * Category chips, filtered by what the machine can actually run.
 * `machine.skills === undefined` means an agent older than the skill bundle:
 * that reads as UNKNOWN, so everything is offered. Reading it as "none" would
 * blank every chip on the whole fleet the day the hub is upgraded.
 */
export function categoriesScreen(machine: MachineSnapshot | undefined, cwd: string, all: boolean): Screen {
  const skills = machine?.machine.skills;
  const runnable = SESSION_CATEGORIES.filter((c) => categoryRunnable(c, skills));
  const shown = all ? runnable : runnable.slice(0, HOME_CATEGORY_COUNT);
  const keyboard: InlineKeyboard = [];
  for (let i = 0; i < shown.length; i += 2) {
    const row = shown.slice(i, i + 2).map((c) => ({
      text: c.label,
      callback_data: `cat:${c.id}`,
    }));
    keyboard.push(row);
  }
  if (!all && runnable.length > shown.length) {
    keyboard.push([{ text: `ещё (${runnable.length - shown.length})`, callback_data: 'catall' }]);
  }
  keyboard.push([{ text: 'Без категории', callback_data: 'cat:-' }]);
  keyboard.push([{ text: '‹ Меню', callback_data: 'menu' }]);
  return {
    text:
      `<b>Новая сессия</b>\n${escapeHtml(projectLabel(cwd))}\n\n` +
      'Выбери, что делаем — категория подставит нужный навык. ' +
      'Или «без категории» и просто напиши задачу.',
    keyboard,
  };
}

/**
 * Suggested first turns, per category. These are SUGGESTIONS, never the
 * default: the compose screen shows a single «Подсказки» button and only
 * expands them when asked, so starting a session stays a blank page for
 * someone who already knows what they want.
 */
const FIRST_PROMPTS: Record<string, string[]> = {
  sync: ['Подтяни свежий код и скажи, что приехало', 'Всё ли закоммичено и запушено?'],
  ship: ['Закоммить всё, запушь и раскатай', 'Раскатай и проверь живой урл'],
  verify: ['Открой продукт в браузере и пройди основной сценарий', 'Проверь вёрстку на главной'],
  bugs: ['Опиши баг: что сделал, что ожидал, что получилось', 'Разберись, почему падает — до корневой причины'],
  mobile: ['Проверь мобильную версию на узком вьюпорте', 'Клавиатура перекрывает поле ввода — почини'],
  feature: ['Опиши фичу, которую делаем. Сначала карта кода и план', 'Собери план, код не пиши, пока не согласуем'],
  codex: ['Отдай последние изменения Codex на ревью', 'Найди техдолг и предложи рефакторинг'],
  backlog: ['Запиши задачу в бэклог с контекстом', 'Покажи бэклог и предложи, что взять'],
  research: ['Разберись в теме и доложи, ничего не меняя', 'Сравни варианты и дай рекомендацию'],
  webpage: ['Собери страницу по описанию ниже', 'Поправь вёрстку существующей страницы'],
  text: ['Напиши текст по заметкам ниже', 'Вычитай текст и убери нейросетевой налёт'],
};

export function composeScreen(cwd: string, category: string | undefined, hints: boolean): Screen {
  const cat = sessionCategory(category);
  const prompts = category ? (FIRST_PROMPTS[category] ?? []) : [];
  const keyboard: InlineKeyboard = [];
  if (hints) {
    prompts.forEach((p, i) => keyboard.push([{ text: `💡 ${oneLine(p, 46)}`, callback_data: `fp:${i}` }]));
  } else if (prompts.length) {
    keyboard.push([{ text: '💡 Подсказки', callback_data: 'hints' }]);
  }
  keyboard.push([{ text: '▶️ Запустить без текста', callback_data: 'go' }]);
  keyboard.push([{ text: '‹ Меню', callback_data: 'menu' }]);
  return {
    text:
      `<b>${escapeHtml(projectLabel(cwd))}</b>${cat ? ` · ${escapeHtml(cat.label)}` : ''}\n\n` +
      'Напиши задачу одним сообщением — текстом, голосом или скриншотом.',
    keyboard,
  };
}

/** The prompt behind a hint button, or undefined for a stale tap. */
export function firstPrompt(category: string | undefined, index: number): string | undefined {
  if (!category) return undefined;
  return FIRST_PROMPTS[category]?.[index];
}

export function attentionScreen(runs: ActiveRunInfo[]): Screen {
  const waiting = runs.filter((r) => r.state === 'needs_attention' || r.state === 'error');
  if (!waiting.length) {
    return {
      text: 'Ничего не ждёт ответа.',
      keyboard: [[{ text: '‹ Меню', callback_data: 'menu' }]],
    };
  }
  const keyboard: InlineKeyboard = waiting.slice(0, 10).map((r) => [
    {
      text: `${r.state === 'error' ? '🟥' : '🟧'} ${oneLine(r.title ?? r.project ?? 'сессия', 40)}`,
      callback_data: `r:${r.runId}`,
    },
  ]);
  keyboard.push([{ text: '‹ Меню', callback_data: 'menu' }]);
  const lines = waiting
    .slice(0, 10)
    .map((r) => `• <b>${escapeHtml(oneLine(r.title ?? 'сессия', 40))}</b> — ${escapeHtml(oneLine(r.preview ?? '', 80))}`);
  return { text: `<b>Ждут ответа</b>\n${lines.join('\n')}`, keyboard };
}

export function settingsScreen(chat: ChatState): Screen {
  const mark = (on: boolean) => (on ? '✅' : '⬜️');
  return {
    text:
      '<b>Настройки</b>\n\n' +
      'По умолчанию бот показывает только речь агента — без вызовов инструментов ' +
      'и служебных строк.',
    keyboard: [
      [{ text: `${mark(chat.settings.verbose)} Показывать инструменты`, callback_data: 'set:v' }],
      [{ text: `${mark(chat.settings.suggest)} Предлагать саджесты`, callback_data: 'set:s' }],
      [{ text: `${mark(chat.settings.notify)} Уведомления`, callback_data: 'set:n' }],
      [{ text: '‹ Меню', callback_data: 'menu' }],
    ],
  };
}

/** The keyboard that rides on the last message of a finished turn. */
export function turnControls(working: boolean, quickReplies: Array<{ label: string }> = []): InlineKeyboard {
  const keyboard: InlineKeyboard = [];
  quickReplies.slice(0, 3).forEach((reply, i) => {
    // The whole text, as it will be sent: the hub keeps it to 60. Clipping it
    // to 40 here was the button-says-one-thing-sends-another bug again.
    keyboard.push([{ text: `💬 ${oneLine(reply.label, 64)}`, callback_data: `qr:${i}` }]);
  });
  keyboard.push(
    working
      ? [{ text: '⏹ Остановить', callback_data: 'stop' }]
      : [
          { text: '📄 История', callback_data: 'hist' },
          { text: '✅ Завершить', callback_data: 'end' },
        ],
  );
  keyboard.push([{ text: '☰ Меню', callback_data: 'menu' }]);
  return keyboard;
}

function pager(prefix: string, page: number, total: number): InlineKeyboard[number] {
  const row: InlineKeyboard[number] = [];
  if (page > 0) row.push({ text: '‹ назад', callback_data: `${prefix}:${page - 1}` });
  if ((page + 1) * PAGE < total) row.push({ text: 'ещё ›', callback_data: `${prefix}:${page + 1}` });
  if (!row.length) row.push({ text: `${total} шт.`, callback_data: 'noop' });
  return row;
}
