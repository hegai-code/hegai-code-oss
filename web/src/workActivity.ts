import { PLAN_TOOL } from '@cc-remote/shared';
/**
 * What the agent is doing right now, in two or three words — «Думаю»,
 * «Читаю файл», «Ищу в коде», «Читаю сайт · github.com».
 *
 * Replaced «работает… 8:25 · 5250k токенов» on 08.10.2026 at the owner's
 * request: the token count told nobody anything, and «работает» said only what
 * the pulsing mark already said. ChatGPT shows one grey word for the same slot
 * («Думаю»); this is that, read off the last thing the turn did.
 *
 * Input is the live tail as both clients keep it: `tool_use` lines whose text
 * is `Name {json}` (Claude) or `$ cmd` / `edit paths` / `web_search: q` /
 * `mcp: tool` (Codex), and `assistant` lines that are `streaming` while words
 * arrive. Anything else — a status line, a tool's result, nothing yet — means
 * the model is between steps, which is «Думаю».
 *
 * PORTED VERBATIM to `ios/CCRemoteKit/Sources/CCRemoteKit/Protocol/WorkActivity.swift`.
 * Change both, and the two test tables (`web/test/work-activity.test.ts`,
 * `ios/CCRemoteTests/WorkActivityTests.swift`), together.
 */

export interface ActivityLine {
  kind: string;
  text: string;
  streaming?: boolean;
  code?: string;
}

/** Statuses that END a step: the tool returned (Codex `command_output`, a
 *  `tool_error`) or the model was asked again (Claude `requesting`). After one
 *  the turn is between steps, not still «Собираю». */
const STEP_ENDED = new Set(['command_output', 'tool_error', 'requesting', 'compact_done', 'compact_failed']);

export const THINKING = 'Думаю';

/** The label for the CURRENT turn: only lines after the last human turn count. */
export function workActivity(lines: readonly ActivityLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind === 'user') return THINKING;
    if (l.kind === 'assistant') return l.streaming ? 'Пишу ответ' : THINKING;
    if (l.kind === 'tool_use') return toolActivity(l.text);
    // status / system: a notice in the middle of a step (stderr, a retry) is
    // skipped; one that ends the step means the model is thinking again.
    if (l.kind === 'status' || l.kind === 'system') {
      if (l.code === 'compact_started') return 'Сжимаю контекст';
      if (l.code && STEP_ENDED.has(l.code)) return THINKING;
      continue;
    }
    return THINKING;
  }
  return THINKING;
}

/** One `tool_use` line → a verb. Unknown tools say «Работаю», never a guess. */
export function toolActivity(text: string): string {
  const t = text.trim();
  // Codex shapes first: they are prefixes, not tool names.
  if (t.startsWith('$ ')) return commandActivity(t.slice(2));
  if (t.startsWith('edit ')) return 'Пишу код';
  if (t.startsWith('web_search:')) return 'Ищу в интернете';
  if (t.startsWith('mcp:')) return serviceActivity(t.slice(4).trim());

  const space = t.indexOf(' ');
  const name = space < 0 ? t : t.slice(0, space);
  const input = space < 0 ? '' : t.slice(space + 1);
  switch (name) {
    case 'Bash':
      return commandActivity(field(input, 'command'));
    case 'Read':
      return 'Читаю файл';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'Ищу в коде';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'Пишу код';
    case 'WebFetch': {
      const host = hostOf(field(input, 'url'));
      return host ? `Читаю сайт · ${host}` : 'Читаю сайт';
    }
    case 'WebSearch':
      return 'Ищу в интернете';
    case 'Agent':
    case 'Task':
      return 'Работает помощник';
    case 'TodoWrite':
    case PLAN_TOOL:
      return 'Составляю план';
    case 'ExitPlanMode':
      return 'Готовлю план';
    case 'AskUserQuestion':
      return 'Жду ответа';
    case 'Skill':
      return 'Открываю инструкцию';
    case 'ToolSearch':
      return 'Подбираю инструменты';
    case 'Monitor':
    case 'BashOutput':
    case 'TaskOutput':
      return 'Слежу за процессом';
    case 'Workflow':
      return 'Запускаю сценарий';
  }
  if (name.startsWith('mcp__')) return serviceActivity(name);
  return 'Работаю';
}

/** A shell command, by what it most visibly does. First match wins. */
export function commandActivity(cmd: string): string {
  const c = cmd.trim();
  if (!c) return 'Запускаю команду';
  const rules: Array<[RegExp, string]> = [
    [/\b(hegai-stt)\b/, 'Расшифровываю запись'],
    [/\b(hegai-browser)\b/, 'Смотрю в браузере'],
    [/\b(hegai-phone)\b/, 'Смотрю в телефоне'],
    [/\b(hegai-image)\b/, 'Рисую картинку'],
    [/\b(curl|wget)\b/, 'Смотрю сайт'],
    [/\b(scp|rsync)\b/, 'Копирую файлы'],
    [/(?<!["'=])\bssh\b|\bterm\.sh\b/, 'Работаю на другой машине'],
    [/\b(vitest|jest|pytest|cargo test|go test|xcodebuild test|npm (run )?test|node --test|swift test)\b|check-protocol/, 'Прогоняю тесты'],
    [/\b(git (push|commit|merge|rebase|pull|fetch|clone))\b/, 'Работаю с git'],
    [/\b(deploy|systemctl (restart|reload)|pm2 (restart|reload))\b/, 'Выкатываю'],
    [/\b(npm (run )?build|tsc|cargo build|xcodebuild|vite build|make)\b/, 'Собираю'],
    [/\b(npm (i|install|ci)|pip3? install|apt(-get)? install|brew install)\b/, 'Ставлю пакеты'],
    [/\b(psql|sqlite3|mysql)\b/, 'Смотрю базу'],
    [/\b(ffmpeg|ffprobe)\b/, 'Обрабатываю видео'],
    [/^(rg|grep|find|fd)\b|\|\s*(rg|grep)\b/, 'Ищу в коде'],
    [/^(cat|head|tail|sed -n|less|wc|ls|tree|jq)\b/, 'Читаю файлы'],
    [/^git\b/, 'Смотрю git'],
  ];
  for (const [re, label] of rules) if (re.test(c)) return label;
  return 'Запускаю команду';
}

/** `mcp__claude_ai_Google_Drive__search_files` → «Смотрю Google Drive». */
export function serviceActivity(tool: string): string {
  const parts = tool.split('__').filter(Boolean);
  // mcp__<server>__<tool>; the server may carry a `claude_ai_` prefix.
  const server = (parts[0] === 'mcp' ? parts[1] : parts[0]) ?? '';
  const name = server.replace(/^claude_ai_/, '').replace(/_/g, ' ').trim();
  return name ? `Смотрю ${name}` : 'Работаю с сервисом';
}

function field(json: string, key: string): string {
  try {
    const v = (JSON.parse(json) as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  } catch {
    // A long input may arrive cut off; the leading field still reads.
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    return m ? m[1]! : '';
  }
}

export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return m ? m[1]!.replace(/^www\./, '') : '';
}
